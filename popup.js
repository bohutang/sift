globalThis.XQF_localize?.();
const $ = (id) => document.getElementById(id);
let settings, counts = {};

const STRICT = [
  { key: "relaxed", label: XQF_t("strictRelaxedLabel", undefined, "Relaxed"), value: 0.35, desc: XQF_t("strictRelaxedDescription", undefined, "Only clearly non-tech posts are hidden") },
  { key: "normal",  label: XQF_t("strictNormalLabel", undefined, "Normal"), value: 0.5, desc: XQF_t("strictNormalDescription", undefined, "") },
  { key: "strict",  label: XQF_t("strictStrictLabel", undefined, "Strict"), value: 0.65, desc: XQF_t("strictStrictDescription", undefined, "Anything not clearly tech is hidden") }
];

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && /^https:\/\/(x|twitter)\.com\//.test(tab.url || "") ? tab : null;
}

// Which preset matches the current hide map, if any.
function currentPreset() {
  for (const [k, p] of Object.entries(XQF_PRESETS)) {
    const same = Object.keys(p.hide).every((c) => !!settings.hide[c] === p.hide[c]) &&
      (settings.hideAI !== false) === p.hideAI && (settings.hideOffTopic !== false) === p.hideOffTopic;
    if (same) return k;
  }
  return null;
}

function segment(box, items, activeKey, onPick) {
  box.innerHTML = "";
  for (const it of items) {
    const b = document.createElement("button");
    b.textContent = it.label; b.classList.toggle("active", it.key === activeKey);
    b.addEventListener("click", () => onPick(it.key));
    box.appendChild(b);
  }
}

function renderPreset() {
  const cur = currentPreset();
  segment($("preset"), Object.entries(XQF_PRESETS).map(([key, p]) => ({ key, label: p.label })), cur, async (key) => {
    const p = XQF_PRESETS[key];
    settings.hide = { ...p.hide }; settings.hideAI = p.hideAI; settings.hideOffTopic = p.hideOffTopic;
    await chrome.storage.sync.set({ hide: settings.hide, hideAI: p.hideAI, hideOffTopic: p.hideOffTopic });
    renderPreset(); renderCats();
  });
  $("presetDesc").textContent = cur ? XQF_PRESETS[cur].desc : XQF_t("presetCustomDescription", undefined, "Custom — see labels below");
}

function renderStrict() {
  const t = Number(settings.techThreshold) || 0.5;
  const cur = STRICT.reduce((a, b) => Math.abs(b.value - t) < Math.abs(a.value - t) ? b : a).key;
  segment($("strict"), STRICT, cur, async (key) => {
    settings.techThreshold = STRICT.find((s) => s.key === key).value;
    await chrome.storage.sync.set({ techThreshold: settings.techThreshold });
    renderStrict();
  });
}

function row(label, hidden, count, onChange) {
  const r = document.createElement("div"); r.className = "cat";
  const name = document.createElement("span"); name.className = "n"; name.textContent = label;
  const total = document.createElement("span"); total.className = "cnt"; total.textContent = count || "";
  const seg = document.createElement("span"); seg.className = "seg";
  const bs = document.createElement("button");
  bs.className = `show${hidden ? "" : " active"}`;
  bs.textContent = XQF_t("show", undefined, "Show");
  const bh = document.createElement("button");
  bh.className = `hide${hidden ? " active" : ""}`;
  bh.textContent = XQF_t("hide", undefined, "Hide");
  seg.append(bs, bh);
  r.append(name, total, seg);

  const set = (h) => { bs.classList.toggle("active", !h); bh.classList.toggle("active", h); onChange(h); };
  bs.addEventListener("click", () => set(false)); bh.addEventListener("click", () => set(true));
  return r;
}

function renderCats() {
  const box = $("cats"); box.innerHTML = "";
  for (const [k, c] of Object.entries(XQF_CATEGORIES)) {
    box.appendChild(row(c.label, !!settings.hide[k], counts[k], async (h) => {
      settings.hide = { ...settings.hide, [k]: h };
      await chrome.storage.sync.set({ hide: settings.hide });
      renderPreset();
    }));
  }
  const sep = document.createElement("div"); sep.className = "sep"; box.appendChild(sep);
  box.appendChild(row(XQF_TOPIC.label, settings.hideOffTopic !== false, counts.offtopic, async (h) => {
    settings.hideOffTopic = h; await chrome.storage.sync.set({ hideOffTopic: h }); renderPreset();
  }));
  box.appendChild(row(XQF_AI.label, settings.hideAI !== false, counts.ai, async (h) => {
    settings.hideAI = h; await chrome.storage.sync.set({ hideAI: h }); renderPreset();
  }));
}

function renderPaused() {
  const paused = settings.pausedUntil > Date.now();
  $("paused").style.display = paused ? "block" : "none";
  $("pause").textContent = paused
    ? XQF_t("popupResumeOneHour", undefined, "Resume")
    : XQF_t("popupPauseOneHour", undefined, "Pause 1 h");
}

(async () => {
  settings = { ...XQF_DEFAULTS, ...(await chrome.storage.sync.get(XQF_DEFAULTS)) };
  settings.hide = { ...XQF_DEFAULTS.hide, ...(settings.hide || {}) };
  $("enabled").checked = settings.enabled;
  $("warn").style.display = settings.apiKey ? "none" : "block";
  renderPaused();

  const tab = await activeTab();
  if (tab) {
    try { counts = (await chrome.tabs.sendMessage(tab.id, { type: "pageStats" })).counts || {}; } catch { counts = {}; }
  } else { $("showAll").disabled = true; $("showAll").style.opacity = .5; }
  renderPreset(); renderStrict(); renderCats();

  const { stats } = await chrome.runtime.sendMessage({ type: "stats" });
  $("spent").textContent = XQF_t("statsLabelledCost", [stats.analyzed.toLocaleString(), `$${stats.cost.toFixed(3)}`], "$1 labelled · $2");
})();

$("enabled").addEventListener("change", (e) => chrome.storage.sync.set({ enabled: e.target.checked, pausedUntil: 0 }));
$("pause").addEventListener("click", async () => {
  const until = settings.pausedUntil > Date.now() ? 0 : Date.now() + 3600e3;
  settings.pausedUntil = until;
  await chrome.storage.sync.set({ pausedUntil: until });
  renderPaused();
});
$("resume").addEventListener("click", async (e) => { e.preventDefault(); settings.pausedUntil = 0; await chrome.storage.sync.set({ pausedUntil: 0 }); renderPaused(); });
$("showAll").addEventListener("click", async () => {
  const tab = await activeTab();
  if (tab) { await chrome.tabs.sendMessage(tab.id, { type: "showAll" }).catch(() => {}); counts = {}; renderCats(); }
});
for (const id of ["openOpts", "setup"]) $(id).addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
