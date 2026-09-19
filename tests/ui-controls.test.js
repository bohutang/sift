const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

for (const [file, container] of [["options.js", "row"], ["popup.js", "r"]]) {
  test(`${file} builds show/hide controls without selector assumptions`, () => {
    const source = fs.readFileSync(path.join(root, file), "utf8");

    assert.match(source, /document\.createElement\("button"\)/);
    assert.match(source, /\.textContent = XQF_t\("show"/);
    assert.match(source, /\.textContent = XQF_t\("hide"/);
    assert.match(source, new RegExp(`${container}\\.append\\(`));

    // Keep the toggle builder independent of HTML parsing and selector timing.
    assert.doesNotMatch(source, new RegExp(`${container}\\.innerHTML\\s*=`));
    assert.doesNotMatch(source, new RegExp(`${container}\\.querySelector\\(`));
  });
}
