import type Database from "better-sqlite3";
import { jsonResult } from "../db.ts";

export const contextTools = [
  {
    name: "memory.context",
    description:
      "Agent boot tool — call at the start of each run to load relevant memory. Returns recent entries, active decisions, cross-project patterns, summaries, and a summarization_needed flag.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_role: { type: "string", description: "Agent role requesting context" },
        project: { type: "string", description: "Project the agent is working on" },
        limit: { type: "number", description: "Max entries per section (default 10)" },
      },
      required: ["agent_role", "project"],
    },
  },
];

export function handleContext(db: Database.Database, name: string, args: any) {
  if (name === "memory.context") return memoryContext(db, args);
  return null;
}

function memoryContext(db: Database.Database, args: any) {
  const { agent_role, project } = args;
  const limit = args.limit || 10;

  const recentEntries = db.prepare(`
    SELECT * FROM memory_entries
    WHERE agent_role = ? AND project = ? AND status = 'active'
    ORDER BY occurred_at DESC LIMIT ?
  `).all(agent_role, project, limit);

  const activeDecisions = db.prepare(`
    SELECT * FROM memory_entries
    WHERE project = ? AND entry_type = 'decision' AND status = 'active'
    ORDER BY occurred_at DESC LIMIT ?
  `).all(project, limit);

  const activePatterns = db.prepare(`
    SELECT * FROM memory_patterns
    WHERE status = 'active'
      AND EXISTS (SELECT 1 FROM json_each(projects) WHERE json_each.value = ?)
    ORDER BY last_seen DESC LIMIT ?
  `).all(project, limit);

  const recentSummaries = db.prepare(`
    SELECT * FROM memory_summaries
    WHERE agent_role = ? AND project = ?
    ORDER BY created_at DESC LIMIT 5
  `).all(agent_role, project);

  const crossProjectAlerts = db.prepare(`
    SELECT * FROM memory_patterns
    WHERE status = 'active' AND occurrence_count >= 3
    ORDER BY last_seen DESC LIMIT 5
  `).all();

  // Check if summarization is needed: 20+ active entries older than 3 days
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const staleCount = (db.prepare(`
    SELECT COUNT(*) as count FROM memory_entries
    WHERE agent_role = ? AND project = ? AND status = 'active' AND occurred_at < ?
  `).get(agent_role, project, threeDaysAgo) as any).count;

  return jsonResult({
    recent_entries: recentEntries,
    active_decisions: activeDecisions,
    active_patterns: activePatterns,
    recent_summaries: recentSummaries,
    cross_project_alerts: crossProjectAlerts,
    summarization_needed: staleCount >= 20,
    stale_entry_count: staleCount,
  });
}
