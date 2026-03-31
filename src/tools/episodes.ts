import type Database from "better-sqlite3";
import { now, jsonResult, errorResult } from "../db.ts";

export const episodeTools = [
  {
    name: "memory.episode.log",
    description:
      "Log a conversation turn or run event to episodic memory. Use for tracking what happened during agent runs.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string", description: "Session/run identifier" },
        namespace: { type: "string", description: "Project or scope" },
        agent_role: { type: "string", description: "Agent role" },
        role: { type: "string", enum: ["user", "assistant", "system"], description: "Message role" },
        content: { type: "string", description: "Message or event content" },
        summary: { type: "string", description: "Optional short summary" },
        metadata: { type: "object", description: "Custom metadata (e.g. tool calls, tokens used)" },
      },
      required: ["session_id", "role", "content"],
    },
  },
  {
    name: "memory.episode.list",
    description: "List episodes for a session or namespace.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string", description: "Filter by session" },
        namespace: { type: "string", description: "Filter by namespace" },
        agent_role: { type: "string", description: "Filter by agent role" },
        limit: { type: "number", description: "Max results (default 50)" },
        order: { type: "string", enum: ["newest", "oldest"], description: "Default: oldest" },
      },
    },
  },
  {
    name: "memory.episode.summarize",
    description: "Store a summary for a session. The calling agent provides the summary text.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string", description: "Session to summarize" },
        namespace: { type: "string", description: "Scope" },
        agent_role: { type: "string", description: "Agent role" },
        summary: { type: "string", description: "Summary text" },
      },
      required: ["session_id", "summary"],
    },
  },
];

export function handleEpisodes(db: Database.Database, name: string, args: any) {
  if (name === "memory.episode.log") return episodeLog(db, args);
  if (name === "memory.episode.list") return episodeList(db, args);
  if (name === "memory.episode.summarize") return episodeSummarize(db, args);
  return null;
}

function episodeLog(db: Database.Database, args: any) {
  const ts = now();
  const result = db.prepare(`
    INSERT INTO episodes (session_id, namespace, agent_role, role, content, summary, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    args.session_id, args.namespace || null, args.agent_role || null,
    args.role, args.content, args.summary || null,
    JSON.stringify(args.metadata || {}), ts
  );
  return jsonResult({ id: Number(result.lastInsertRowid), created: true });
}

function episodeList(db: Database.Database, args: any) {
  const conditions: string[] = [];
  const vals: any[] = [];
  if (args.session_id) { conditions.push("session_id = ?"); vals.push(args.session_id); }
  if (args.namespace) { conditions.push("namespace = ?"); vals.push(args.namespace); }
  if (args.agent_role) { conditions.push("agent_role = ?"); vals.push(args.agent_role); }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const order = args.order === "newest" ? "DESC" : "ASC";
  const limit = args.limit || 50;

  const rows = db.prepare(
    `SELECT * FROM episodes ${where} ORDER BY created_at ${order} LIMIT ?`
  ).all(...vals, limit);

  return jsonResult({ episodes: rows, count: rows.length });
}

function episodeSummarize(db: Database.Database, args: any) {
  // Update all episodes in the session with the summary
  const result = db.prepare(
    `UPDATE episodes SET summary = ? WHERE session_id = ? AND summary IS NULL`
  ).run(args.summary, args.session_id);

  // Also store as a memory for cross-session recall
  const ts = now();
  db.prepare(`
    INSERT INTO memories (memory_type, scope, namespace, agent_role, title, content, status, confidence, tags, metadata, created_at, occurred_at, updated_at, content_hash)
    VALUES ('episodic', 'session', ?, ?, ?, ?, 'active', 1.0, '["session_summary"]', ?, ?, ?, ?, ?)
  `).run(
    args.namespace || null, args.agent_role || null,
    `Session ${args.session_id} summary`,
    args.summary,
    JSON.stringify({ session_id: args.session_id }),
    ts, ts, ts,
    require("node:crypto").createHash("sha256").update(`episode\0${args.session_id}\0${args.summary}`).digest("hex")
  );

  return jsonResult({ episodes_updated: result.changes, session_id: args.session_id });
}
