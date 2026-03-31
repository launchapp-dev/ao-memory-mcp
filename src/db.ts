import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let vecLoaded = false;

export function resolveDbPath(cliDbPath?: string): string {
  if (cliDbPath) return cliDbPath;
  if (process.env.AO_MEMORY_DB) return process.env.AO_MEMORY_DB;
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  const aoDir = join(home, ".ao");
  mkdirSync(aoDir, { recursive: true });
  return join(aoDir, "memory.db");
}

export function initDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
  db.exec(schema);
  return db;
}

export async function initVec(db: Database.Database, dimensions: number) {
  if (vecLoaded) return;
  try {
    const sqliteVec = await import("sqlite-vec");
    const load = sqliteVec.load || sqliteVec.default?.load;
    if (load) load(db);
    vecLoaded = true;
  } catch (e) {
    console.error("[ao-memory] sqlite-vec not available, vector search disabled");
    return;
  }

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
      embedding float[${dimensions}] distance_metric=cosine
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
      embedding float[${dimensions}] distance_metric=cosine
    );
  `);
}

export function isVecAvailable(): boolean {
  return vecLoaded;
}

export function contentHash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

export function now(): string {
  return new Date().toISOString();
}

export function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

export function touchAccess(db: Database.Database, id: number) {
  db.prepare("UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?").run(now(), id);
}

export function chunkText(text: string, maxChars: number = 1000, overlap: number = 100): { content: string; offset: number }[] {
  if (text.length <= maxChars) {
    return [{ content: text, offset: 0 }];
  }

  const chunks: { content: string; offset: number }[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + maxChars, text.length);

    if (end < text.length) {
      const paraBreak = text.lastIndexOf("\n\n", end);
      if (paraBreak > offset + maxChars * 0.3) end = paraBreak + 2;
      else {
        const sentBreak = text.lastIndexOf(". ", end);
        if (sentBreak > offset + maxChars * 0.3) end = sentBreak + 2;
      }
    }

    chunks.push({ content: text.slice(offset, end).trim(), offset });
    offset = end - overlap;
    if (offset >= text.length) break;
  }

  return chunks.filter(c => c.content.length > 0);
}
