import type Database from "better-sqlite3";
import { isVecAvailable } from "./db.ts";

let extractor: any = null;

const DEFAULT_MODEL = "nomic-ai/nomic-embed-text-v1.5";
const NOMIC_DIMS = 768;
const MINILM_DIMS = 384;

export function getModelId(): string {
  return process.env.AO_MEMORY_MODEL || DEFAULT_MODEL;
}

function isNomicModel(): boolean {
  return getModelId().includes("nomic");
}

export function getDimensions(): number {
  return isNomicModel() ? NOMIC_DIMS : MINILM_DIMS;
}

async function getExtractor() {
  if (extractor) return extractor;
  const { pipeline } = await import("@huggingface/transformers");
  const model = getModelId();
  console.error(`[ao-memory] Loading embedding model: ${model}`);
  extractor = await pipeline("feature-extraction", model, { dtype: "q8" });
  console.error(`[ao-memory] Model ready (${getDimensions()}d)`);
  return extractor;
}

export async function embed(text: string, isQuery: boolean = false): Promise<Float32Array> {
  const ext = await getExtractor();
  const input = isNomicModel()
    ? (isQuery ? `search_query: ${text}` : `search_document: ${text}`)
    : text;
  const output = await ext(input, { pooling: "mean", normalize: true });
  return new Float32Array(output.data);
}

export function storeVector(db: Database.Database, table: string, rowid: number, embedding: Float32Array) {
  if (!isVecAvailable()) return;
  db.prepare(`INSERT OR REPLACE INTO ${table}(rowid, embedding) VALUES (?, ?)`).run(
    BigInt(rowid), Buffer.from(embedding.buffer)
  );
}

export function deleteVector(db: Database.Database, table: string, rowid: number) {
  if (!isVecAvailable()) return;
  db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(BigInt(rowid));
}

export function searchVectors(db: Database.Database, table: string, queryEmbedding: Float32Array, limit: number = 20): { rowid: number; distance: number }[] {
  if (!isVecAvailable()) return [];
  return db.prepare(
    `SELECT rowid, distance FROM ${table} WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
  ).all(Buffer.from(queryEmbedding.buffer), limit) as any[];
}

export function hybridSearch(
  db: Database.Database,
  ftsTable: string,
  vecTable: string,
  queryText: string,
  queryEmbedding: Float32Array,
  limit: number = 10,
  alpha: number = 0.5
): { rowid: number; score: number }[] {
  const RRF_K = 60;
  const scores = new Map<number, number>();

  // FTS5 keyword results
  try {
    const ftsResults = db.prepare(
      `SELECT rowid FROM ${ftsTable} WHERE ${ftsTable} MATCH ? LIMIT 30`
    ).all(queryText) as any[];

    ftsResults.forEach((r, i) => {
      const id = Number(r.rowid);
      scores.set(id, (scores.get(id) || 0) + (1 - alpha) * (1 / (RRF_K + i + 1)));
    });
  } catch {}

  // Vector similarity results
  if (isVecAvailable()) {
    const vecResults = searchVectors(db, vecTable, queryEmbedding, 30);
    vecResults.forEach((r, i) => {
      const id = Number(r.rowid);
      scores.set(id, (scores.get(id) || 0) + alpha * (1 / (RRF_K + i + 1)));
    });
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([rowid, score]) => ({ rowid, score }));
}
