// Sift content script for x.com: extract posts, pre-filter with stop phrases, score with Jev, hide/dim/badge.
(() => {
  if (window.__siftLoaded) return; window.__siftLoaded = true;
  const ATTR = "data-sift";
  const tx = (key, fallback, substitutions) => XQF_t(key, substitutions, fallback);
  const CAT = Object.fromEntries(Object.entries(XQF_CATEGORIES).map(([k, c]) => [k, [c.icon, c.label]]));
  const uiOf = (fine) => XQF_FINE_TO_UI[fine] || "chitchat";
  const fineLabel = (fine) => XQF_FINE_LABEL[fine] || fine;
  const AI_AT = 0.7; // P(ai_written) at which a post counts as AI-written
  const AI_SHOW = 0.4; // show the AI % on the tag only from here up — below that it is noise
  const techAt = () => Number(settings?.techThreshold) || 0.5;
  const pageCounts = {}; // category -> hidden count on this page

  let settings = null;
  let evaluatorId = "";
  let stopRegexes = [];
  let allow = new Set();
  let block = new Set();
  const verdicts = new Map(); // post id + normalized state fingerprint -> verdict
  const pending = new Map(); // post id + state fingerprint + dimensions -> Promise
  let batch = [];
  let batchTimer = null;
  let pageHidden = 0;

  // ---------- settings ----------
  function compileSettings(s) {
    s = { ...s, model: XQF_resolveModel(s.model) };
    const nextEvaluator = XQF_evaluatorIdentity(s.model);
    if (evaluatorId && evaluatorId !== nextEvaluator) verdicts.clear();
    evaluatorId = nextEvaluator;
    settings = s;
    stopRegexes = [];
    for (const line of (s.stopPhrases || "").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      try { stopRegexes.push(new RegExp(t, "i")); } catch { /* skip bad regex */ }
    }
    const toSet = (txt) => new Set((txt || "").split("\n").map((x) => x.trim().replace(/^@/, "").toLowerCase()).filter(Boolean));
    allow = toSet(s.allowlist);
    block = toSet(s.blocklist);
  }

  function active() {
    return !torn && settings?.enabled && !(settings.pausedUntil && settings.pausedUntil > Date.now());
  }

  async function loadSettings() {
    let s;
    try { s = await chrome.storage.sync.get(XQF_DEFAULTS); } catch { teardown(); return; }
    s.hide = { ...XQF_DEFAULTS.hide, ...(s.hide || {}) };
    compileSettings(s);
  }

  // ---------- orphan detection (extension reloaded while this page stayed open) ----------
  let torn = false, obs = null, tick = null;
  function alive() { try { return !!chrome.runtime?.id; } catch { return false; } }
  // every runtime call goes through here: never throws, never leaves an unhandled rejection
  async function send(msg) {
    if (!alive()) { teardown(); return null; }
    try { return await chrome.runtime.sendMessage(msg); }
    catch (e) { if (/context invalidated|Extension context|message port closed/i.test(String(e))) teardown(); return null; }
  }
  function teardown() {
    if (torn) return; torn = true;
    obs?.disconnect(); if (tick) clearInterval(tick);
    document.documentElement.removeAttribute("data-sift-sidebar");
    document.querySelectorAll(`article[${ATTR}]`).forEach((a) => { resetArticle(a); a.removeAttribute(ATTR); a.removeAttribute("data-sift-id"); });
    const t = el("div", "sift-toast");
    t.appendChild(el("span", null, tx("contentUpdated", "Sift was updated — reload this page to keep filtering.")));
    const b = el("button", null, tx("contentReload", "Reload")); b.addEventListener("click", () => location.reload()); t.appendChild(b);
    document.body.appendChild(t);
  }

  function reevaluateAll() {
    document.querySelectorAll(`article[data-testid="tweet"]`).forEach((a) => { a.removeAttribute(ATTR); resetArticle(a); });
    pageHidden = 0; for (const k in pageCounts) delete pageCounts[k];
    scan();
  }

  try {
    chrome.storage.onChanged.addListener(async (_c, area) => {
      if (area !== "sync") return;
      await loadSettings();
      if (settings?.apiKey) toast(null);
      applyTheme();
      reevaluateAll();
    });
  } catch { /* orphaned */ }

  try { chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg.type === "showAll") {
      document.querySelectorAll(`[data-testid="cellInnerDiv"].sift-hidden`).forEach((c) => c.__siftSet?.(true));
      regroup();
      reply({ ok: true });
    } else if (msg.type === "pageStats") {
      reply({ hidden: pageHidden, counts: pageCounts });
    }
  }); } catch { /* orphaned */ }

  // ---------- extraction ----------
  function parseCount(s) {
    if (!s) return 0;
    s = s.replace(/,/g, "").trim();
    const m = s.match(/^([\d.]+)\s*([KMB])?$/i);
    if (!m) return 0;
    const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || "").toUpperCase()] || 1;
    return Math.round(parseFloat(m[1]) * mult);
  }

  function extract(article) {
    const timeLink = article.querySelector(`a[href*="/status/"] time`)?.closest("a");
    let idMatch = (timeLink?.getAttribute("href") || "").match(/\/status\/(\d+)/);
    if (!idMatch) {
      // promoted posts have no timestamp permalink; any /status/ link (analytics, media) still carries the id
      for (const a of article.querySelectorAll(`a[href*="/status/"]`)) { idMatch = a.getAttribute("href").match(/\/status\/(\d+)/); if (idMatch) break; }
    }
    if (!idMatch) return null;
    const id = idMatch[1];

    const textEl = article.querySelector(`[data-testid="tweetText"]`);
    const text = textEl ? textEl.innerText.trim() : "";

    const userName = article.querySelector(`[data-testid="User-Name"]`);
    let handle = "", displayName = "";
    if (userName) {
      const spans = [...userName.querySelectorAll("span")].map((s) => s.textContent.trim()).filter(Boolean);
      handle = (spans.find((s) => s.startsWith("@")) || "").slice(1);
      displayName = spans[0] || "";
    }

    const metrics = { replies: 0, reposts: 0, likes: 0, views: 0 };
    const label = article.querySelector(`[role="group"][aria-label]`)?.getAttribute("aria-label") || "";
    for (const part of label.split(",")) {
      const m = part.trim().match(/^([\d.,]+[KMB]?)\s+(\w+)/i);
      if (!m) continue;
      const n = parseCount(m[1]); const w = m[2].toLowerCase();
      if (w.startsWith("repl")) metrics.replies = n;
      else if (w.startsWith("repost") || w.startsWith("retweet")) metrics.reposts = n;
      else if (w.startsWith("like")) metrics.likes = n;
      else if (w.startsWith("view")) metrics.views = n;
    }

    const photos = [...article.querySelectorAll(`[data-testid="tweetPhoto"] img`)];
    const hasVideo = !!article.querySelector(`[data-testid="videoPlayer"], video`);
    const alts = photos.map((i) => (i.getAttribute("alt") || "").trim()).filter((a) => a && !/^(image|图片|imagen|bild)$/i.test(a));
    const cardEl = article.querySelector(`[data-testid="card.wrapper"], [data-testid^="card."], a[href*="/i/article/"], [data-testid="twitter-article"]`);
    const card = cardEl ? cardEl.innerText.replace(/\s+/g, " ").trim().slice(0, 300) : "";
    const isArticle = !!article.querySelector(`a[href*="/i/article/"], [data-testid="twitter-article"]`);
    const hasMedia = photos.length > 0 || hasVideo || !!cardEl;
    const hasLink = !!(textEl && textEl.querySelector(`a[href^="http"], a[href*="t.co"]`));
    const isAd = !!article.closest(`[data-testid="placementTracking"]`) ||
      [...article.querySelectorAll("span")].some((s) => s.textContent === "Ad" || s.textContent === "Promoted");
    const isReply = /(^|\n)Replying to\b/i.test(article.innerText.slice(0, 400));
    const isFocal = article.getAttribute("tabindex") === "-1";
    const quoted = article.querySelectorAll(`[data-testid="tweetText"]`)[1]?.innerText?.trim() || "";
    const quotedAuthor = article.querySelectorAll(`[data-testid="User-Name"]`)[1]?.innerText?.split("\n")?.[0] || "";

    return { id, el: article, handle, displayName, text, hasMedia, hasLink, isAd, isReply, isFocal, quoted, quotedAuthor, metrics,
      media: hasVideo ? "video" : photos.length ? `${photos.length} photo${photos.length > 1 ? "s" : ""}` : "", alts, card, isArticle };
  }

  function toState(t) {
    const s = { text: t.text };
    if (t.media) s.media = t.media;
    if (t.hasMedia) s.has_media = true;
    if (t.hasLink) s.has_link = true;
    if (t.alts.length) s.image_descriptions = t.alts.join(" | ");
    if (t.quoted) s.quoted_post = { author: t.quotedAuthor, text: t.quoted };
    if (t.card) s[t.isArticle ? "article" : "link_card"] = t.card;
    if (t.isReply) s.is_reply = true;
    if (!t.isFocal) {
      const p = focalPost();
      // in-thread replies on a /status/ page carry no "Replying to" line; anything below the focal post is a reply to it
      if (p && p.id !== t.id && (t.isReply || (t.el && p.el && p.el.compareDocumentPosition(t.el) & Node.DOCUMENT_POSITION_FOLLOWING))) {
        s.in_reply_to = { author: p.author, text: p.text };
      }
    }
    return XQF_normalizeStateForJev(s);
  }

  function stateIdentity(t, state) {
    return XQF_postStateIdentity(t.id, state || toState(t));
  }

  // On a /status/ page the focal post is the conversation root; replies are judged in its context.
  let focalCache = { path: "", post: null };
  function focalPost() {
    if (focalCache.path === location.pathname && focalCache.post?.el?.isConnected) return focalCache.post;
    if (!/\/status\/\d+/.test(location.pathname)) return null;
    const a = document.querySelector(`article[data-testid="tweet"][tabindex="-1"]`);
    const f = a && extract(a);
    if (!f || !(f.text || f.quoted || f.card)) return null;
    focalCache = { path: location.pathname, post: { id: f.id, el: a, author: f.handle, text: (f.text || f.quoted || f.card).slice(0, 600) } };
    return focalCache.post;
  }

  // ---------- decision ----------
  const pct = (x) => `${Math.round(x * 100)}%`;
  function catOf(t, v) {
    if (t.isAd) return "ad";
    return v?.category || null;
  }
  function isAI(v) { return !!v && typeof v.ai === "number" && v.ai >= AI_AT; }
  function isOffTopic(v) { return !!v && typeof v.tech === "number" && v.tech < techAt(); }

  function localVerdict(t, state) {
    return XQF_localVerdictForJev(state || toState(t));
  }

  function notePipeline(kind) { send({ type: "pipeline", kind }); }

  // reason: short plain words for the collapsed bar. cat: bucket for counts / colour.
  function decide(t, v) {
    const h = t.handle.toLowerCase();
    if (h && allow.has(h)) return { hide: false, reason: tx("alwaysShown", "always shown"), cat: "kept" };
    if (h && block.has(h)) return { hide: true, reason: tx("alwaysHidden", "always hidden"), cat: "blocked" };
    if (t.isAd) return { hide: !!settings.hide.junk, reason: tx("ad", "ad"), cat: "junk" };
    for (const re of stopRegexes) {
      if (re.test(t.text)) return { hide: !!settings.hide.junk, reason: tx("bait", "bait"), cat: "junk", local: true };
    }
    if (!v) return null;
    const ui = uiOf(v.category);
    const reasons = [];
    if (settings.hide[ui]) reasons.push(XQF_TAG[v.category] || CAT[ui][1]);
    if (settings.hideOffTopic && isOffTopic(v)) reasons.push(tx("offTopic", "off-topic"));
    if (settings.hideAI && isAI(v)) reasons.push(tx("aiPercent", "AI $1", [pct(v.ai)]));
    const cat = !reasons.length ? ui : settings.hide[ui] ? ui : (settings.hideOffTopic && isOffTopic(v)) ? "offtopic" : "ai";
    return { hide: reasons.length > 0, reason: reasons.join(" · "), cat };
  }

  // ---------- rendering ----------
  const cell = (article) => article.closest(`[data-testid="cellInnerDiv"]`) || article.parentElement;

  function resetArticle(article) {
    const c = cell(article);
    c.classList.remove("sift-hidden", "sift-dimmed", "sift-pending", "sift-grouped", "sift-signal");
    c.querySelectorAll(".sift-bar").forEach((b) => b.remove());
    delete c.dataset.siftReason; delete c.dataset.siftCat; delete c.__siftSet;
    article.querySelectorAll(".sift-tag").forEach((b) => b.remove());
  }

  // One quiet tag next to the author. Colour carries the verdict; the AI % only appears when it matters.
  function badge(article, v, decision) {
    if (!settings.showBadges || !v || !v.category) return;
    article.querySelectorAll(".sift-tag").forEach((x) => x.remove());
    const header = article.querySelector(`[data-testid="User-Name"]`);
    if (!header) return;
    const ui = uiOf(v.category);
    const off = isOffTopic(v);
    const tone = decision?.hide ? "muted" : off ? "offtopic" : ui;
    const tag = el("span", `sift-tag sift-t-${tone}`);
    const word = off && !decision?.hide ? tx("offTopic", "Off-topic") : (XQF_TAG[v.category] || CAT[ui][1]);
    tag.appendChild(el("span", "sift-tag-word", decision?.hide ? tx("hiddenReason", "Hidden · $1", [decision.reason]) : word));
    if (v.ai >= AI_SHOW && !decision?.hide) tag.appendChild(el("span", `sift-tag-ai ${v.ai >= AI_AT ? "high" : ""}`, tx("aiPercent", "AI $1", [pct(v.ai)])));
    const top = Object.entries(v.probs || {}).sort((a, b2) => b2[1] - a[1]).slice(0, 3).map(([k, p]) => `${fineLabel(k)} ${pct(p)}`).join(" · ");
    tag.title = tx("badgeTitle", "$1\nTech $2 · AI-written $3", [top, pct(v.tech ?? 1), pct(v.ai)]);
    tag.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); });
    header.appendChild(tag);
    // substantive + clearly tech: a hairline accent so the eye finds it while scrolling
    cell(article).classList.toggle("sift-signal", !decision?.hide && ui === "substance" && (v.tech ?? 1) >= 0.8);
  }

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function applyHide(article, t, decision, v) {
    const c = cell(article);
    if (settings.mode === "badge") { badge(article, v, decision); return; }
    if (settings.mode === "dim") { c.classList.add("sift-dimmed"); badge(article, v, decision); return; }

    c.classList.add("sift-hidden");
    if (c.querySelector(".sift-bar")) return;
    pageHidden++;
    pageCounts[decision.cat] = (pageCounts[decision.cat] || 0) + 1;
    c.dataset.siftReason = decision.reason; c.dataset.siftCat = decision.cat;

    const bar = el("div", "sift-bar");
    // never let clicks on our bar reach X's "open this post" handler
    bar.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); });
    const who = t.handle ? `@${t.handle}` : tx("post", "post");
    const text = el("span", "sift-bar-text");
    text.appendChild(el("span", "sift-bar-who", who));
    text.querySelector(".sift-bar-who").dataset.siftShown = tx("shown", "Shown");
    text.appendChild(el("span", "sift-bar-why", decision.reason));
    bar.appendChild(text);
    const actions = el("span", "sift-actions");
    const show = el("button", "sift-show", tx("show", "Show"));
    // set(open) is the single way to reveal / re-collapse this cell; group bars call it for every member
    c.__siftSet = (open) => {
      c.classList.toggle("sift-hidden", !open);
      bar.classList.toggle("sift-open", open);
      show.textContent = open ? tx("hide", "Hide") : tx("show", "Show");
      article.setAttribute(ATTR, open ? "revealed" : "hidden");
      if (open) badge(article, v, decision);
    };
    show.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); c.__siftSet(!bar.classList.contains("sift-open")); regroup(); });
    actions.appendChild(show);
    if (t.handle) {
      const more = el("button", "sift-more", "⋯");
      more.title = tx("more", "More");
      const menu = el("span", "sift-menu");
      const alw = el("button", "sift-menu-item", tx("contentAlwaysShow", "Always show @$1", [t.handle]));
      alw.addEventListener("click", (e) => { e.stopPropagation(); send({ type: "allow", handle: t.handle }); });
      const blk = el("button", "sift-menu-item", tx("contentAlwaysHide", "Always hide @$1", [t.handle]));
      blk.addEventListener("click", (e) => { e.stopPropagation(); send({ type: "block", handle: t.handle }); });
      menu.append(alw, blk);
      more.addEventListener("click", (e) => { e.stopPropagation(); menu.classList.toggle("open"); });
      actions.append(more, menu);
    }
    bar.appendChild(actions);
    c.prepend(bar);
    send({ type: "hidden", count: 1 });
    regroup();
  }

  // Consecutive hidden posts fold into one line: "4 posts hidden · off-topic 3, junk 1  Show".
  let groupTimer = null;
  function regroup() {
    if (groupTimer) return;
    groupTimer = setTimeout(() => { groupTimer = null; regroupNow(); }, 50);
  }
  function regroupNow() {
    document.querySelectorAll(".sift-group").forEach((g) => g.remove());
    const cells = [...document.querySelectorAll(`[data-testid="cellInnerDiv"]`)];
    let run = [];
    const flush = () => {
      run.forEach((c) => c.classList.remove("sift-grouped"));
      if (run.length >= 2) {
        const first = run[0];
        run.forEach((c) => c.classList.add("sift-grouped"));
        const counts = {};
        run.forEach((c) => { const r = c.dataset.siftReason || "hidden"; counts[r] = (counts[r] || 0) + 1; });
        const why = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(", ");
        const g = el("div", "sift-bar sift-group");
        g.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); });
        const text = el("span", "sift-bar-text");
        text.appendChild(el("span", "sift-bar-who", tx("postsHidden", "$1 posts hidden", [run.length])));
        text.appendChild(el("span", "sift-bar-why", why));
        g.appendChild(text);
        const show = el("button", "sift-show", tx("show", "Show"));
        const members = run;
        show.addEventListener("click", (e) => {
          e.stopPropagation(); e.preventDefault();
          members.forEach((c) => c.__siftSet?.(true));
          regroup();
        });
        g.appendChild(show);
        first.prepend(g);
      }
      run = [];
    };
    for (const c of cells) {
      const hidden = c.classList.contains("sift-hidden") && c.querySelector(".sift-bar:not(.sift-group)") && !c.querySelector(".sift-bar.sift-open");
      if (hidden) run.push(c);
      else if (run.length) flush();
    }
    if (run.length) flush();
  }

  function finish(article, t, v) {
    cell(article).classList.remove("sift-pending");
    const d = decide(t, v) || { hide: false, reason: "" };
    article.setAttribute(ATTR, d.hide ? "hidden" : "kept");
    if (d.hide && !t.isFocal) applyHide(article, t, d, v);
    else badge(article, v, t.isFocal ? { ...d, hide: false } : d); // the post you opened is never hidden, so don't say it is
  }

  // ---------- toast (setup / paused) ----------
  let toastEl = null;
  function toast(text, actionLabel, onAction) {
    toastEl?.remove(); toastEl = null;
    if (!text) return;
    toastEl = el("div", "sift-toast");
    toastEl.appendChild(el("span", null, text));
    if (actionLabel) {
      const b = el("button", null, actionLabel);
      b.addEventListener("click", onAction);
      toastEl.appendChild(b);
    }
    const x = el("button", "sift-toast-x", "×");
    x.addEventListener("click", () => toast(null));
    toastEl.appendChild(x);
    document.body.appendChild(toastEl);
  }

  // ---------- scoring pipeline ----------
  function flushBatch() {
    batchTimer = null;
    const items = batch; batch = [];
    if (!items.length) return;
    send({ type: "score", items: items.map((i) => ({ id: i.t.id, state: i.state, dimensions: i.dimensions })) })
      .then((r) => {
        if (r === null) { items.forEach((i) => i.resolve(null)); return; }
        if (r?.error === "no_api_key") {
          toast(tx("contentSetupKey", "Sift needs a TypeSafe API key to start filtering."), tx("contentSetupOneMinute", "Set up (1 min)"), () => send({ type: "openOptions" }));
          items.forEach((i) => i.resolve(null));
          return;
        }
        let authErr = null;
        const results = Array.isArray(r?.results) ? r.results : [];
        items.forEach((i, index) => {
          // Background preserves Promise.all order and echoes stateKey. Both
          // checks prevent a stale reply or duplicate post id from populating
          // the verdict for a different SPA context.
          const res = results[index];
          const sameIdentity = res && String(res.id) === String(i.t.id) && res.stateKey === i.stateKey;
          if (sameIdentity && res.verdict && res.verdict.evaluator === evaluatorId) {
            verdicts.set(i.identityKey, XQF_mergeVerdicts(verdicts.get(i.identityKey), res.verdict));
          }
          if (res?.error && /HTTP 40[13]/.test(res.error)) authErr = res.error;
          i.resolve(sameIdentity ? (verdicts.get(i.identityKey) || (res.verdict?.evaluator === evaluatorId ? res.verdict : null)) : null);
        });
        if (authErr) toast(tx("contentKeyRejected", "Sift: TypeSafe rejected the API key."), tx("contentFixKey", "Fix key"), () => send({ type: "openOptions" }));
      })
      .catch((e) => { items.forEach((i) => i.resolve(null)); console.warn("[Sift] score failed", e); });
  }

  function requestScore(t, dimensions, state) {
    const dims = [...new Set(dimensions || XQF_dimensionsForSettings(settings, { isReply: t.isReply }))].sort();
    const identity = XQF_scoreRequestIdentity(t.id, state || toState(t), dims);
    const current = verdicts.get(identity.key);
    if (!dims.length) return Promise.resolve(current || null);
    if (XQF_hasDimensions(current, dims)) return Promise.resolve(current);
    const pendingKey = identity.requestKey;
    if (pending.has(pendingKey)) return pending.get(pendingKey);
    const p = new Promise((resolve) => {
      batch.push({ t, state: identity.state, stateKey: identity.stateKey, identityKey: identity.key, dimensions: dims, resolve });
      if (!batchTimer) batchTimer = setTimeout(flushBatch, 120);
    }).finally(() => pending.delete(pendingKey));
    pending.set(pendingKey, p);
    return p;
  }

  async function process(article) {
    if (!active()) return;
    if (article.getAttribute(ATTR)) return;
    const t = extract(article);
    if (!t) return;
    article.setAttribute(ATTR, "pending");
    article.setAttribute("data-sift-id", t.id);
    const identity = stateIdentity(t);

    const onStatusPage = /\/status\/\d+/.test(location.pathname);
    if (onStatusPage && !t.isFocal && !settings.filterReplies) {
      if (!settings.showBadges) {
        notePipeline("skipped");
        article.setAttribute(ATTR, "kept");
        return;
      }
      const dims = XQF_dimensionsForSettings(settings, { isReply: true });
      const v0 = verdicts.get(identity.key);
      if (XQF_hasDimensions(v0, dims)) badge(article, v0, null);
      else requestScore(t, dims, identity.state).then((v) => v && article.isConnected && badge(article, v, null));
      article.setAttribute(ATTR, "kept");
      return;
    }

    const local = decide(t, null);
    if (local) { notePipeline("local"); finish(article, t, verdicts.get(identity.key) || null); return; }

    // nothing at all to judge (no text, no quote, no card, no media): keep silently
    if (!t.text && !t.quoted && !t.card && !t.media) { notePipeline("skipped"); article.setAttribute(ATTR, "kept"); return; }

    const dims = XQF_dimensionsForSettings(settings, { isReply: t.isReply });
    if (!dims.length) {
      notePipeline("skipped");
      article.setAttribute(ATTR, "kept");
      return;
    }

    const localVerdictForPost = localVerdict(t, identity.state);
    if (localVerdictForPost) {
      verdicts.set(identity.key, XQF_mergeVerdicts(verdicts.get(identity.key), localVerdictForPost));
      notePipeline("local");
      finish(article, t, verdicts.get(identity.key));
      return;
    }

    if (!XQF_hasDimensions(verdicts.get(identity.key), dims) && settings.mode === "hide") cell(article).classList.add("sift-pending");
    const v = await requestScore(t, dims, identity.state);
    if (!article.isConnected) return;
    finish(article, t, v);
  }

  function scan() {
    document.querySelectorAll(`article[data-testid="tweet"]:not([${ATTR}])`).forEach(process);
  }

  // ---------- theme ----------
  function applyTheme() {
    const bg = getComputedStyle(document.body).backgroundColor || "";
    const m = bg.match(/\d+/g); const lum = m ? (Number(m[0]) + Number(m[1]) + Number(m[2])) / 3 : 0;
    document.documentElement.setAttribute("data-sift-theme", lum > 128 ? "light" : "dark");
    document.documentElement.setAttribute("data-sift-sidebar", active() && settings.hideSidebar !== false ? "off" : "on");
  }

  // ---------- boot ----------
  (async () => {
    await loadSettings();
    if (torn || !settings) return;
    applyTheme();
    // a previous (now orphaned) copy of this script may have left marks behind
    document.querySelectorAll(`article[${ATTR}]`).forEach((a) => { resetArticle(a); a.removeAttribute(ATTR); a.removeAttribute("data-sift-id"); });
    document.querySelectorAll(".sift-toast").forEach((t) => t.remove());
    scan();
    obs = new MutationObserver((muts) => {
      for (const m of muts) if (m.addedNodes.length) { scan(); return; }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    // X re-uses mounted articles while scrolling; detect content swaps and re-process
    tick = setInterval(() => {
      if (!alive()) { teardown(); return; }
      applyTheme();
      document.querySelectorAll(`article[data-testid="tweet"][${ATTR}]`).forEach((a) => {
        const t = extract(a);
        const prev = a.getAttribute("data-sift-id");
        if (t && prev && prev !== t.id) { a.removeAttribute(ATTR); a.removeAttribute("data-sift-id"); resetArticle(a); }
      });
      scan();
      regroup();
    }, 1500);
  })();
})();
