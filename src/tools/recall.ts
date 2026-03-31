import type Database from "better-sqlite3";
import { jsonResult, errorResult, touchAccess } from "../db.js";
import { embed, hybridSearch, searchVectors } from "../embeddings.js";

export const recallTools = [
  {
    name: "memory.recall",
    description:
      "Recall memories with structured filters. Supports filtering by type, scope, namespace, agent role, tags, date range. Returns entries sorted by date.",
    inputSchema: {
      type: "object" as const,
      properties: {
        memory_type: { type: "string", enum: ["semantic", "episodic", "procedural"], description: "Filter by type" },
        scope: { type: "string", description: "Filter by scope" },
        namespace: { type: "string", description: "Filter by namespace (project name, etc.)" },
        agent_role: { type: "string", description: "Filter by agent role" },
        task_id: { type: "string", description: "Filter by task ID" },
        status: { type: "string", enum: ["active", "summarized", "archived"], description: "Default: active" },
        date_from: { type: "string", description: "From ISO date" },
        date_to: { type: "string", description: "To ISO date" },
        tags: { type: "array", items: { type: "string" }, description: "Must have ALL specified tags" },
        limit: { type: "number", description: "Max results (default 50)" },
        offset: { type: "number", description: "Pagination offset" },
        order: { type: "string", enum: ["newest", "oldest", "most_accessed", "highest_confidence"], description: "Sort order" },
      },
    },
  },
  {
    name: "memory.search",
    description:
      "Hybrid semantic + keyword search across all memories. Uses vector similarity and FTS5 together for best results.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Natural language search query" },
        memory_type: { type: "string", description: "Restrict to type" },
        namespace: { type: "string", description: "Restrict to namespace" },
        agent_role: { type: "string", description: "Restrict to agent role" },
        status: { type: "string", description: "Restrict to status" },
        limit: { type: "number", description: "Max results (default 10)" },
        alpha: { type: "number", description: "Semantic vs keyword weight: 0=all keyword, 1=all semantic (default 0.5)" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory.get",
    description: "Get a single memory by ID. Updates access tracking.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Memory ID" },
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

  conditions.push("status = ?"); vals.push(args.status || "active");
  if (args.memory_type) { conditions.push("memory_type = ?"); vals.push(args.memory_type); }
  if (args.scope) { conditions.push("scope = ?"); vals.push(args.scope); }
  if (args.namespace) { conditions.push("namespace = ?"); vals.push(args.namespace); }
  if (args.agent_role) { conditions.push("agent_role = ?"); vals.push(args.agent_role); }
  if (args.task_id) { conditions.push("task_id = ?"); vals.push(args.task_id); }
  if (args.date_from) { conditions.push("occurred_at >= ?"); vals.push(args.date_from); }
  if (args.date_to) { conditions.push("occurred_at <= ?"); vals.push(args.date_to); }
  if (args.tags?.length) {
    for (const tag of args.tags) {
      conditions.push("EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value = ?)");
      vals.push(tag);
    }
  }

  const orderMap: Record<string, string> = {
    newest: "occurred_at DESC",
    oldest: "occurred_at ASC",
    most_accessed: "access_count DESC",
    highest_confidence: "confidence DESC",
  };
  const order = orderMap[args.order || "newest"] || "occurred_at DESC";
  const limit = args.limit || 50;
  const offset = args.offset || 0;

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.prepare(
    `SELECT * FROM memories ${where} ORDER BY ${order} LIMIT ? OFFSET ?`
  ).all(...vals, limit, offset);

  return jsonResult({ memories: rows, count: rows.length });
}

async function memorySearch(db: Database.Database, args: any) {
  const limit = args.limit || 10;
  const alpha = args.alpha ?? 0.5;

  // Get embedding for query
  let queryEmbedding: Float32Array;
  try {
    queryEmbedding = await embed(args.query, true);
  } catch {
    // Fallback to FTS-only
    return ftsOnlySearch(db, args);
  }

  const results = hybridSearch(db, "memories_fts", "vec_memories", args.query, queryEmbedding, limit * 3, alpha);

  if (results.length === 0) return jsonResult({ memories: [], count: 0 });

  // Fetch full rows and apply filters
  const ids = results.map(r => r.rowid);
  const scoreMap = new Map(results.map(r => [r.rowid, r.score]));

  const conditions: string[] = [`id IN (${ids.map(() => "?").join(",")})`];
  const vals: any[] = [...ids];

  if (args.memory_type) { conditions.push("memory_type = ?"); vals.push(args.memory_type); }
  if (args.namespace) { conditions.push("namespace = ?"); vals.push(args.namespace); }
  if (args.agent_role) { conditions.push("agent_role = ?"); vals.push(args.agent_role); }
  if (args.status) { conditions.push("status = ?"); vals.push(args.status); }

  const rows = db.prepare(
    `SELECT * FROM memories WHERE ${conditions.join(" AND ")}`
  ).all(...vals) as any[];

  // Sort by hybrid score and limit
  const scored = rows
    .map(r => ({ ...r, _score: scoreMap.get(r.id) || 0 }))
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);

  // Touch access for returned results
  for (const row of scored) touchAccess(db, row.id);

  return jsonResult({ memories: scored, count: scored.length });
}

function ftsOnlySearch(db: Database.Database, args: any) {
  const limit = args.limit || 10;
  const rows = db.prepare(`
    SELECT m.*, snippet(memories_fts, 0, '<mark>', '</mark>', '...', 32) as title_snippet,
           snippet(memories_fts, 1, '<mark>', '</mark>', '...', 64) as content_snippet
    FROM memories_fts f
    JOIN memories m ON m.id = f.rowid
    WHERE memories_fts MATCH ?
    ORDER BY rank LIMIT ?
  `).all(args.query, limit);

  return jsonResult({ memories: rows, count: rows.length, mode: "keyword_only" });
}

function memoryGet(db: Database.Database, args: any) {
  const entry = db.prepare("SELECT * FROM memories WHERE id = ?").get(args.id) as any;
  if (!entry) return errorResult(`Memory ${args.id} not found`);
  touchAccess(db, args.id);
  return jsonResult(entry);
}
