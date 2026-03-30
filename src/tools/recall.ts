import type Database from "better-sqlite3";
import { jsonResult, errorResult } from "../db.ts";

export const recallTools = [
  {
    name: "memory.recall",
    description:
      "Query memory entries with structured filters. Returns entries sorted by date. Default: 50 most recent active entries.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_role: { type: "string", description: "Filter by agent role" },
        project: { type: "string", description: "Filter by project" },
        entry_type: { type: "string", description: "Filter by entry type" },
        task_id: { type: "string", description: "Filter by task ID" },
        status: { type: "string", enum: ["active", "summarized", "archived"], description: "Filter by status (default: active)" },
        date_from: { type: "string", description: "Entries from this ISO date" },
        date_to: { type: "string", description: "Entries up to this ISO date" },
        tags: { type: "array", items: { type: "string" }, description: "Filter by tags (must have ALL specified)" },
        limit: { type: "number", description: "Max results (default 50)" },
        offset: { type: "number", description: "Pagination offset (default 0)" },
        order: { type: "string", enum: ["newest", "oldest"], description: "Sort order (default: newest)" },
      },
    },
  },
  {
    name: "memory.search",
    description:
      "Full-text search across all memory entries. Uses FTS5 for fast matching.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (supports FTS5 syntax)" },
        agent_role: { type: "string", description: "Restrict to agent role" },
        project: { type: "string", description: "Restrict to project" },
        entry_type: { type: "string", description: "Restrict to entry type" },
        status: { type: "string", description: "Restrict to status" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory.get",
    description: "Get a single memory entry by ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Memory entry ID" },
      },
      required: ["id"],
    },
  },
];

export function handleRecall(db: Database.Database, name: string, args: any) {
  if (name === "memory.recall") return memoryRecall(db, args);
  if (name === "memory.search") return memorySearch(db, args);
  if (name === "memory.get") return memoryGet(db, args);
  return null;
}

function memoryRecall(db: Database.Database, args: any) {
  const conditions: string[] = [];
  const vals: any[] = [];
  const status = args.status || "active";

  conditions.push("status = ?"); vals.push(status);
  if (args.agent_role) { conditions.push("agent_role = ?"); vals.push(args.agent_role); }
  if (args.project) { conditions.push("project = ?"); vals.push(args.project); }
  if (args.entry_type) { conditions.push("entry_type = ?"); vals.push(args.entry_type); }
  if (args.task_id) { conditions.push("task_id = ?"); vals.push(args.task_id); }
  if (args.date_from) { conditions.push("occurred_at >= ?"); vals.push(args.date_from); }
  if (args.date_to) { conditions.push("occurred_at <= ?"); vals.push(args.date_to); }

  if (args.tags?.length) {
    for (const tag of args.tags) {
      conditions.push("EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value = ?)");
      vals.push(tag);
    }
  }

  const order = args.order === "oldest" ? "ASC" : "DESC";
  const limit = args.limit || 50;
  const offset = args.offset || 0;

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.prepare(
    `SELECT * FROM memory_entries ${where} ORDER BY occurred_at ${order} LIMIT ? OFFSET ?`
  ).all(...vals, limit, offset);

  return jsonResult({ entries: rows, count: rows.length });
}

function memorySearch(db: Database.Database, args: any) {
  const conditions: string[] = [];
  const vals: any[] = [];

  if (args.agent_role) { conditions.push("e.agent_role = ?"); vals.push(args.agent_role); }
  if (args.project) { conditions.push("e.project = ?"); vals.push(args.project); }
  if (args.entry_type) { conditions.push("e.entry_type = ?"); vals.push(args.entry_type); }
  if (args.status) { conditions.push("e.status = ?"); vals.push(args.status); }

  const extraWhere = conditions.length ? `AND ${conditions.join(" AND ")}` : "";
  const limit = args.limit || 20;

  const rows = db.prepare(`
    SELECT e.*, snippet(memory_fts, 0, '<mark>', '</mark>', '...', 32) as title_snippet,
           snippet(memory_fts, 1, '<mark>', '</mark>', '...', 64) as body_snippet
    FROM memory_fts f
    JOIN memory_entries e ON e.id = f.rowid
    WHERE memory_fts MATCH ? ${extraWhere}
    ORDER BY rank
    LIMIT ?
  `).all(args.query, ...vals, limit);

  return jsonResult({ entries: rows, count: rows.length });
}

function memoryGet(db: Database.Database, args: any) {
  const entry = db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(args.id);
  if (!entry) return errorResult(`Entry ${args.id} not found`);
  return jsonResult(entry);
}
