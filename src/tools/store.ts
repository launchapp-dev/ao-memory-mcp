import type Database from "better-sqlite3";
import { contentHash, now, jsonResult, errorResult, touchAccess } from "../db.js";
import { embed, storeVector, deleteVector } from "../embeddings.js";

export const storeTools = [
  {
    name: "memory.remember",
    description:
      "Store a new memory. Automatically embeds for semantic search. Deduplicates via content hash. Supports semantic (facts/knowledge), episodic (events/history), and procedural (how-to/workflows) types.",
    inputSchema: {
      type: "object" as const,
      properties: {
        memory_type: { type: "string", enum: ["semantic", "episodic", "procedural"], description: "Type: semantic (facts), episodic (events), procedural (how-to)" },
        title: { type: "string", description: "Short summary" },
        content: { type: "string", description: "Full content (markdown)" },
        scope: { type: "string", enum: ["global", "user", "project", "session"], description: "Scope (default: project)" },
        namespace: { type: "string", description: "Scope identifier — project name, user id, session id" },
        agent_role: { type: "string", description: "Agent role storing this memory" },
        task_id: { type: "string", description: "Task ID reference" },
        pr_number: { type: "number", description: "PR number" },
        run_id: { type: "string", description: "Run identifier" },
        tags: { type: "array", items: { type: "string" }, description: "Tags" },
        metadata: { type: "object", description: "Custom metadata" },
        confidence: { type: "number", description: "Confidence score 0.0-1.0 (default 1.0)" },
        occurred_at: { type: "string", description: "ISO 8601 date (default: now)" },
      },
      required: ["memory_type", "title", "content"],
    },
  },
  {
    name: "memory.update",
    description: "Update an existing memory by ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Memory ID" },
        title: { type: "string" },
        content: { type: "string" },
        status: { type: "string", enum: ["active", "summarized", "archived"] },
        confidence: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
        metadata: { type: "object" },
        superseded_by: { type: "number", description: "ID of memory that replaces this one" },
      },
      required: ["id"],
    },
  },
  {
    name: "memory.forget",
    description: "Archive memories. Soft delete — they remain queryable with status filter.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ids: { type: "array", items: { type: "number" }, description: "Specific IDs to archive" },
        agent_role: { type: "string", description: "Archive all for this role" },
        namespace: { type: "string", description: "Archive all in this namespace" },
        before: { type: "string", description: "Archive entries before this ISO date" },
      },
    },
  },
];

export function handleStore(db: Database.Database, name: string, args: any) {
  if (name === "memory.remember") return memoryRemember(db, args);
  if (name === "memory.update") return memoryUpdate(db, args);
  if (name === "memory.forget") return memoryForget(db, args);
  return null;
}

async function memoryRemember(db: Database.Database, args: any) {
  const { memory_type, title, content } = args;
  const scope = args.scope || "project";
  const hash = contentHash(memory_type, scope, args.namespace || "", title, content);

  const existing = db.prepare("SELECT id FROM memories WHERE content_hash = ?").get(hash) as any;
  if (existing) {
    touchAccess(db, existing.id);
    return jsonResult({ duplicate: true, existing_id: existing.id });
  }

  const ts = now();
  const result = db.prepare(`
    INSERT INTO memories (memory_type, scope, namespace, agent_role, title, content, task_id, pr_number, run_id, status, confidence, tags, metadata, created_at, occurred_at, updated_at, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    memory_type, scope, args.namespace || null, args.agent_role || null,
    title, content,
    args.task_id || null, args.pr_number || null, args.run_id || null,
    args.confidence ?? 1.0,
    JSON.stringify(args.tags || []), JSON.stringify(args.metadata || {}),
    ts, args.occurred_at || ts, ts, hash
  );

  const id = Number(result.lastInsertRowid);

  // Embed asynchronously
  try {
    const embedding = await embed(`${title}\n${content}`);
    storeVector(db, "vec_memories", id, embedding);
  } catch (e) {
    console.error(`[ao-memory] Embedding failed for memory ${id}:`, e);
  }

  return jsonResult({ id, created: true });
}

async function memoryUpdate(db: Database.Database, args: any) {
  const { id, ...updates } = args;
  const entry = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as any;
  if (!entry) return errorResult(`Memory ${id} not found`);

  const sets: string[] = [];
  const vals: any[] = [];

  if (updates.title !== undefined) { sets.push("title = ?"); vals.push(updates.title); }
  if (updates.content !== undefined) { sets.push("content = ?"); vals.push(updates.content); }
  if (updates.status !== undefined) { sets.push("status = ?"); vals.push(updates.status); }
  if (updates.confidence !== undefined) { sets.push("confidence = ?"); vals.push(updates.confidence); }
  if (updates.superseded_by !== undefined) { sets.push("superseded_by = ?"); vals.push(updates.superseded_by); }
  if (updates.tags !== undefined) { sets.push("tags = ?"); vals.push(JSON.stringify(updates.tags)); }
  if (updates.metadata !== undefined) {
    const merged = { ...JSON.parse(entry.metadata), ...updates.metadata };
    sets.push("metadata = ?"); vals.push(JSON.stringify(merged));
  }

  if (sets.length === 0) return errorResult("No fields to update");
  sets.push("updated_at = ?"); vals.push(now());

  if (updates.title !== undefined || updates.content !== undefined) {
    const newTitle = updates.title || entry.title;
    const newContent = updates.content || entry.content;
    const hash = contentHash(entry.memory_type, entry.scope, entry.namespace || "", newTitle, newContent);
    sets.push("content_hash = ?"); vals.push(hash);

    // Re-embed
    try {
      const embedding = await embed(`${newTitle}\n${newContent}`);
      storeVector(db, "vec_memories", id, embedding);
    } catch {}
  }

  vals.push(id);
  db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...vals);

  return jsonResult({ id, updated: true });
}

function memoryForget(db: Database.Database, args: any) {
  const { ids, agent_role, namespace, before } = args;
  if (!ids && !agent_role && !namespace && !before) {
    return errorResult("At least one filter required");
  }

  const conditions: string[] = ["status = 'active'"];
  const vals: any[] = [];

  if (ids?.length) { conditions.push(`id IN (${ids.map(() => "?").join(",")})`); vals.push(...ids); }
  if (agent_role) { conditions.push("agent_role = ?"); vals.push(agent_role); }
  if (namespace) { conditions.push("namespace = ?"); vals.push(namespace); }
  if (before) { conditions.push("occurred_at < ?"); vals.push(before); }

  const ts = now();
  const result = db.prepare(
    `UPDATE memories SET status = 'archived', updated_at = ? WHERE ${conditions.join(" AND ")}`
  ).run(ts, ...vals);

  return jsonResult({ archived_count: result.changes });
}
