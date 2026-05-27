import test from "node:test";
import assert from "node:assert/strict";

import { safeResolve, globToRegExp, unifiedDiff, ROOT } from "../src/mcp/lib/sandbox.js";
import { estimateCost } from "../src/agent/cost.js";
import { scanText } from "../src/mcp/tools/php.js";

test("safeResolve confines paths to the project root", () => {
  assert.equal(safeResolve("."), ROOT);
  assert.throws(() => safeResolve("../../etc/passwd"), /escapes project root/);
  assert.throws(() => safeResolve("../outside"), /escapes project root/);
});

test("globToRegExp handles **, *, and segment boundaries", () => {
  assert.ok(globToRegExp("**/*.php").test("a/b/c.php"));
  assert.ok(globToRegExp("**/*.php").test("c.php"));
  assert.ok(!globToRegExp("**/*.php").test("c.js"));
  assert.ok(globToRegExp("src/*.js").test("src/a.js"));
  assert.ok(!globToRegExp("src/*.js").test("src/a/b.js")); // * does not cross /
});

test("unifiedDiff: identical is empty, a change shows -/+ and a hunk header", () => {
  assert.equal(unifiedDiff("a\nb\nc", "a\nb\nc"), "");
  const d = unifiedDiff("a\nb\nc", "a\nX\nc", { path: "f.txt" });
  assert.match(d, /@@ -\d+,\d+ \+\d+,\d+ @@/);
  assert.ok(d.includes("-b"));
  assert.ok(d.includes("+X"));
});

test("estimateCost: known model returns a number, unknown returns null", () => {
  const c = estimateCost("openai:gpt-4o-mini", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.equal(c, 0.15 + 0.6);
  assert.equal(estimateCost("stub:whatever", { inputTokens: 100 }), null);
});

test("security scan flags interpolated SQL but not a prepared statement", () => {
  const vuln = scanText(`$sql = "SELECT id FROM users WHERE u = '$username'";`, "t.php");
  assert.ok(vuln.some((f) => f.rule.id === "sql-injection"));

  const safe = scanText(`$stmt = $db->prepare("SELECT id FROM users WHERE u = ?");`, "t.php");
  assert.ok(!safe.some((f) => f.rule.id === "sql-injection"));
});
