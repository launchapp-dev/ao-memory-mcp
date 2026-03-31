import type Database from "better-sqlite3";
import { now, jsonResult, errorResult } from "../db.ts";

export const summarizeTools = [
  {
    name: "memory.summarize",
    description:
      "Create a summary of memory entries. Agent provides the summary text. Server creates the summary record and transitions entries to 'summarized'.",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: { type: "string", description: "Namespace to summarize" },
        agent_role: { type: "string", description: "Agent role" },
        summary_title: { type: "string", description: "Summary title" },
        summary_body: { type: "string", description: "Summary content (markdown)" },
        before: { type: "string", description: "Summarize entries before this ISO date" },
        entry_ids: { type: "array", items: { type: "number" }, description: "Specific IDs to summarize" },
      },
      required: ["namespace", "summary_title", "summary_body"],
    },
  },
  {
    name: "memory.cleanup",
    description: "Identify stale entries needing summarization or archive old summarized entries.",
    inputSchema: {
      type: "object" as const,
      properties: {
        older_than_days: { type: "number", description: "Entries older than N days (default 7)" },
        min_entries: { type: "number", description: "Min entries per scope to trigger (default 10)" },
        dry_run: { type: "boolean", description: "Preview only (default true)" },
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
  const { namespace, agent_role, summary_title, summary_body } = args;

  const result = db.transaction(() => {
    let entryIds: number[];

    if (args.entry_ids?.length) {
      entryIds = args.entry_ids;
    } else {
      const cutoff = args.before || new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      const conditions = ["namespace = ?", "status = 'active'", "occurred_at < ?"];
      const vals = [namespace, cutoff];
      if (agent_role) { conditions.push("agent_role = ?"); vals.push(agent_role); }

      const rows = db.prepare(
        `SELECT id FROM memories WHERE ${conditions.join(" AND ")}`
      ).all(...vals) as any[];
      entryIds = rows.map(r => r.id);
    }

    if (entryIds.length === 0) return { error: "No entries to summarize" };

    const range = db.prepare(
      `SELECT MIN(occurred_at) as date_from, MAX(occurred_at) as date_to FROM memories WHERE id IN (${entryIds.map(() => "?").join(",")})`
    ).get(...entryIds) as any;

    const ts = now();
    const sumResult = db.prepare(`
      INSERT INTO summaries (scope, namespace, agent_role, title, content, entry_count, date_from, date_to, entry_ids, created_at)
      VALUES ('project', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(namespace, agent_role || null, summary_title, summary_body, entryIds.length, range.date_from, range.date_to, JSON.stringify(entryIds), ts);

    db.prepare(
      `UPDATE memories SET status = 'summarized', updated_at = ? WHERE id IN (${entryIds.map(() => "?").join(",")})`
    ).run(ts, ...entryIds);

    return { summary_id: Number(sumResult.lastInsertRowid), entries_summarized: entryIds.length };
  })();

  if ((result as any).error) return errorResult((result as any).error);
  return jsonResult(result);
}

function memoryCleanup(db: Database.Database, args: any) {
  const olderThanDays = args.older_than_days ?? 7;
  const minEntries = args.min_entries ?? 10;
  const dryRun = args.dry_run ?? true;

  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();

  const needsSummarization = db.prepare(`
    SELECT namespace, agent_role, COUNT(*) as entry_count,
           MIN(occurred_at) as date_from, MAX(occurred_at) as date_to
    FROM memories WHERE status = 'active' AND occurred_at < ?
    GROUP BY namespace, agent_role
    HAVING COUNT(*) >= ?
  `).all(cutoff, minEntries);

  const archivalCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const needsArchival = (db.prepare(
    "SELECT COUNT(*) as c FROM memories WHERE status = 'summarized' AND updated_at < ?"
  ).get(archivalCutoff) as any).c;

  let archived = 0;
  if (!dryRun && needsArchival > 0) {
    const ts = now();
    archived = db.prepare(
      "UPDATE memories SET status = 'archived', updated_at = ? WHERE status = 'summarized' AND updated_at < ?"
    ).run(ts, archivalCutoff).changes;
  }

  return jsonResult({ needs_summarization: needsSummarization, needs_archival: needsArchival, archived, dry_run: dryRun });
}
