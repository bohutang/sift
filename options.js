globalThis.XQF_localize?.();
const $ = (id) => document.getElementById(id);
const SIMPLE = ["apiKey", "model", "mode", "filterReplies", "showBadges", "hideSidebar", "stopPhrases", "allowlist", "blocklist"];
let hide = {}; let hideAI = true; let hideOffTopic = true;

function flash(msg, err = false) {
  const s = $("status"); s.textContent = msg; s.style.color = err ? "var(--bad)" : "";
  setTimeout(() => { if (s.textContent === msg) { s.textContent = XQF_t("optionsSavedAutomatically", undefined, "Saved automatically."); s.style.color = ""; } }, 2000);
}

function catRow(icon, label, desc, hidden, onChange, extraClass = "") {
  const row = document.createElement("div"); row.className = "cat " + extraClass;
  const iconEl = document.createElement("div"); iconEl.className = "icon"; iconEl.textContent = icon;
  const copy = document.createElement("div");
  const name = document.createElement("div"); name.className = "name"; name.textContent = label;
  const description = document.createElement("div"); description.className = "desc"; description.textContent = desc;
  copy.append(name, description);

  const seg = document.createElement("div"); seg.className = "seg";
  const bs = document.createElement("button");
  bs.className = `show${hidden ? "" : " active"}`;
  bs.textContent = XQF_t("show", undefined, "Show");
  const bh = document.createElement("button");
  bh.className = `hide${hidden ? " active" : ""}`;
  bh.textContent = XQF_t("hide", undefined, "Hide");
  seg.append(bs, bh);
  row.append(iconEl, copy, seg);

  const set = (h) => { bs.classList.toggle("active", !h); bh.classList.toggle("active", h); onChange(h); };
  bs.addEventListener("click", () => set(false));
  bh.addEventListener("click", () => set(true));
  return row;
}

function renderCats() {
  const box = $("cats"); box.innerHTML = "";
  for (const [k, c] of Object.entries(XQF_CATEGORIES)) {
    box.appendChild(catRow(c.icon, c.label, c.desc, !!hide[k], (h) => { hide = { ...hide, [k]: h }; autosave(); }));
  }
  box.appendChild(catRow(XQF_TOPIC.icon, XQF_TOPIC.label, XQF_TOPIC.desc + XQF_t("topicDescriptionSuffix", undefined, ". Applies on top of any label; replies are judged by the post they answer."), hideOffTopic, (h) => { hideOffTopic = h; autosave(); }, "ai"));
  box.appendChild(catRow(XQF_AI.icon, XQF_AI.label, XQF_AI.desc + XQF_t("aiDescriptionSuffix", undefined, ". Applies on top of any label."), hideAI, (h) => { hideAI = h; autosave(); }, "ai"));
}

function fill(s) {
  for (const f of SIMPLE) { const el = $(f); if (el.type === "checkbox") el.checked = !!s[f]; else el.value = f === "model" ? XQF_resolveModel(s[f]) : (s[f] ?? ""); }
  hide = { ...XQF_DEFAULTS.hide, ...(s.hide || {}) }; hideAI = s.hideAI !== false; hideOffTopic = s.hideOffTopic !== false;
  renderCats();
  if (s.apiKey) setKeyStatus(XQF_t("statusConnected", undefined, "Connected"), true);
}

function collect() {
  const out = { hide, hideAI, hideOffTopic };
  for (const f of SIMPLE) { const el = $(f); out[f] = el.type === "checkbox" ? el.checked : el.value.trim(); }
  out.model = XQF_resolveModel(out.model);
  return out;
}

let autosaveTimer;
function autosave() { clearTimeout(autosaveTimer); autosaveTimer = setTimeout(save, 250); }
async function save() {
  const s = collect();
  const bad = s.stopPhrases.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    .filter((l) => { try { new RegExp(l, "i"); return false; } catch { return true; } });
  if (bad.length) return flash(XQF_t("statusInvalidRegex", [bad[0]], "Invalid regex: $1"), true);
  await chrome.storage.sync.set(s);
  flash(XQF_t("statusSaved", undefined, "Saved"));
}

function setKeyStatus(msg, ok) { const k = $("keyStatus"); k.textContent = msg; k.className = ok ? "ok" : "err"; }
$("connect").addEventListener("click", async () => {
  const key = $("apiKey").value.trim();
  if (!key) return setKeyStatus(XQF_t("statusPasteKeyFirst", undefined, "Paste your key first."), false);
  setKeyStatus(XQF_t("statusChecking", undefined, "Checking…"), true);
  const r = await chrome.runtime.sendMessage({ type: "test", apiKey: key, model: XQF_resolveModel($("model").value) });
  if (r.ok) {
    await chrome.storage.sync.set({ apiKey: key });
    setKeyStatus(XQF_t("statusConnectedTo", [r.model], "Connected to $1. Open x.com — Sift is on."), true);
  } else setKeyStatus(XQF_t("statusCouldNotConnect", [r.error], "Could not connect: $1"), false);
});
$("apiKey").addEventListener("keydown", (e) => { if (e.key === "Enter") $("connect").click(); });

for (const id of ["mode", "filterReplies", "showBadges", "hideSidebar", "model"]) $(id).addEventListener("change", autosave);
for (const id of ["allowlist", "blocklist", "stopPhrases"]) $(id).addEventListener("blur", autosave);
$("save").addEventListener("click", save);
$("resetPhrases").addEventListener("click", () => { $("stopPhrases").value = XQF_DEFAULTS.stopPhrases; autosave(); });

async function loadStats() {
  const { stats } = await chrome.runtime.sendMessage({ type: "stats" });
  $("sAnalyzed").textContent = stats.analyzed.toLocaleString();
  $("sHidden").textContent = stats.hidden.toLocaleString();
  $("sCost").textContent = "$" + stats.cost.toFixed(4);
  $("sErrors").textContent = stats.errors;
}
$("clearCache").addEventListener("click", async () => { await chrome.runtime.sendMessage({ type: "clearCache" }); flash(XQF_t("statusCacheCleared", undefined, "Cache cleared — posts will be re-labelled")); });
$("resetStats").addEventListener("click", async () => { await chrome.runtime.sendMessage({ type: "resetStats" }); loadStats(); flash(XQF_t("statusCountersReset", undefined, "Counters reset")); });

chrome.storage.onChanged.addListener((c, area) => {
  if (area !== "sync") return;
  if (c.allowlist && document.activeElement !== $("allowlist")) $("allowlist").value = c.allowlist.newValue || "";
  if (c.blocklist && document.activeElement !== $("blocklist")) $("blocklist").value = c.blocklist.newValue || "";
});

(async () => {
  fill({ ...XQF_DEFAULTS, ...(await chrome.storage.sync.get(XQF_DEFAULTS)) });
  loadStats();
})();
