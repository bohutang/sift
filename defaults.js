// Shared defaults. Loaded by background (importScripts), options and popup (<script>).

const XQF_TEXT = (key, fallback, substitutions) =>
  typeof XQF_t === "function" ? XQF_t(key, substitutions, fallback) : fallback;

// Pin the calibrated Jev model. `jev-latest` and `jev-preview` are aliases that
// can move when a new release ships, which would otherwise invalidate
// confidence thresholds and make persistent verdicts silently change meaning.
const XQF_DEFAULT_MODEL = "jev-1.13.0";
function XQF_resolveModel(model) {
  const configured = String(model || XQF_DEFAULT_MODEL).trim();
  return configured === "jev-latest" || configured === "jev-preview" ? XQF_DEFAULT_MODEL : configured;
}

// What the user sees: five labels. Jev answers with finer categories (below) which map onto these.
const XQF_CATEGORIES = {
  substance: { icon: "💡", label: XQF_TEXT("categorySubstanceLabel", "Substance"), hide: false, desc: XQF_TEXT("categorySubstanceDescription", "Insight, news, real discussion — something to learn or think about") },
  humor:     { icon: "😂", label: XQF_TEXT("categoryHumorLabel", "Humor"),     hide: false, desc: XQF_TEXT("categoryHumorDescription", "Jokes, memes, wit") },
  chitchat:  { icon: "🙂", label: XQF_TEXT("categoryChitchatLabel", "Chit-chat"), hide: false, desc: XQF_TEXT("categoryChitchatDescription", "Personal updates, photos, reactions, emoji replies") },
  promo:     { icon: "📢", label: XQF_TEXT("categoryPromoLabel", "Promo"),     hide: false, desc: XQF_TEXT("categoryPromoDescription", "Selling or pushing a product, course, newsletter, waitlist") },
  junk:      { icon: "🚫", label: XQF_TEXT("categoryJunkLabel", "Junk"),      hide: true,  desc: XQF_TEXT("categoryJunkDescription", "Engagement bait, empty filler, ads") }
};
const XQF_FINE_TO_UI = { insight: "substance", news: "substance", discussion: "substance", humor: "humor", personal: "chitchat", promo: "promo", bait: "junk", filler: "junk", ad: "junk" };
const XQF_FINE_LABEL = {
  insight: XQF_TEXT("fineInsight", "insight"), news: XQF_TEXT("fineNews", "news"), discussion: XQF_TEXT("fineDiscussion", "discussion"),
  humor: XQF_TEXT("fineHumor", "humor"), personal: XQF_TEXT("finePersonal", "personal"), promo: XQF_TEXT("finePromo", "promo"),
  bait: XQF_TEXT("fineBait", "engagement bait"), filler: XQF_TEXT("fineFiller", "filler"), ad: XQF_TEXT("fineAd", "ad")
};
// Short word shown on the post tag.
const XQF_TAG = {
  insight: XQF_TEXT("tagInsight", "Insight"), news: XQF_TEXT("tagNews", "News"), discussion: XQF_TEXT("tagDiscussion", "Discussion"),
  humor: XQF_TEXT("tagHumor", "Humor"), personal: XQF_TEXT("tagPersonal", "Chat"), promo: XQF_TEXT("tagPromo", "Promo"),
  bait: XQF_TEXT("tagBait", "Bait"), filler: XQF_TEXT("tagFiller", "Filler"), ad: XQF_TEXT("tagAd", "Ad")
};

// One-tap presets: what to hide.
const XQF_PRESETS = {
  signal:     { label: XQF_TEXT("presetSignalLabel", "Signal"),     desc: XQF_TEXT("presetSignalDescription", "Only substantive tech posts"), hide: { substance: false, humor: true,  chitchat: true,  promo: true,  junk: true }, hideAI: true, hideOffTopic: true },
  balanced:   { label: XQF_TEXT("presetBalancedLabel", "Balanced"),   desc: XQF_TEXT("presetBalancedDescription", "Tech, including humor and chat"), hide: { substance: false, humor: false, chitchat: false, promo: false, junk: true }, hideAI: true, hideOffTopic: true },
  everything: { label: XQF_TEXT("presetEverythingLabel", "Everything"), desc: XQF_TEXT("presetEverythingDescription", "Label only, hide nothing"), hide: { substance: false, humor: false, chitchat: false, promo: false, junk: false }, hideAI: false, hideOffTopic: false }
};

// Orthogonal flags: any label can also be AI-written, and any label can be off-topic.
const XQF_AI = { icon: "🤖", label: XQF_TEXT("aiLabel", "AI-written"), hide: true, desc: XQF_TEXT("aiDescription", "Reads like ChatGPT wrote it: “It's not X. It's Y.”, rule-of-three lists, emoji bullets, buzzwords, zero personal detail") };
const XQF_TOPIC = { icon: "🌐", label: XQF_TEXT("topicLabel", "Off-topic"), hide: true, desc: XQF_TEXT("topicDescription", "Not about tech: gossip, relationships, entertainment, sports, politics, lifestyle, memes with no technical angle") };

const XQF_DEFAULTS = {
  enabled: true,
  pausedUntil: 0,
  apiKey: "",
  model: XQF_DEFAULT_MODEL,
  // which categories to hide: {insight:false, ..., bait:true}
  hide: Object.fromEntries(Object.entries(XQF_CATEGORIES).map(([k, c]) => [k, c.hide])),
  hideAI: true,
  // hide posts that are not about technology / software / AI / science / the tech industry
  hideOffTopic: true,
  // P(tech) below which a post counts as off-topic
  techThreshold: 0.5,
  // also classify and hide replies under a post (the focal post itself is never hidden)
  filterReplies: true,
  // "hide" = collapse into a one-line bar with Show, "dim" = fade, "badge" = label only
  mode: "hide",
  showBadges: true,
  // hide X's right column (Premium upsell, Today's News, Trending, Who to follow) and let posts use the width
  hideSidebar: true,
  // stop phrases: one regex per line (case-insensitive). Matched locally, hides instantly, no API call.
  stopPhrases: [
    "\\bbookmark this\\b",
    "\\blet that sink in\\b",
    "\\bread that again\\b",
    "\\breply\\s+(with\\s+)?[\"“']?\\w+[\"”']?\\s+and\\s+i(?:'ll| will)\\s+(send|dm|share)",
    "\\bcomment\\s+[\"“']?\\w+[\"”']?\\s+and\\s+i(?:'ll| will)\\s+(send|dm|share)",
    "\\bfollow\\s+(me\\s+)?for\\s+more\\b",
    "\\bnobody\\s+is\\s+talking\\s+about\\s+this\\b",
    "\\bthis\\s+changes\\s+everything\\b",
    "\\byou(?:'re| are)\\s+not\\s+ready\\b",
    "\\bmost\\s+people\\s+(don't|dont|won't|will\\s+never)\\s+(know|understand|realize|get)\\b",
    "\\bhere(?:'s| is)\\s+(the|my)\\s+exact\\s+(system|framework|playbook|blueprint)\\b",
    "\\b(like|rt|retweet)\\s+(and|\\+|&)\\s+(follow|retweet|rt|like)\\b",
    "\\brt\\s+if\\s+you\\b",
    "\\bdrop\\s+a\\s+🔥",
    "\\b(i|we)\\s+made\\s+\\$\\d[\\d,]*k?\\s+in\\s+\\d+\\s+(days|hours|weeks)\\b",
    "^\\s*gm\\b\\s*[!.☀️🌞]*\\s*$",
    "^\\s*gn\\b\\s*[!.🌙]*\\s*$",
    "\\b(free|giveaway)\\b.*\\b(retweet|rt|follow|like)\\b",
    "\\bdm\\s+me\\s+[\"“']?\\w+[\"”']?\\s+(to|for)\\b"
  ].join("\n"),
  allowlist: "",
  blocklist: ""
};

// Jev evaluator identity.  Cache entries are versioned per dimension so a
// prompt/state change never silently reuses a result from an older evaluator.
const XQF_PROMPT_VERSION = "2026-09-19-compact-v1";
const XQF_STATE_SCHEMA_VERSION = 3;
const XQF_DIMENSION_VERSIONS = Object.freeze({
  category: "2026-09-19-category-v1",
  tech: "2026-09-19-tech-v1",
  ai_written: "2026-09-19-ai-v1"
});
const XQF_STATE_LIMITS = Object.freeze({
  text: 2200,
  quoted: 700,
  reply: 700,
  card: 360,
  media: 80,
  imageDescriptions: 420
});

// Preserve the beginning (what usually contains the claim) and the end (what
// often contains the conclusion/link) when a long premium post exceeds the
// input budget.  This is deliberately shared by content.js and background.js.
function XQF_truncate(text, limit) {
  const value = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .trim();
  if (!value || value.length <= limit) return value;
  const head = Math.max(1, Math.ceil(limit * 0.64));
  const tail = Math.max(1, limit - head - 1);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function XQF_evaluatorIdentity(model) {
  return `${XQF_resolveModel(model)}|${XQF_PROMPT_VERSION}|${XQF_STATE_SCHEMA_VERSION}`;
}

function XQF_copyContext(value, limit, keepAuthor = false) {
  if (!value || typeof value !== "object") return null;
  const text = XQF_truncate(value.text, limit);
  if (!text) return null;
  const out = { text };
  if (keepAuthor && value.author) out.author = XQF_truncate(value.author, 80);
  return out;
}

// One normalization boundary keeps the request small and makes the optional
// semantic cache stable.  Volatile engagement counters and display names are
// intentionally not copied.
function XQF_normalizeStateForJev(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const out = {};
  const text = XQF_truncate(source.text, XQF_STATE_LIMITS.text);
  if (text) out.text = text;
  const media = XQF_truncate(source.media, XQF_STATE_LIMITS.media);
  if (media) out.media = media;
  const imageDescriptions = XQF_truncate(source.image_descriptions, XQF_STATE_LIMITS.imageDescriptions);
  if (imageDescriptions) out.image_descriptions = imageDescriptions;
  if (source.has_media && !media && !imageDescriptions) out.has_media = true;

  const quoted = XQF_copyContext(source.quoted_post, XQF_STATE_LIMITS.quoted, true);
  if (quoted) out.quoted_post = quoted;
  const reply = XQF_copyContext(source.in_reply_to, XQF_STATE_LIMITS.reply, true);
  if (reply) out.in_reply_to = reply;

  const article = XQF_truncate(source.article, XQF_STATE_LIMITS.card);
  if (article) out.article = article;
  const linkCard = XQF_truncate(source.link_card, XQF_STATE_LIMITS.card);
  if (linkCard) out.link_card = linkCard;

  // These booleans are only useful when their richer representation is absent.
  if (source.has_link && !article && !linkCard) out.has_link = true;
  if (source.is_reply && !reply) out.is_reply = true;
  return out;
}

// Keep state identity in one place. The content script uses this for its
// in-memory verdict/pending keys and the background uses it for persistent and
// semantic caches, so a reply gaining parent context cannot reuse an older
// context-free result.
function XQF_fingerprint(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function XQF_stateFingerprint(raw) {
  return XQF_fingerprint(XQF_normalizeStateForJev(raw));
}

function XQF_postStateIdentity(postId, rawState) {
  const state = XQF_normalizeStateForJev(rawState);
  const stateKey = XQF_fingerprint(state);
  return { state, stateKey, key: `${String(postId)}:${stateKey}` };
}

function XQF_scoreRequestIdentity(postId, rawState, dimensions) {
  const post = XQF_postStateIdentity(postId, rawState);
  const dims = [...new Set(dimensions || [])].sort();
  return { ...post, dimensions: dims, requestKey: `${post.key}:${dims.join(",")}` };
}

// Select only the dimensions that can affect the current UI decision.  A
// reply with both filtering and badges disabled has no observable Jev result.
function XQF_dimensionsForSettings(settings, context = {}) {
  const s = settings || {};
  const badge = s.showBadges !== false;
  if (context.isReply && s.filterReplies === false && !badge) return [];
  const hide = { ...(XQF_DEFAULTS?.hide || {}), ...(s.hide || {}) };
  const dims = [];
  if (badge || Object.values(hide).some(Boolean)) dims.push("category");
  if (badge || s.hideOffTopic !== false) dims.push("tech");
  if (badge || s.hideAI !== false) dims.push("ai_written");
  return dims;
}

function XQF_questionsForDimensions(dimensions) {
  const wanted = new Set(dimensions || []);
  return Object.fromEntries(Object.entries(XQF_QUESTIONS).filter(([key]) => wanted.has(key)));
}

function XQF_hasDimensions(verdict, dimensions) {
  if (!verdict) return false;
  return (dimensions || []).every((dim) => {
    if (dim === "category") return typeof verdict.category === "string" && verdict.category.length > 0;
    return typeof verdict[dim === "ai_written" ? "ai" : "tech"] === "number";
  });
}

function XQF_mergeVerdicts(base, patch) {
  return { ...(base || {}), ...(patch || {}), probs: { ...(base?.probs || {}), ...(patch?.probs || {}) } };
}

// Deliberately narrow local bypass for posts with no media, quote, link, or
// reply context. Contextual reactions are left to Jev.
const XQF_PURE_EMOJI = /^(?:[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D\s])+$/u;
function XQF_localVerdictForJev(raw) {
  const state = XQF_normalizeStateForJev(raw);
  if (state.is_reply || state.in_reply_to || state.quoted_post || state.article || state.link_card || state.media || state.image_descriptions || state.has_media || state.has_link) return null;
  const text = (state.text || "").trim();
  if (!text) return null;
  const emoji = XQF_PURE_EMOJI.test(text);
  const stripped = text.replace(/[.!?…]+$/, "").trim();
  const filler = !emoji && (/^(?:gm|gn|w|first|this|same|lol|lolz|ok|okay|nice|wow|f)$/i.test(stripped) || /^[.·…!?]+$/.test(text));
  if (!emoji && !filler) return null;
  const category = emoji ? "personal" : "filler";
  return { category, confidence: 1, probs: { [category]: 1 }, tech: 0, ai: 0, model: "local", evaluator: "local", local: true, t: Date.now() };
}

// Compact questions: keep the ambiguous boundaries that affect product
// behavior, but avoid repeating examples in both instructions and criteria.
const XQF_QUESTIONS = {
  category: {
    type: "choice",
    instructions: "Choose one category using the post, media/card, quote, and reply context. Photos, videos, emoji-only quotes, and brief context-linked reactions are personal; memes/jokes are humor. Insight/news must teach or state concrete facts. A genuine short reply is personal, not filler.",
    criteria: {
      insight: "Original analysis, experience, technical detail, data, or a lesson that teaches.",
      news: "A concrete event, release, paper, announcement, or fact with specifics.",
      discussion: "A genuine question/opinion with enough context for substantive replies.",
      humor: "A joke, meme, pun, funny screenshot, or witty observation.",
      personal: "Casual update/photo/video, plain reaction/emoji, thanks, agreement, congratulations, or brief context-linked reply.",
      promo: "Selling or pushing a product, course, newsletter, waitlist, affiliate, or own project.",
      bait: "Engagement farming: bookmark/reply-to-DM, follower farming, ragebait, vague secret/system, or contentless 'agree?/thoughts?'.",
      filler: "Literally empty text-only post/reply ('gm', '.', 'W', 'first', 'so true'); not a specific reaction or media/quote response."
    }
  },
  tech: {
    type: "noul",
    instructions: "Is this about technology? A reply inherits the topic of in_reply_to.",
    criteria: {
      true: "Software, programming, AI/ML, dev tools, open source, data/infrastructure, hardware/chips, science/engineering/math, startups/tech industry, tech products or policy.",
      false: "Relationships, gossip, entertainment, sports, unrelated politics, lifestyle, food, travel, fitness, finance tips, generic advice, or memes without a technical angle."
    }
  },
  ai_written: {
    type: "noul",
    instructions: "Does this prose read AI-generated rather than personally typed?",
    criteria: {
      true: "Polished generic LLM patterns: false contrasts, rule-of-three/emoji bullets, heavy em dashes, buzzwords, hook-lesson-CTA, uniform sentences, no personal specifics.",
      false: "Typos/slang/uneven rhythm, terse or personal details/numbers, in-jokes, raw opinion, or natural casual Chinese/English."
    }
  }
};

if (typeof globalThis !== "undefined") {
  Object.assign(globalThis, {
    XQF_DEFAULT_MODEL, XQF_resolveModel, XQF_DEFAULTS, XQF_CATEGORIES, XQF_FINE_TO_UI, XQF_FINE_LABEL, XQF_TAG, XQF_PRESETS,
    XQF_AI, XQF_TOPIC, XQF_QUESTIONS, XQF_PROMPT_VERSION, XQF_DIMENSION_VERSIONS, XQF_STATE_SCHEMA_VERSION,
    XQF_STATE_LIMITS, XQF_truncate, XQF_evaluatorIdentity, XQF_normalizeStateForJev, XQF_fingerprint, XQF_stateFingerprint,
    XQF_postStateIdentity, XQF_scoreRequestIdentity, XQF_localVerdictForJev, XQF_dimensionsForSettings,
    XQF_questionsForDimensions, XQF_hasDimensions, XQF_mergeVerdicts
  });
}
