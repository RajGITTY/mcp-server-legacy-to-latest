import { z } from "zod";
import { ok, guard, listBackups, restoreBackup } from "../lib/sandbox.js";

/**
 * Undo support. write_file / edit_file / delete_path / move_path snapshot the
 * prior version of a file before changing it (see filesystem.js). These tools
 * let the agent — or the user — list those snapshots and roll one back, so an
 * autonomous run is never a one-way door.
 */
export function registerBackupTools(server) {
  server.registerTool(
    "list_backups",
    {
      title: "List backups",
      description: "List automatic snapshots taken before files were overwritten, deleted, or moved (newest first).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async () => {
      const backups = await listBackups();
      if (!backups.length) return ok("No backups yet.");
      return ok(
        backups
          .map((b) => `${b.id}  ${b.savedAt}  ${b.reason.padEnd(7)}  ${b.path} (${b.bytes} B)`)
          .join("\n")
      );
    })
  );

  server.registerTool(
    "restore_backup",
    {
      title: "Restore backup",
      description: "Restore a file from a snapshot by its id (from list_backups), reverting the file to that version.",
      inputSchema: { id: z.string().describe("Backup id from list_backups") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    guard(async ({ id }) => {
      const rec = await restoreBackup(id);
      return ok(`Restored ${rec.path} from snapshot ${rec.id} (saved ${rec.savedAt})`);
    })
  );
}
