import type Database from "better-sqlite3";
import { contentHash, now, jsonResult, errorResult } from "../db.ts";

export const storeTools = [
  {
    name: "memory.store",
    description:
      "Store a new memory entry. Deduplicates via content hash — returns existing entry if duplicate detected.",
    inputSchema: {
      type: "object" as const,
      properties: {
        entry_type: { type: "string", description: "Type of memory (e.g. decision, observation, task_dispatch, test_result, review, action)" },
        agent_role: { type: "string", description: "Agent role that produced this memory (e.g. planner, reviewer, qa-tester)" },
        project: { type: "string", description: "Project/repo name" },
        title: { type: "string", description: "Short summary line" },
        body: { type: "string", description: "Full markdown content" },
        task_id: { type: "string", description: "Task ID reference (e.g. TASK-051)" },
        pr_number: { type: "number", description: "PR number if applicable" },
        run_id: { type: "string", description: "Run identifier (e.g. run 51)" },
        tags: { type: "array", items: { type: "string" }, description: "Tags for categorization" },
        metadata: { type: "object", description: "Entry-type-specific metadata" },
        occurred_at: { type: "string", description: "ISO 8601 date when event occurred (defaults to now)" },
      },
      required: ["entry_type", "agent_role", "project", "title", "body"],
    },
  },
  {
    name: "memory.update",
    description: "Update an existing memory entry by ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Memory entry ID" },
        title: { type: "string", description: "New title" },
        body: { type: "string", description: "New body" },
        status: { type: "string", enum: ["active", "summarized", "archived"], description: "New status" },
        tags: { type: "array", items: { type: "string" }, description: "New tags" },
        metadata: { type: "object", description: "Metadata to merge" },
      },
      required: ["id"],
    },
  },
  {
    name: "memory.archive",
    description: "Bulk archive entries by filter. At least one filter required.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ids: { type: "array", items: { type: "number" }, description: "Specific entry IDs to archive" },
        agent_role: { type: "string", description: "Archive all active entries for this role" },
        project: { type: "string", description: "Archive all active entries for this project" },
        before: { type: "string", description: "Archive entries with occurred_at before this ISO date" },
      },
    },
  },
];

export function handleStore(db: Database.Database, name: string, args: any) {
  if (name === "memory.store") return memoryStore(db, args);
  if (name === "memory.update") return memoryUpdate(db, args);
  if (name === "memory.archive") return memoryArchive(db, args);
  return null;
}

function memoryStore(db: Database.Database, args: any) {
  const { entry_type, agent_role, project, title, body } = args;
  const hash = contentHash(entry_type, agent_role, project, title, body);

  const existing = db.prepare("SELECT id FROM memory_entries WHERE content_hash = ?").get(hash) as any;
  if (existing) {
    return jsonResult({ duplicate: true, existing_id: existing.id });
  }

  const ts = now();
  const result = db.prepare(`
    INSERT INTO memory_entries (entry_type, agent_role, project, title, body, task_id, pr_number, run_id, status, tags, metadata, created_at, occurred_at, updated_at, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
  `).run(
    entry_type,
    agent_role,
    project,
    title,
    body,
    args.task_id || null,
    args.pr_number || null,
    args.run_id || null,
    JSON.stringify(args.tags || []),
    JSON.stringify(args.metadata || {}),
    ts,
    args.occurred_at || ts,
    ts,
    hash
  );

  return jsonResult({ id: result.lastInsertRowid, created: true });
}

function memoryUpdate(db: Database.Database, args: any) {
  const { id, ...updates } = args;

  const entry = db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(id) as any;
  if (!entry) return errorResult(`Entry ${id} not found`);

  const sets: string[] = [];
  const vals: any[] = [];

  if (updates.title !== undefined) { sets.push("title = ?"); vals.push(updates.title); }
  if (updates.body !== undefined) { sets.push("body = ?"); vals.push(updates.body); }
  if (updates.status !== undefined) {
    sets.push("status = ?"); vals.push(updates.status);
    if (updates.status === "archived") { sets.push("archived_at = ?"); vals.push(now()); }
  }
  if (updates.tags !== undefined) { sets.push("tags = ?"); vals.push(JSON.stringify(updates.tags)); }
  if (updates.metadata !== undefined) {
    const merged = { ...JSON.parse(entry.metadata), ...updates.metadata };
    sets.push("metadata = ?"); vals.push(JSON.stringify(merged));
  }

  if (sets.length === 0) return errorResult("No fields to update");

  sets.push("updated_at = ?"); vals.push(now());

  if (updates.title !== undefined || updates.body !== undefined) {
    const newTitle = updates.title || entry.title;
    const newBody = updates.body || entry.body;
    const hash = contentHash(entry.entry_type, entry.agent_role, entry.project, newTitle, newBody);
    sets.push("content_hash = ?"); vals.push(hash);
  }

  vals.push(id);
  db.prepare(`UPDATE memory_entries SET ${sets.join(", ")} WHERE id = ?`).run(...vals);

  return jsonResult({ id, updated: true });
}

function memoryArchive(db: Database.Database, args: any) {
  const { ids, agent_role, project, before } = args;

  if (!ids && !agent_role && !project && !before) {
    return errorResult("At least one filter required");
  }

  const conditions: string[] = ["status = 'active'"];
  const vals: any[] = [];

  if (ids?.length) {
    conditions.push(`id IN (${ids.map(() => "?").join(",")})`);
    vals.push(...ids);
  }
  if (agent_role) { conditions.push("agent_role = ?"); vals.push(agent_role); }
  if (project) { conditions.push("project = ?"); vals.push(project); }
  if (before) { conditions.push("occurred_at < ?"); vals.push(before); }

  const ts = now();
  const result = db.prepare(
    `UPDATE memory_entries SET status = 'archived', archived_at = ?, updated_at = ? WHERE ${conditions.join(" AND ")}`
  ).run(ts, ts, ...vals);

  return jsonResult({ archived_count: result.changes });
}
