import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

export function contentHash(
  entryType: string,
  agentRole: string,
  project: string,
  title: string,
  body: string
): string {
  return createHash("sha256")
    .update(`${entryType}\0${agentRole}\0${project}\0${title}\0${body}`)
    .digest("hex");
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
