import type Database from "better-sqlite3";
import { now, jsonResult, errorResult } from "../db.ts";

export const patternTools = [
  {
    name: "memory.patterns.detect",
    description:
      "Scan for recurring patterns across projects. Finds entries with similar titles or matching tags that appear in multiple projects.",
    inputSchema: {
      type: "object" as const,
      properties: {
        min_occurrences: { type: "number", description: "Minimum projects to count as a pattern (default 2)" },
        entry_type: { type: "string", description: "Restrict to entry type" },
        limit: { type: "number", description: "Max patterns to return (default 10)" },
      },
    },
  },
  {
    name: "memory.patterns.record",
    description:
      "Create or update a confirmed cross-project pattern.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Existing pattern ID to update (omit to create new)" },
        pattern_type: { type: "string", description: "Type (e.g. bug_pattern, process_pattern, architectural_pattern, anti_pattern)" },
        title: { type: "string", description: "Pattern name" },
        description: { type: "string", description: "Full description" },
        projects: { type: "array", items: { type: "string" }, description: "Projects where pattern appears" },
        agent_roles: { type: "array", items: { type: "string" }, description: "Roles that reported it" },
        entry_ids: { type: "array", items: { type: "number" }, description: "Memory entry IDs as evidence" },
        status: { type: "string", enum: ["active", "resolved", "archived"], description: "Pattern status" },
      },
      required: ["pattern_type", "title", "description"],
    },
  },
  {
    name: "memory.patterns.list",
    description: "List known cross-project patterns.",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: { type: "string", enum: ["active", "resolved", "archived", "all"], description: "Filter by status (default: active)" },
        pattern_type: { type: "string", description: "Filter by pattern type" },
        project: { type: "string", description: "Filter patterns involving this project" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
    },
  },
];

export function handlePatterns(db: Database.Database, name: string, args: any) {
  if (name === "memory.patterns.detect") return patternsDetect(db, args);
  if (name === "memory.patterns.record") return patternsRecord(db, args);
  if (name === "memory.patterns.list") return patternsList(db, args);
  return null;
}

function patternsDetect(db: Database.Database, args: any) {
  const minOccurrences = args.min_occurrences ?? 2;
  const limit = args.limit ?? 10;

  // Find tags that appear across multiple projects
  const tagCondition = args.entry_type ? "AND e.entry_type = ?" : "";
  const tagVals = args.entry_type ? [args.entry_type] : [];

  const tagPatterns = db.prepare(`
    SELECT t.value as tag, COUNT(DISTINCT e.project) as project_count,
           GROUP_CONCAT(DISTINCT e.project) as projects,
           COUNT(*) as total_entries
    FROM memory_entries e, json_each(e.tags) t
    WHERE e.status = 'active' ${tagCondition}
    GROUP BY t.value
    HAVING COUNT(DISTINCT e.project) >= ?
    ORDER BY project_count DESC
    LIMIT ?
  `).all(...tagVals, minOccurrences, limit);

  // Find similar titles across projects using FTS5
  const titlePatterns = db.prepare(`
    SELECT e1.title, COUNT(DISTINCT e1.project) as project_count,
           GROUP_CONCAT(DISTINCT e1.project) as projects,
           COUNT(*) as total_entries
    FROM memory_entries e1
    WHERE e1.status = 'active' ${tagCondition}
    GROUP BY e1.title
    HAVING COUNT(DISTINCT e1.project) >= ?
    ORDER BY project_count DESC
    LIMIT ?
  `).all(...tagVals, minOccurrences, limit);

  return jsonResult({
    tag_patterns: tagPatterns,
    title_patterns: titlePatterns,
  });
}

function patternsRecord(db: Database.Database, args: any) {
  const ts = now();

  if (args.id) {
    const existing = db.prepare("SELECT * FROM memory_patterns WHERE id = ?").get(args.id) as any;
    if (!existing) return errorResult(`Pattern ${args.id} not found`);

    const sets: string[] = [];
    const vals: any[] = [];

    if (args.pattern_type) { sets.push("pattern_type = ?"); vals.push(args.pattern_type); }
    if (args.title) { sets.push("title = ?"); vals.push(args.title); }
    if (args.description) { sets.push("description = ?"); vals.push(args.description); }
    if (args.projects) { sets.push("projects = ?"); vals.push(JSON.stringify(args.projects)); }
    if (args.agent_roles) { sets.push("agent_roles = ?"); vals.push(JSON.stringify(args.agent_roles)); }
    if (args.entry_ids) { sets.push("entry_ids = ?"); vals.push(JSON.stringify(args.entry_ids)); }
    if (args.status) {
      sets.push("status = ?"); vals.push(args.status);
      if (args.status === "resolved") { sets.push("resolved_at = ?"); vals.push(ts); }
    }

    sets.push("last_seen = ?"); vals.push(ts);
    sets.push("updated_at = ?"); vals.push(ts);
    sets.push("occurrence_count = occurrence_count + 1");

    vals.push(args.id);
    db.prepare(`UPDATE memory_patterns SET ${sets.join(", ")} WHERE id = ?`).run(...vals);

    return jsonResult({ id: args.id, updated: true });
  }

  const result = db.prepare(`
    INSERT INTO memory_patterns (pattern_type, title, description, projects, agent_roles, entry_ids, occurrence_count, status, first_seen, last_seen, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?, ?)
  `).run(
    args.pattern_type,
    args.title,
    args.description,
    JSON.stringify(args.projects || []),
    JSON.stringify(args.agent_roles || []),
    JSON.stringify(args.entry_ids || []),
    ts, ts, ts, ts
  );

  return jsonResult({ id: result.lastInsertRowid, created: true });
}

function patternsList(db: Database.Database, args: any) {
  const conditions: string[] = [];
  const vals: any[] = [];
  const status = args.status || "active";

  if (status !== "all") { conditions.push("status = ?"); vals.push(status); }
  if (args.pattern_type) { conditions.push("pattern_type = ?"); vals.push(args.pattern_type); }
  if (args.project) {
    conditions.push("EXISTS (SELECT 1 FROM json_each(projects) WHERE json_each.value = ?)");
    vals.push(args.project);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = args.limit || 20;

  const rows = db.prepare(
    `SELECT * FROM memory_patterns ${where} ORDER BY last_seen DESC LIMIT ?`
  ).all(...vals, limit);

  return jsonResult({ patterns: rows, count: rows.length });
}
