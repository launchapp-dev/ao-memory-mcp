import type Database from "better-sqlite3";
import { jsonResult } from "../db.ts";

export const statsTools = [
  {
    name: "memory.stats",
    description:
      "Get aggregate statistics about memory entries. Optionally filter by project or agent role.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: { type: "string", description: "Filter by project" },
        agent_role: { type: "string", description: "Filter by agent role" },
      },
    },
  },
];

export function handleStats(db: Database.Database, name: string, args: any) {
  if (name === "memory.stats") return memoryStats(db, args);
  return null;
}

function memoryStats(db: Database.Database, args: any) {
  const conditions: string[] = [];
  const vals: any[] = [];

  if (args.project) { conditions.push("project = ?"); vals.push(args.project); }
  if (args.agent_role) { conditions.push("agent_role = ?"); vals.push(args.agent_role); }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const total = (db.prepare(`SELECT COUNT(*) as count FROM memory_entries ${where}`).get(...vals) as any).count;

  const byType = db.prepare(
    `SELECT entry_type, COUNT(*) as count FROM memory_entries ${where} GROUP BY entry_type ORDER BY count DESC`
  ).all(...vals);

  const byStatus = db.prepare(
    `SELECT status, COUNT(*) as count FROM memory_entries ${where} GROUP BY status ORDER BY count DESC`
  ).all(...vals);

  const byRole = db.prepare(
    `SELECT agent_role, COUNT(*) as count FROM memory_entries ${where} GROUP BY agent_role ORDER BY count DESC`
  ).all(...vals);

  const byProject = db.prepare(
    `SELECT project, COUNT(*) as count FROM memory_entries ${where} GROUP BY project ORDER BY count DESC`
  ).all(...vals);

  const dateRange = db.prepare(
    `SELECT MIN(occurred_at) as oldest, MAX(occurred_at) as newest FROM memory_entries ${where}`
  ).get(...vals) as any;

  const summaryCount = (db.prepare(
    `SELECT COUNT(*) as count FROM memory_summaries ${where.replace("entry_type", "entry_type")}`
  ).get(...vals) as any).count;

  const patternCount = (db.prepare(
    `SELECT COUNT(*) as count FROM memory_patterns WHERE status = 'active'`
  ).get() as any).count;

  return jsonResult({
    total_entries: total,
    total_summaries: summaryCount,
    active_patterns: patternCount,
    oldest_entry: dateRange?.oldest,
    newest_entry: dateRange?.newest,
    by_type: byType,
    by_status: byStatus,
    by_role: byRole,
    by_project: byProject,
  });
}
