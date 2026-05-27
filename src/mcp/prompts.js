import { z } from "zod";

/**
 * MCP *prompts* — reusable, parameterized prompt templates the host can surface
 * to users (e.g. as slash commands). The server owns the "right way" to ask for
 * a task; the client just fills in arguments. This is the third MCP primitive
 * alongside tools and resources.
 */
export function registerPrompts(server) {
  server.registerPrompt(
    "modernize_file",
    {
      title: "Modernize a legacy PHP file",
      description: "Generate instructions to rewrite one legacy PHP file into a hardened, modern equivalent.",
      argsSchema: {
        filePath: z.string().describe("Legacy file to modernize, e.g. legacy/legacy_sample.php"),
      },
    },
    ({ filePath }) => ({
      description: `Modernize ${filePath}`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Read ${filePath}, then rewrite it as a hardened, modern PHP file under modernized/.\n\n` +
              `Requirements:\n` +
              `- Replace raw SQL with PDO prepared statements.\n` +
              `- Replace md5/sha1/plaintext passwords with password_hash() / password_verify().\n` +
              `- Validate and sanitize every request input; escape all output.\n` +
              `- Use secure session/cookie flags and add CSRF protection where forms exist.\n` +
              `- Preserve the original behavior and keep the same filename under modernized/.\n\n` +
              `First run security_scan on it, fix every finding, then php_lint the result.`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "security_review",
    {
      title: "Security review",
      description: "Generate instructions for an LLM to security-review a file or directory.",
      argsSchema: {
        targetPath: z.string().describe("File or directory to review, e.g. modernized/"),
      },
    },
    ({ targetPath }) => ({
      description: `Security review of ${targetPath}`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Perform a security review of ${targetPath}.\n` +
              `Use security_scan to surface candidate issues, read_file to confirm each in context, ` +
              `and report findings grouped by severity (high/medium/low). For each finding give the ` +
              `file:line, why it is exploitable, and the concrete fix. End with a one-line risk verdict.`,
          },
        },
      ],
    })
  );
}
