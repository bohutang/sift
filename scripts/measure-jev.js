/*
 * Optional live measurement harness. It is intentionally opt-in because it
 * spends Jev credits. Capture one JSON result on main and one on the feature
 * branch with the same fixture file, then compare input tokens and quality.
 *
 *   SIFT_JEV_API_KEY=tsk_... npm run measure:jev > after.json
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const TECH_THRESHOLD = 0.5;
const AI_WRITTEN_THRESHOLD = 0.7;

function classifyAnswers(answers, expected, techThreshold = TECH_THRESHOLD, aiThreshold = AI_WRITTEN_THRESHOLD) {
  const category = answers?.category?.choice ?? null;
  const techProbability = typeof answers?.tech?.noul === "number" ? answers.tech.noul : null;
  const aiProbability = typeof answers?.ai_written?.noul === "number" ? answers.ai_written.noul : null;
  return {
    category,
    techProbability,
    tech: techProbability == null ? null : techProbability >= techThreshold,
    aiProbability,
    aiWritten: aiProbability == null ? null : aiProbability >= aiThreshold,
    expected
  };
}

function metric(correct, total) {
  return { correct, total, accuracy: total ? correct / total : null };
}

function summarizeRows(rows, { techThreshold = TECH_THRESHOLD, aiThreshold = AI_WRITTEN_THRESHOLD } = {}) {
  let categoryCorrect = 0, categoryTotal = 0;
  let techCorrect = 0, techTotal = 0;
  let aiCorrect = 0, aiTotal = 0;
  const mismatchCases = [];
  for (const row of rows) {
    const actual = classifyAnswers(row.answers, row.expected, techThreshold, aiThreshold);
    const expected = row.expected || {};
    const mismatches = [];
    if (expected.category != null) {
      categoryTotal++;
      if (actual.category === expected.category) categoryCorrect++;
      else mismatches.push({ dimension: "category", expected: expected.category, actual: actual.category });
    }
    if (typeof expected.tech === "boolean") {
      techTotal++;
      if (actual.tech === expected.tech) techCorrect++;
      else mismatches.push({ dimension: "tech", expected: expected.tech, actual: actual.tech, probability: actual.techProbability });
    }
    if (typeof expected.ai === "boolean") {
      aiTotal++;
      if (actual.aiWritten === expected.ai) aiCorrect++;
      else mismatches.push({ dimension: "ai_written", expected: expected.ai, actual: actual.aiWritten, probability: actual.aiProbability });
    }
    if (mismatches.length) mismatchCases.push({ id: row.id, mismatches, answers: row.answers || {} });
  }
  const totalInputTokens = rows.reduce((sum, row) => sum + (Number(row.input_tokens) || 0), 0);
  return {
    fixtureCount: rows.length,
    totalInputTokens,
    inputTokensPerFixture: rows.length ? totalInputTokens / rows.length : 0,
    categoryAccuracy: metric(categoryCorrect, categoryTotal),
    techAccuracy: metric(techCorrect, techTotal),
    aiWrittenAccuracy: metric(aiCorrect, aiTotal),
    mismatchCases,
    thresholds: { tech: techThreshold, aiWritten: aiThreshold }
  };
}

function loadDefaults() {
  const context = { console };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "defaults.js"), "utf8"), context);
  return context;
}

async function main() {
  const apiKey = process.env.SIFT_JEV_API_KEY || process.env.JEV_API_KEY;
  if (!apiKey) throw new Error("Set SIFT_JEV_API_KEY to run the live Jev measurement (this makes paid requests).");
  const context = loadDefaults();
  const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "tests", "fixtures", "jev-fixtures.json"), "utf8"));
  const model = context.XQF_resolveModel(process.env.SIFT_JEV_MODEL || context.XQF_DEFAULT_MODEL);
  const dimensions = (process.env.SIFT_JEV_DIMENSIONS || "category,tech,ai_written").split(",").filter(Boolean);
  const apiUrl = process.env.SIFT_JEV_URL || "https://api.typesafe.ai/v1/systemone";
  const techThreshold = Number(process.env.SIFT_JEV_TECH_THRESHOLD || TECH_THRESHOLD);
  const aiThreshold = Number(process.env.SIFT_JEV_AI_THRESHOLD || AI_WRITTEN_THRESHOLD);
  const rows = [];
  for (const fixture of fixtures) {
    const state = context.XQF_normalizeStateForJev(fixture);
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state, model, questions: context.XQF_questionsForDimensions(dimensions) })
    });
    if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    rows.push({ id: fixture.id, expected: fixture.expected || {}, answers: data.answers || {}, input_tokens: Number(data.usage?.input_tokens) || 0, model: data.model || model });
  }
  const summary = summarizeRows(rows, { techThreshold, aiThreshold });
  const localFixturesSent = fixtures.filter((fixture) => fixture.expected?.local).map((fixture) => fixture.id);
  console.log(JSON.stringify({
    scope: "jev-evaluator-only",
    note: "Every fixture is sent to Jev, including fixtures marked expected.local; use runtime stats for full-pipeline averages.",
    model,
    responseModels: [...new Set(rows.map((row) => row.model))],
    dimensions,
    localFixturesSent,
    ...summary,
    rows
  }, null, 2));
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });

module.exports = { classifyAnswers, summarizeRows };
