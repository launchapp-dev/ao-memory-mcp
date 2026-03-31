import type Database from "better-sqlite3";
import { jsonResult } from "../db.ts";

export const contextTools = [
  {
    name: "memory.context",
    description:
      "Agent boot tool — call at the start of each run to load all relevant memory. Returns recent memories, active decisions, related entities, episode summaries, and document count. Scoped by namespace and agent role.",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: { type: "string", description: "Project/scope to load context for" },
        agent_role: { type: "string", description: "Agent role requesting context" },
        limit: { type: "number", description: "Max entries per section (default 10)" },
      },
      required: ["namespace"],
    },
  },
];

export function handleContext(db: Database.Database, name: string, args: any) {
  if (name === "memory.context") return memoryContext(db, args);
  return null;
}

function memoryContext(db: Database.Database, args: any) {
  const { namespace, agent_role } = args;
  const limit = args.limit || 10;

  // Recent memories for this agent+namespace
  const recentMemories = db.prepare(`
    SELECT * FROM memories
    WHERE namespace = ? ${agent_role ? "AND agent_role = ?" : ""}
      AND status = 'active'
    ORDER BY occurred_at DESC LIMIT ?
  `).all(...(agent_role ? [namespace, agent_role, limit] : [namespace, limit]));

  // Active semantic memories (facts/knowledge) for this namespace
  const knowledge = db.prepare(`
    SELECT * FROM memories
    WHERE namespace = ? AND memory_type = 'semantic' AND status = 'active'
    ORDER BY confidence DESC, access_count DESC LIMIT ?
  `).all(namespace, limit);

  // Active procedural memories (how-to) for this namespace
  const procedures = db.prepare(`
    SELECT * FROM memories
    WHERE namespace = ? AND memory_type = 'procedural' AND status = 'active'
    ORDER BY access_count DESC LIMIT ?
  `).all(namespace, limit);

  // Related entities
  const entities = db.prepare(`
    SELECT e.*, (SELECT COUNT(*) FROM relations r WHERE r.source_entity_id = e.id OR r.target_entity_id = e.id) as relation_count
    FROM entities e
    WHERE e.namespace = ?
    ORDER BY relation_count DESC LIMIT ?
  `).all(namespace, limit);

  // Recent episode summaries
  const episodeSummaries = db.prepare(`
    SELECT DISTINCT session_id, summary, MAX(created_at) as last_at
    FROM episodes
    WHERE namespace = ? AND summary IS NOT NULL
    GROUP BY session_id
    ORDER BY last_at DESC LIMIT 5
  `).all(namespace);

  // Document count
  const docCount = (db.prepare(
    "SELECT COUNT(*) as count FROM documents WHERE namespace = ?"
  ).get(namespace) as any).count;

  // Global memories (cross-project)
  const globalMemories = db.prepare(`
    SELECT * FROM memories
    WHERE scope = 'global' AND status = 'active'
    ORDER BY confidence DESC, occurred_at DESC LIMIT 5
  `).all();

  // Check if summarization needed
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const staleCount = (db.prepare(`
    SELECT COUNT(*) as count FROM memories
    WHERE namespace = ? ${agent_role ? "AND agent_role = ?" : ""}
      AND status = 'active' AND occurred_at < ?
  `).get(...(agent_role ? [namespace, agent_role, threeDaysAgo] : [namespace, threeDaysAgo])) as any).count;

  // Stats
  const totalMemories = (db.prepare(
    "SELECT COUNT(*) as count FROM memories WHERE namespace = ? AND status = 'active'"
  ).get(namespace) as any).count;

  return jsonResult({
    recent_memories: recentMemories,
    knowledge,
    procedures,
    entities,
    episode_summaries: episodeSummaries,
    global_memories: globalMemories,
    document_count: docCount,
    total_active_memories: totalMemories,
    summarization_needed: staleCount >= 20,
    stale_entry_count: staleCount,
  });
}
