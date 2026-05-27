import fs from "fs/promises";
import { z } from "zod";
import { safeResolve, relPath, ok, guard, walk, runProcess } from "../lib/sandbox.js";

/**
 * Static vulnerability rules. Heuristic line-level patterns — fast, dependency
 * free, and tuned for the kind of legacy PHP this project modernizes. Each maps
 * a vulnerability class to the remediation the modernizer should apply.
 */
export const RULES = [
  // A SQL keyword followed (on the same line) by a PHP variable means the query
  // is built by interpolation or concatenation. A parameterized query has only
  // `?`/`:name` placeholders after the keyword, so this won't flag prepared statements.
  { id: "sql-injection", severity: "high",
    pattern: /\b(SELECT|INSERT|UPDATE|DELETE)\b.*\$\w+/i,
    message: "SQL query built with a PHP variable (interpolation/concatenation) — SQL injection. Use PDO prepared statements with bound parameters." },
  { id: "dynamic-include", severity: "high",
    pattern: /\b(include|require)(_once)?\b\s*\(?\s*\$_(GET|POST|REQUEST|COOKIE)/i,
    message: "File included from request input — local/remote file inclusion. Use a fixed allowlist." },
  { id: "command-exec", severity: "high",
    pattern: /\b(eval|exec|system|shell_exec|passthru|popen|proc_open)\s*\(/,
    message: "Dynamic code/command execution. Avoid, or strictly validate and escape arguments." },
  { id: "xss-echo", severity: "high",
    pattern: /\b(echo|print)\b[^;]*\$_(GET|POST|REQUEST|COOKIE)/i,
    message: "User input echoed without escaping — reflected XSS. Use htmlspecialchars()." },
  // Assignment of a credential to a quoted *literal* (no `$`, so interpolated
  // values like '$password' inside a SQL string are not misreported here).
  { id: "hardcoded-credential", severity: "high",
    pattern: /\b(password|passwd|pwd|secret|api_?key|access_?token)\b\s*=\s*['"][^'"$]{3,}['"]/i,
    message: "Hardcoded credential. Move secrets to environment variables / a secrets manager." },
  { id: "deprecated-mysql", severity: "medium",
    pattern: /\bmysql_(query|connect|fetch_array|fetch_assoc|result|real_escape_string)\s*\(/,
    message: "Deprecated ext/mysql API (removed in PHP 7). Migrate to PDO or mysqli." },
  { id: "weak-hash", severity: "medium",
    pattern: /\b(md5|sha1)\s*\(/,
    message: "Weak hash for secrets. Use password_hash()/password_verify() for passwords." },
  { id: "extract-input", severity: "medium",
    pattern: /\bextract\s*\(\s*\$_(GET|POST|REQUEST)/i,
    message: "extract() on request input lets attackers set arbitrary variables." },
  { id: "tls-verify-disabled", severity: "medium",
    pattern: /CURLOPT_SSL_VERIFY(PEER|HOST)\s*,\s*(0|false)/i,
    message: "TLS certificate verification disabled — enables MITM." },
  { id: "raw-superglobal", severity: "low",
    pattern: /\$_(GET|POST|REQUEST|COOKIE)\s*\[/,
    message: "Raw superglobal access. Validate, sanitize, and type-cast input." },
];

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

export function scanText(text, rel) {
  const lines = text.split("\n");
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        found.push({ rule, file: rel, line: i + 1, code: line.trim() });
      }
    }
  }
  // Noise reduction: if a line already has a high/medium finding, drop the
  // catch-all low "raw-superglobal" note for that same line.
  const elevated = new Set(found.filter((f) => f.rule.severity !== "low").map((f) => `${f.file}:${f.line}`));
  return found.filter((f) => f.rule.id !== "raw-superglobal" || !elevated.has(`${f.file}:${f.line}`));
}

// Scan a file or directory of PHP and return all findings.
async function scanTarget(targetPath) {
  const full = safeResolve(targetPath);
  const st = await fs.stat(full);
  const findings = [];
  const scanFile = async (p) => {
    if (!/\.(php|phtml|inc)$/i.test(p)) return;
    let text;
    try { text = await fs.readFile(p, "utf-8"); } catch { return; }
    findings.push(...scanText(text, relPath(p)));
  };
  if (st.isDirectory()) await walk(full, scanFile);
  else await scanFile(full);
  return findings;
}

function countBySeverity(findings) {
  return findings.reduce((acc, f) => ((acc[f.rule.severity] = (acc[f.rule.severity] || 0) + 1), acc), {});
}

export function registerPhpTools(server) {
  server.registerTool(
    "php_lint",
    {
      title: "PHP syntax check",
      description: "Run `php -l` on a file to check for syntax errors. Requires the php CLI on PATH.",
      inputSchema: { filePath: z.string().describe("Path to a .php file, relative to project root") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ filePath }) => {
      const full = safeResolve(filePath);
      const { stdout, stderr, code, spawnError } = await runProcess("php", ["-l", full], { timeout: 10000 });
      if (spawnError) throw new Error("php CLI is not installed or not on PATH");
      const out = (stdout || stderr).trim();
      return ok(`${out}\n(exit code ${code})`);
    })
  );

  server.registerTool(
    "security_scan",
    {
      title: "Security scan (PHP)",
      description:
        "Heuristically scan a PHP file or directory for common vulnerabilities (SQL injection, XSS, " +
        "hardcoded credentials, dangerous exec, weak hashing, file inclusion). Returns findings grouped by severity.",
      inputSchema: {
        targetPath: z.string().default("legacy").describe("File or directory to scan, relative to project root"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ targetPath }) => {
      const findings = await scanTarget(targetPath);
      if (!findings.length) return ok(`No issues found under ${targetPath}.`);

      findings.sort(
        (a, b) =>
          SEVERITY_ORDER[a.rule.severity] - SEVERITY_ORDER[b.rule.severity] ||
          a.file.localeCompare(b.file) ||
          a.line - b.line
      );

      const counts = countBySeverity(findings);
      const summary = `Found ${findings.length} issue(s): ${["high", "medium", "low"]
        .filter((s) => counts[s])
        .map((s) => `${counts[s]} ${s}`)
        .join(", ")}`;

      const body = findings
        .map((f) => `[${f.rule.severity.toUpperCase()}] ${f.file}:${f.line}  (${f.rule.id})\n    ${f.code}\n    → ${f.rule.message}`)
        .join("\n");

      return ok(`${summary}\n\n${body}`);
    })
  );

  server.registerTool(
    "security_report",
    {
      title: "Security report (before vs after)",
      description:
        "Compare two paths (e.g. legacy vs modernized) and produce a markdown report: severity counts before " +
        "and after, how many issues were resolved, and what remains. Ideal as a modernization summary.",
      inputSchema: {
        before: z.string().default("legacy").describe("Original code path"),
        after: z.string().default("modernized").describe("Modernized code path"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ before, after }) => {
      const [beforeF, afterF] = await Promise.all([scanTarget(before), scanTarget(after)]);
      const bc = countBySeverity(beforeF);
      const ac = countBySeverity(afterF);
      const sev = ["high", "medium", "low"];
      const total = (c) => sev.reduce((n, s) => n + (c[s] || 0), 0);
      const critical = (c) => (c.high || 0) + (c.medium || 0); // the ones that matter most

      const rows = sev
        .map((s) => `| ${s} | ${bc[s] || 0} | ${ac[s] || 0} | ${(bc[s] || 0) - (ac[s] || 0)} |`)
        .join("\n");

      const remaining = afterF.length
        ? afterF
            .sort((a, b) => SEVERITY_ORDER[a.rule.severity] - SEVERITY_ORDER[b.rule.severity])
            .map((f) => `- **${f.rule.severity}** ${f.file}:${f.line} (${f.rule.id})`)
            .join("\n")
        : "_none_";

      return ok(
        `# Security report\n\n` +
          `**${before}** → **${after}**\n\n` +
          `| severity | before | after | resolved |\n|---|---|---|---|\n${rows}\n\n` +
          `High/medium issues: ${critical(bc)} → ${critical(ac)} (${critical(bc) - critical(ac)} resolved). ` +
          `Total findings: ${total(bc)} → ${total(ac)}.\n\n` +
          `## Remaining in ${after}\n${remaining}`
      );
    })
  );
}
