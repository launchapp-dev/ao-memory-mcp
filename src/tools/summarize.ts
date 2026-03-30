import type Database from "better-sqlite3";
import { now, jsonResult, errorResult } from "../db.ts";

export const summarizeTools = [
  {
    name: "memory.summarize",
    description:
      "Create a summary of memory entries. The calling agent provides the summary text. The server creates the summary record and transitions matching entries to 'summarized' status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_role: { type: "string", description: "Agent role being summarized" },
        project: { type: "string", description: "Project being summarized" },
        entry_type: { type: "string", description: "Entry type filter (omit for mixed)" },
        summary_title: { type: "string", description: "Title for the summary" },
        summary_body: { type: "string", description: "The summary text (markdown)" },
        before: { type: "string", description: "Summarize entries before this ISO date (default: 3 days ago)" },
        entry_ids: { type: "array", items: { type: "number" }, description: "Specific entry IDs to summarize (overrides date filter)" },
      },
      required: ["agent_role", "project", "summary_title", "summary_body"],
    },
  },
  {
    name: "memory.cleanup",
    description:
      "Identify entries needing summarization or archive old summarized entries. Use dry_run to preview without changes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        older_than_days: { type: "number", description: "Entries older than N days (default 7)" },
        min_entries: { type: "number", description: "Minimum entries per role+project to trigger (default 10)" },
        dry_run: { type: "boolean", description: "If true, just report what would happen (default true)" },
      },
    },
  },
];

export function handleSummarize(db: Database.Database, name: string, args: any) {
  if (name === "memory.summarize") return memorySummarize(db, args);
  if (name === "memory.cleanup") return memoryCleanup(db, args);
  return null;
}

function memorySummarize(db: Database.Database, args: any) {
  const { agent_role, project, entry_type, summary_title, summary_body } = args;

  const summarize = db.transaction(() => {
    let entryIds: number[];

    if (args.entry_ids?.length) {
      entryIds = args.entry_ids;
    } else {
      const cutoff = args.before || new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      const conditions = ["agent_role = ?", "project = ?", "status = 'active'", "occurred_at < ?"];
      const vals = [agent_role, project, cutoff];
      if (entry_type) { conditions.push("entry_type = ?"); vals.push(entry_type); }

      const rows = db.prepare(
        `SELECT id FROM memory_entries WHERE ${conditions.join(" AND ")} ORDER BY occurred_at ASC`
      ).all(...vals) as any[];
      entryIds = rows.map(r => r.id);
    }

    if (entryIds.length === 0) {
      return { error: "No entries to summarize" };
    }

    const entries = db.prepare(
      `SELECT MIN(occurred_at) as date_from, MAX(occurred_at) as date_to FROM memory_entries WHERE id IN (${entryIds.map(() => "?").join(",")})`
    ).get(...entryIds) as any;

    const ts = now();
    const result = db.prepare(`
      INSERT INTO memory_summaries (agent_role, project, entry_type, title, body, entry_count, date_from, date_to, entry_ids, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      agent_role, project, entry_type || null,
      summary_title, summary_body,
      entryIds.length, entries.date_from, entries.date_to,
      JSON.stringify(entryIds), ts
    );

    const placeholders = entryIds.map(() => "?").join(",");
    db.prepare(
      `UPDATE memory_entries SET status = 'summarized', updated_at = ? WHERE id IN (${placeholders})`
    ).run(ts, ...entryIds);

    return {
      summary_id: result.lastInsertRowid,
      entries_summarized: entryIds.length,
      date_from: entries.date_from,
      date_to: entries.date_to,
    };
  });

  const result = summarize();
  if ((result as any).error) return errorResult((result as any).error);
  return jsonResult(result);
}

function memoryCleanup(db: Database.Database, args: any) {
  const olderThanDays = args.older_than_days ?? 7;
  const minEntries = args.min_entries ?? 10;
  const dryRun = args.dry_run ?? true;

  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();

  // Find scopes that need summarization
  const needsSummarization = db.prepare(`
    SELECT agent_role, project, COUNT(*) as entry_count,
           MIN(occurred_at) as date_from, MAX(occurred_at) as date_to
    FROM memory_entries
    WHERE status = 'active' AND occurred_at < ?
    GROUP BY agent_role, project
    HAVING COUNT(*) >= ?
    ORDER BY entry_count DESC
  `).all(cutoff, minEntries);

  // Find old summarized entries eligible for archival
  const archivalCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const needsArchival = (db.prepare(`
    SELECT COUNT(*) as count FROM memory_entries
    WHERE status = 'summarized' AND updated_at < ?
  `).get(archivalCutoff) as any).count;

  if (!dryRun && needsArchival > 0) {
    const ts = now();
    db.prepare(`
      UPDATE memory_entries SET status = 'archived', archived_at = ?, updated_at = ?
      WHERE status = 'summarized' AND updated_at < ?
    `).run(ts, ts, archivalCutoff);
  }

  return jsonResult({
    needs_summarization: needsSummarization,
    needs_archival: needsArchival,
    archived: dryRun ? 0 : needsArchival,
    dry_run: dryRun,
  });
}
