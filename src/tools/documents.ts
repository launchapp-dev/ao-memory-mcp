import type Database from "better-sqlite3";
import { now, jsonResult, errorResult, chunkText } from "../db.ts";
import { embed, storeVector, deleteVector, hybridSearch } from "../embeddings.ts";

export const documentTools = [
  {
    name: "memory.doc.ingest",
    description:
      "Ingest a document into memory. Automatically chunks and embeds for semantic retrieval. Great for architecture docs, specs, READMEs, code files, or any reference material.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Document title" },
        content: { type: "string", description: "Full document content" },
        source: { type: "string", description: "File path, URL, or identifier" },
        namespace: { type: "string", description: "Project/scope for this document" },
        mime_type: { type: "string", description: "Content type (default: text/plain)" },
        chunk_size: { type: "number", description: "Max chars per chunk (default: 1000)" },
        chunk_overlap: { type: "number", description: "Overlap chars between chunks (default: 100)" },
        metadata: { type: "object", description: "Custom metadata" },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "memory.doc.search",
    description:
      "Search across ingested documents using hybrid semantic + keyword search. Returns relevant chunks with document context.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
        namespace: { type: "string", description: "Restrict to namespace" },
        limit: { type: "number", description: "Max chunks to return (default 5)" },
        alpha: { type: "number", description: "Semantic vs keyword weight (default 0.6)" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory.doc.list",
    description: "List ingested documents.",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: { type: "string", description: "Filter by namespace" },
        limit: { type: "number", description: "Max results (default 50)" },
      },
    },
  },
  {
    name: "memory.doc.get",
    description: "Get a full document by ID, including all its chunks.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Document ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "memory.doc.delete",
    description: "Delete a document and all its chunks.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Document ID" },
      },
      required: ["id"],
    },
  },
];

export function handleDocuments(db: Database.Database, name: string, args: any) {
  if (name === "memory.doc.ingest") return docIngest(db, args);
  if (name === "memory.doc.search") return docSearch(db, args);
  if (name === "memory.doc.list") return docList(db, args);
  if (name === "memory.doc.get") return docGet(db, args);
  if (name === "memory.doc.delete") return docDelete(db, args);
  return null;
}

async function docIngest(db: Database.Database, args: any) {
  const ts = now();
  const chunkSize = args.chunk_size || 1000;
  const chunkOverlap = args.chunk_overlap || 100;

  // Check for existing doc with same source
  if (args.source) {
    const existing = db.prepare("SELECT id FROM documents WHERE source = ? AND namespace IS ?").get(args.source, args.namespace || null) as any;
    if (existing) {
      // Re-ingest: delete old chunks
      const oldChunks = db.prepare("SELECT id FROM chunks WHERE document_id = ?").all(existing.id) as any[];
      for (const c of oldChunks) deleteVector(db, "vec_chunks", c.id);
      db.prepare("DELETE FROM chunks WHERE document_id = ?").run(existing.id);
      db.prepare("DELETE FROM documents WHERE id = ?").run(existing.id);
    }
  }

  const docResult = db.prepare(`
    INSERT INTO documents (namespace, title, source, mime_type, content, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    args.namespace || null, args.title, args.source || null,
    args.mime_type || "text/plain", args.content,
    JSON.stringify(args.metadata || {}), ts, ts
  );

  const docId = Number(docResult.lastInsertRowid);
  const textChunks = chunkText(args.content, chunkSize, chunkOverlap);

  const insertChunk = db.prepare(`
    INSERT INTO chunks (document_id, chunk_index, content, char_offset, char_length, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, '{}', ?)
  `);

  const chunkIds: number[] = [];
  for (let i = 0; i < textChunks.length; i++) {
    const c = textChunks[i];
    const result = insertChunk.run(docId, i, c.content, c.offset, c.content.length, ts);
    chunkIds.push(Number(result.lastInsertRowid));
  }

  // Embed all chunks
  let embedded = 0;
  for (let i = 0; i < textChunks.length; i++) {
    try {
      const embedding = await embed(textChunks[i].content);
      storeVector(db, "vec_chunks", chunkIds[i], embedding);
      embedded++;
    } catch (e) {
      console.error(`[ao-memory] Chunk embed failed:`, e);
    }
  }

  return jsonResult({ document_id: docId, chunks: textChunks.length, embedded });
}

async function docSearch(db: Database.Database, args: any) {
  const limit = args.limit || 5;
  const alpha = args.alpha ?? 0.6;

  let queryEmbedding: Float32Array;
  try {
    queryEmbedding = await embed(args.query, true);
  } catch {
    // FTS-only fallback
    const rows = db.prepare(`
      SELECT c.*, d.title as doc_title, d.source as doc_source
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.rowid
      JOIN documents d ON d.id = c.document_id
      ${args.namespace ? "WHERE d.namespace = ?" : ""}
      ORDER BY rank LIMIT ?
    `).all(...(args.namespace ? [args.namespace, limit] : [limit]));
    return jsonResult({ chunks: rows, count: rows.length, mode: "keyword_only" });
  }

  const results = hybridSearch(db, "chunks_fts", "vec_chunks", args.query, queryEmbedding, limit * 2, alpha);
  if (results.length === 0) return jsonResult({ chunks: [], count: 0 });

  const ids = results.map(r => r.rowid);
  const scoreMap = new Map(results.map(r => [r.rowid, r.score]));

  const conditions = [`c.id IN (${ids.map(() => "?").join(",")})`];
  const vals: any[] = [...ids];
  if (args.namespace) { conditions.push("d.namespace = ?"); vals.push(args.namespace); }

  const rows = db.prepare(`
    SELECT c.*, d.title as doc_title, d.source as doc_source, d.namespace as doc_namespace
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE ${conditions.join(" AND ")}
  `).all(...vals) as any[];

  const scored = rows
    .map(r => ({ ...r, _score: scoreMap.get(r.id) || 0 }))
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);

  return jsonResult({ chunks: scored, count: scored.length });
}

function docList(db: Database.Database, args: any) {
  const conditions: string[] = [];
  const vals: any[] = [];
  if (args.namespace) { conditions.push("namespace = ?"); vals.push(args.namespace); }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = args.limit || 50;

  const rows = db.prepare(`
    SELECT d.*, (SELECT COUNT(*) FROM chunks c WHERE c.document_id = d.id) as chunk_count
    FROM documents d ${where}
    ORDER BY d.created_at DESC LIMIT ?
  `).all(...vals, limit);

  return jsonResult({ documents: rows, count: rows.length });
}

function docGet(db: Database.Database, args: any) {
  const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(args.id) as any;
  if (!doc) return errorResult(`Document ${args.id} not found`);
  const chunks = db.prepare("SELECT * FROM chunks WHERE document_id = ? ORDER BY chunk_index").all(args.id);
  return jsonResult({ ...doc, chunks });
}

function docDelete(db: Database.Database, args: any) {
  const chunks = db.prepare("SELECT id FROM chunks WHERE document_id = ?").all(args.id) as any[];
  for (const c of chunks) deleteVector(db, "vec_chunks", c.id);
  db.prepare("DELETE FROM chunks WHERE document_id = ?").run(args.id);
  db.prepare("DELETE FROM documents WHERE id = ?").run(args.id);
  return jsonResult({ deleted: true, chunks_removed: chunks.length });
}
