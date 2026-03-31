import type Database from "better-sqlite3";
import { jsonResult } from "../db.js";

export const statsTools = [
  {
    name: "memory.stats",
    description: "Get aggregate statistics across all memory types.",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: { type: "string", description: "Filter by namespace" },
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
  if (args.namespace) { conditions.push("namespace = ?"); vals.push(args.namespace); }
  if (args.agent_role) { conditions.push("agent_role = ?"); vals.push(args.agent_role); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const totalMemories = (db.prepare(`SELECT COUNT(*) as c FROM memories ${where}`).get(...vals) as any).c;
  const byType = db.prepare(`SELECT memory_type, COUNT(*) as count FROM memories ${where} GROUP BY memory_type`).all(...vals);
  const byStatus = db.prepare(`SELECT status, COUNT(*) as count FROM memories ${where} GROUP BY status`).all(...vals);
  const byScope = db.prepare(`SELECT scope, COUNT(*) as count FROM memories ${where} GROUP BY scope`).all(...vals);
  const byRole = db.prepare(`SELECT agent_role, COUNT(*) as count FROM memories ${where} GROUP BY agent_role`).all(...vals);
  const byNamespace = db.prepare(`SELECT namespace, COUNT(*) as count FROM memories ${where} GROUP BY namespace ORDER BY count DESC LIMIT 20`).all(...vals);

  const dateRange = db.prepare(`SELECT MIN(occurred_at) as oldest, MAX(occurred_at) as newest FROM memories ${where}`).get(...vals) as any;

  const totalDocs = (db.prepare("SELECT COUNT(*) as c FROM documents").get() as any).c;
  const totalChunks = (db.prepare("SELECT COUNT(*) as c FROM chunks").get() as any).c;
  const totalEntities = (db.prepare("SELECT COUNT(*) as c FROM entities").get() as any).c;
  const totalRelations = (db.prepare("SELECT COUNT(*) as c FROM relations").get() as any).c;
  const totalEpisodes = (db.prepare("SELECT COUNT(*) as c FROM episodes").get() as any).c;

  return jsonResult({
    memories: { total: totalMemories, by_type: byType, by_status: byStatus, by_scope: byScope, by_role: byRole, by_namespace: byNamespace, oldest: dateRange?.oldest, newest: dateRange?.newest },
    documents: { total: totalDocs, total_chunks: totalChunks },
    knowledge_graph: { entities: totalEntities, relations: totalRelations },
    episodes: { total: totalEpisodes },
  });
}
