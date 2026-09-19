// Service worker: talks to TypeSafe Jev, caches dimension results, and keeps
// enough counters to measure the scoring pipeline.
importScripts("i18n.js", "defaults.js");

const API_URL = "https://api.typesafe.ai/v1/systemone";
const CACHE_KEY = "xqf_cache";
const SEMANTIC_CACHE_KEY = "xqf_semantic_cache";
const STATS_KEY = "xqf_stats";
const CACHE_SCHEMA = 9;
const CACHE_MAX = 4000;
const SEMANTIC_CACHE_MAX = 2000;
const CONCURRENCY = 6;
const DIMENSIONS = ["category", "tech", "ai_written"];
const STATS_DEFAULTS = {
  analyzed: 0,
  hidden: 0,
  tokens: 0,
  cost: 0,
  errors: 0,
  requests: 0,
  analyzedPosts: 0,
  cacheHits: 0,
  semanticCacheHits: 0,
  inflightDedupe: 0,
  localResolved: 0,
  skipped: 0
};

let settings = null;
let cache = null; // Map post id -> { schema, dimensions: { category, tech, ai_written } }
let semanticCache = null; // normalized semantic fingerprint -> same entry shape
let stats = null;
let saveTimer = null;
let analyzedPostKeys = new Set();

function freshStats() { return { ...STATS_DEFAULTS }; }
function migrateStats(raw) {
  const previous = raw && typeof raw === "object" ? raw : {};
  const next = { ...freshStats(), ...previous };
  // Version 0.8 persisted `analyzed` and `tokens` but had no request counter.
  // Treat those historical Jev completions as requests/posts instead of
  // reporting a misleading zero denominator after the upgrade.
  if (previous.requests == null) next.requests = Number(previous.analyzed) || 0;
  if (previous.analyzedPosts == null) next.analyzedPosts = Number(previous.analyzed) || 0;
  return next;
}

async function loadState() {
  if (settings && cache && semanticCache && stats) return;
  const s = await chrome.storage.sync.get(XQF_DEFAULTS);
  settings = { ...XQF_DEFAULTS, ...s, hide: { ...XQF_DEFAULTS.hide, ...(s.hide || {}) } };
  const resolvedModel = XQF_resolveModel(settings.model);
  if (settings.model !== resolvedModel) {
    settings.model = resolvedModel;
    try { await chrome.storage.sync.set({ model: resolvedModel }); } catch { /* keep the in-memory pin */ }
  }

  const l0 = await chrome.storage.local.get(["xqf_schema"]);
  if (l0.xqf_schema !== CACHE_SCHEMA) {
    // Old entries were keyed only by post id and cannot be trusted after the
    // evaluator became dimension/version aware. Drop them once on migration.
    await chrome.storage.local.set({ [CACHE_KEY]: {}, [SEMANTIC_CACHE_KEY]: {}, xqf_schema: CACHE_SCHEMA });
    const old = (await chrome.storage.sync.get(["hide"])).hide || {};
    if ("bait" in old || "insight" in old) {
      const migrated = { ...XQF_DEFAULTS.hide, promo: !!old.promo, humor: !!old.humor, chitchat: !!old.personal, substance: !!(old.insight && old.news && old.discussion) };
      await chrome.storage.sync.set({ hide: migrated });
      settings.hide = migrated;
    }
  }
  const l = await chrome.storage.local.get([CACHE_KEY, SEMANTIC_CACHE_KEY, STATS_KEY]);
  cache = new Map(Object.entries(l[CACHE_KEY] || {}));
  semanticCache = new Map(Object.entries(l[SEMANTIC_CACHE_KEY] || {}));
  const previousStats = l[STATS_KEY] || {};
  stats = migrateStats(previousStats);
  analyzedPostKeys = new Set();
  if (previousStats.requests == null || previousStats.analyzedPosts == null) scheduleSave();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !settings) return;
  for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
  if (changes.hide) settings.hide = { ...XQF_DEFAULTS.hide, ...(changes.hide.newValue || {}) };
});

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    while (semanticCache.size > SEMANTIC_CACHE_MAX) semanticCache.delete(semanticCache.keys().next().value);
    await chrome.storage.local.set({
      [CACHE_KEY]: Object.fromEntries(cache),
      [SEMANTIC_CACHE_KEY]: Object.fromEntries(semanticCache),
      [STATS_KEY]: stats
    });
  }, 1500);
}

// Keep the raw fingerprint export for diagnostics, but use the shared state
// helper below for every cache key so content/background identity cannot drift.
function fingerprint(value) { return XQF_fingerprint(value); }

function modelName(model) { return XQF_resolveModel(model); }
function evaluatorVersion(dimension, model) {
  return `${modelName(model)}|${XQF_DIMENSION_VERSIONS[dimension] || XQF_PROMPT_VERSION}|${XQF_STATE_SCHEMA_VERSION}`;
}
function semanticKey(model, state) {
  return `${modelName(model)}|${XQF_PROMPT_VERSION}|${XQF_STATE_SCHEMA_VERSION}|${XQF_stateFingerprint(state)}`;
}
function stateFingerprint(state) { return XQF_stateFingerprint(state); }
function validDimensions(dimensions) {
  return [...new Set((dimensions || []).filter((d) => DIMENSIONS.includes(d)))];
}

function dimensionPatch(verdict, dimension) {
  if (dimension === "category" && typeof verdict?.category === "string") {
    return { category: verdict.category, confidence: verdict.confidence ?? 0, probs: verdict.probs || {} };
  }
  if (dimension === "tech" && typeof verdict?.tech === "number") return { tech: verdict.tech };
  if (dimension === "ai_written" && typeof verdict?.ai === "number") return { ai: verdict.ai };
  return null;
}

function mergeEntry(entry, verdict, dimensions, model, stateKey) {
  const out = entry && entry.schema === CACHE_SCHEMA
    ? { schema: CACHE_SCHEMA, dimensions: { ...(entry.dimensions || {}) }, t: entry.t || 0 }
    : { schema: CACHE_SCHEMA, dimensions: {}, t: 0 };
  for (const dimension of validDimensions(dimensions)) {
    const value = dimensionPatch(verdict, dimension);
    if (value) out.dimensions[dimension] = { version: evaluatorVersion(dimension, model), state: stateKey, value };
  }
  out.t = Date.now();
  return out;
}

function verdictFromEntry(entry, dimensions, model, stateKey) {
  if (!entry || entry.schema !== CACHE_SCHEMA) return null;
  let out = { model: modelName(model), evaluator: XQF_evaluatorIdentity(model), t: entry.t || Date.now() };
  let found = false;
  for (const dimension of validDimensions(dimensions)) {
    const record = entry.dimensions?.[dimension];
    if (!record || record.version !== evaluatorVersion(dimension, model) || record.state !== stateKey) continue;
    found = true;
    out = XQF_mergeVerdicts(out, record.value);
  }
  return found ? out : null;
}

function missingDimensions(entry, dimensions, model, stateKey) {
  return validDimensions(dimensions).filter((dimension) => {
    const record = entry?.dimensions?.[dimension];
    return !record || record.version !== evaluatorVersion(dimension, model) || record.state !== stateKey;
  });
}

// ---- Jev call ----------------------------------------------------------
async function askJev(state, apiKey, model, dimensions = DIMENSIONS) {
  const body = JSON.stringify({
    state: XQF_normalizeStateForJev(state),
    model: modelName(model),
    questions: XQF_questionsForDimensions(validDimensions(dimensions))
  });
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body
    });
    if (res.ok) return res.json();
    const text = await res.text().catch(() => "");
    lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    if (res.status === 401 || res.status === 403 || res.status === 422) throw lastErr;
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get("retry-after")) || 0.5 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, ra * 1000));
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

// Turn only the requested Jev answers into a compact dimension patch.
function toVerdict(resp, dimensions = DIMENSIONS) {
  const wanted = validDimensions(dimensions);
  const a = resp?.answers || {};
  const out = { model: resp?.model, evaluator: XQF_evaluatorIdentity(resp?.model), t: Date.now() };
  if (wanted.includes("category")) {
    const c = a.category || {};
    out.category = c.choice || "personal";
    out.confidence = c.confidence ?? 0;
    out.probs = c.probabilities || {};
  }
  if (wanted.includes("tech")) out.tech = a.tech?.noul ?? 1;
  if (wanted.includes("ai_written")) out.ai = a.ai_written?.noul ?? 0;
  return out;
}

// ---- Queue with concurrency and background-wide in-flight dedupe --------
const queue = [];
const inflight = new Map();
let running = 0;

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const job = queue.shift();
    running++;
    (async () => {
      try {
        const resp = await askJev(job.state, settings.apiKey, job.model, job.dimensions);
        const tok = Number(resp?.usage?.input_tokens) || 0;
        stats.analyzed++;
        stats.requests++;
        stats.tokens += tok;
        stats.cost += (tok / 1e6) * 0.042;
        scheduleSave();
        job.resolve({ resp });
      } catch (e) {
        stats.errors++;
        scheduleSave();
        job.resolve({ error: String(e.message || e) });
      } finally {
        running--;
        pump();
      }
    })();
  }
}

function requestEvaluation(key, state, dimensions) {
  const previous = inflight.get(key);
  if (previous) {
    stats.inflightDedupe++;
    scheduleSave();
    return previous;
  }
  const promise = new Promise((resolve) => {
    queue.push({ key, state, dimensions, model: modelName(settings.model), resolve });
    pump();
  });
  inflight.set(key, promise);
  promise.then(() => {
    if (inflight.get(key) === promise) inflight.delete(key);
  }, () => {
    if (inflight.get(key) === promise) inflight.delete(key);
  });
  return promise;
}

function touch(map, key, value) {
  map.delete(key);
  map.set(key, value);
}

async function score(id, state, dimensions) {
  const postId = String(id);
  const normalized = XQF_normalizeStateForJev(state);
  const stateKey = XQF_stateFingerprint(normalized);
  const dims = validDimensions(dimensions?.length ? dimensions : XQF_dimensionsForSettings(settings, { isReply: !!(normalized.is_reply || normalized.in_reply_to) }));
  if (!dims.length) {
    stats.skipped++;
    scheduleSave();
    return { id, stateKey, dimensions: dims, skipped: true };
  }

  const model = modelName(settings.model);
  const key = semanticKey(model, normalized);
  let entry = cache.get(postId);
  let missing = missingDimensions(entry, dims, model, stateKey);
  let verdict = verdictFromEntry(entry, dims, model, stateKey);
  if (!missing.length) {
    touch(cache, postId, entry);
    stats.cacheHits++;
    scheduleSave();
    return { id, stateKey, dimensions: dims, verdict, cached: true };
  }

  // Reuse valid dimensions from a duplicate/copy-pasted state before asking
  // Jev. The post-id cache above remains the fastest path.
  const semanticEntry = semanticCache.get(key);
  if (semanticEntry) {
    const semanticVerdict = verdictFromEntry(semanticEntry, dims, model, stateKey);
    if (semanticVerdict) {
      entry = mergeEntry(entry, semanticVerdict, dims, model, stateKey);
      cache.set(postId, entry);
      missing = missingDimensions(entry, dims, model, stateKey);
      verdict = verdictFromEntry(entry, dims, model, stateKey);
      stats.semanticCacheHits++;
      touch(semanticCache, key, semanticEntry);
      scheduleSave();
      if (!missing.length) return { id, stateKey, dimensions: dims, verdict, cached: true, semanticCached: true };
    }
  }

  const evaluationKey = `${key}|${missing.slice().sort().map((d) => evaluatorVersion(d, model)).join(",")}`;
  const result = await requestEvaluation(evaluationKey, normalized, missing);
  if (result.error) return { id, stateKey, dimensions: dims, error: result.error };
  const patch = toVerdict(result.resp, missing);
  const analyzedKey = `${postId}|${model}|${stateKey}`;
  if (!analyzedPostKeys.has(analyzedKey)) {
    analyzedPostKeys.add(analyzedKey);
    stats.analyzedPosts++;
  }
  // Another dimension request for the same post may have completed while this
  // request was in flight; merge against the latest entry to avoid clobbering
  // an unrelated valid dimension.
  entry = mergeEntry(cache.get(postId), patch, missing, model, stateKey);
  cache.set(postId, entry);
  const currentSemantic = semanticCache.get(key);
  semanticCache.set(key, mergeEntry(currentSemantic, patch, missing, model, stateKey));
  scheduleSave();
  verdict = verdictFromEntry(entry, dims, model, stateKey);
  return { id, stateKey, dimensions: dims, verdict, cached: false };
}

function statsSnapshot() {
  return {
    ...stats,
    inputTokens: stats.tokens,
    tokensPerAnalyzedPost: stats.analyzedPosts ? stats.tokens / stats.analyzedPosts : 0,
    tokensPerJevRequest: stats.requests ? stats.tokens / stats.requests : 0,
    // Keep the old field as an alias for consumers that already read it.
    tokensPerRequest: stats.requests ? stats.tokens / stats.requests : 0
  };
}

// ---- Onboarding: first install opens the setup page --------------------
chrome.runtime.onInstalled.addListener(async (d) => {
  try {
    const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
    for (const t of tabs) {
      try {
        await chrome.scripting.insertCSS({ target: { tabId: t.id }, files: ["content.css"] });
        await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["i18n.js", "defaults.js", "content.js"] });
      } catch { /* tab not scriptable */ }
    }
  } catch { /* ignore */ }
  if (d.reason !== "install") return;
  const s = await chrome.storage.sync.get(["apiKey"]);
  if (!s.apiKey) chrome.runtime.openOptionsPage();
});

async function addToList(key, handle) {
  const s = await chrome.storage.sync.get([key]);
  const lines = (s[key] || "").split("\n").map((x) => x.trim()).filter(Boolean);
  const h = handle.replace(/^@/, "").toLowerCase();
  if (!lines.some((x) => x.replace(/^@/, "").toLowerCase() === h)) lines.push(h);
  const other = key === "allowlist" ? "blocklist" : "allowlist";
  const o = await chrome.storage.sync.get([other]);
  const otherLines = (o[other] || "").split("\n").map((x) => x.trim()).filter((x) => x && x.replace(/^@/, "").toLowerCase() !== h);
  await chrome.storage.sync.set({ [key]: lines.join("\n"), [other]: otherLines.join("\n") });
}

// ---- Messages -----------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    await loadState();
    switch (msg.type) {
      case "openOptions":
        chrome.runtime.openOptionsPage();
        sendResponse({ ok: true });
        break;
      case "allow":
        await addToList("allowlist", msg.handle);
        sendResponse({ ok: true });
        break;
      case "block":
        await addToList("blocklist", msg.handle);
        sendResponse({ ok: true });
        break;
      case "settings":
        sendResponse({ settings, stats: statsSnapshot() });
        break;
      case "score": {
        if (!settings.apiKey) { sendResponse({ error: "no_api_key" }); break; }
        const results = await Promise.all((msg.items || []).map((it) => score(
          it.id,
          it.state,
          it.dimensions || XQF_dimensionsForSettings(settings, { isReply: !!(it.state?.is_reply || it.state?.in_reply_to) })
        )));
        sendResponse({ results });
        break;
      }
      case "pipeline":
        if (msg.kind === "local") stats.localResolved++;
        else if (msg.kind === "skipped") stats.skipped++;
        scheduleSave();
        sendResponse({ ok: true });
        break;
      case "hidden":
        stats.hidden += msg.count || 1;
        scheduleSave();
        sendResponse({ ok: true });
        break;
      case "stats":
        sendResponse({ stats: statsSnapshot() });
        break;
      case "resetStats":
        stats = freshStats();
        analyzedPostKeys.clear();
        scheduleSave();
        sendResponse({ ok: true });
        break;
      case "clearCache":
        cache.clear();
        semanticCache.clear();
        scheduleSave();
        sendResponse({ ok: true });
        break;
      case "test": {
        try {
          const r = await askJev(
            { author: "test", text: "Bookmark this. Most people will never understand this simple system 🧵👇" },
            msg.apiKey || settings.apiKey,
            msg.model || settings.model,
            DIMENSIONS
          );
          sendResponse({ ok: true, verdict: toVerdict(r, DIMENSIONS), model: r.model });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
        break;
      }
      default:
        sendResponse({ error: "unknown" });
    }
  })();
  return true;
});

if (typeof globalThis !== "undefined") {
  Object.assign(globalThis, { askJev, toVerdict, score, fingerprint, stateFingerprint, evaluatorVersion, semanticKey, migrateStats, statsSnapshot });
}
