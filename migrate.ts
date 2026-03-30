#!/usr/bin/env node --experimental-strip-types
/**
 * Migration utility: imports existing .ao/memory/*.md files into the memory database.
 *
 * Usage:
 *   node --experimental-strip-types migrate.ts [--repos-dir <path>] [--db <path>]
 *
 * Defaults:
 *   --repos-dir: scans current directory and subdirectories for .ao/memory/
 *   --db: ~/.ao/memory.db
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { resolveDbPath, initDb, contentHash, now } from "./src/db.ts";

// Parse args
const argv = process.argv.slice(2);
let reposDir = ".";
let dbPath: string | undefined;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--repos-dir" && argv[i + 1]) reposDir = argv[++i];
  if (argv[i] === "--db" && argv[i + 1]) dbPath = argv[++i];
}

const db = initDb(resolveDbPath(dbPath));

const roleToFile: Record<string, string> = {
  "planner.md": "planner",
  "product-owner.md": "product-owner",
  "reconciler.md": "reconciler",
  "reviewer.md": "reviewer",
  "qa-tester.md": "qa-tester",
};

const sectionToEntryType: Record<string, string> = {
  "tasks enqueued": "task_dispatch",
  "recently enqueued": "task_dispatch",
  "rework dispatched": "task_dispatch",
  "rebase dispatched": "task_dispatch",
  "tasks skipped": "observation",
  "capacity notes": "observation",
  "queue status": "observation",
  "pipeline health": "observation",
  "decisions": "decision",
  "tasks created": "decision",
  "features assessed": "observation",
  "gaps identified": "observation",
  "tasks unblocked": "action",
  "tasks marked done": "action",
  "queue cleaned": "action",
  "actions log": "action",
  "prs merged": "review",
  "prs with changes requested": "review",
  "prs closed": "review",
  "known patterns": "pattern",
  "log": "test_result",
  "test results": "test_result",
  "bugs filed": "test_result",
  "regressions": "test_result",
};

function guessEntryType(sectionHeader: string, agentRole: string): string {
  const lower = sectionHeader.toLowerCase();
  for (const [key, type] of Object.entries(sectionToEntryType)) {
    if (lower.includes(key)) return type;
  }
  // Fallback by role
  if (agentRole === "planner") return "task_dispatch";
  if (agentRole === "product-owner") return "decision";
  if (agentRole === "reconciler") return "action";
  if (agentRole === "reviewer") return "review";
  if (agentRole === "qa-tester") return "test_result";
  return "observation";
}

interface ParsedEntry {
  date: string;
  title: string;
  body: string;
  entryType: string;
  taskId?: string;
  prNumber?: number;
  runId?: string;
}

function parseMemoryFile(content: string, agentRole: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  const lines = content.split("\n");
  let currentSection = "";
  let currentDate = "";
  let currentBlock: string[] = [];

  function flushBlock() {
    if (currentBlock.length === 0 || !currentDate) return;
    const body = currentBlock.join("\n").trim();
    if (!body) return;

    const entryType = guessEntryType(currentSection, agentRole);
    const firstLine = currentBlock.find(l => l.trim())?.trim() || "";
    const title = firstLine.length > 120 ? firstLine.slice(0, 117) + "..." : firstLine;

    // Extract task IDs
    const taskMatch = body.match(/TASK-\d+/);
    const prMatch = body.match(/(?:PR\s*#|#)(\d+)/);
    const runMatch = body.match(/run\s+(\d+)/i);

    entries.push({
      date: currentDate,
      title: title || `${agentRole} ${entryType} ${currentDate}`,
      body,
      entryType,
      taskId: taskMatch?.[0],
      prNumber: prMatch ? parseInt(prMatch[1]) : undefined,
      runId: runMatch ? `run ${runMatch[1]}` : undefined,
    });
  }

  for (const line of lines) {
    // Section headers
    const sectionMatch = line.match(/^##\s+(.+)/);
    if (sectionMatch) {
      flushBlock();
      currentBlock = [];
      currentSection = sectionMatch[1];

      // Check if section header contains a date
      const dateInHeader = currentSection.match(/(\d{4}-\d{2}-\d{2})/);
      if (dateInHeader) currentDate = dateInHeader[1];
      continue;
    }

    // Date patterns
    const dateMatch = line.match(/\[(\d{4}-\d{2}-\d{2})\]/);
    if (dateMatch) {
      flushBlock();
      currentBlock = [];
      currentDate = dateMatch[1];
      currentBlock.push(line);
      continue;
    }

    // Separator — flush
    if (line.match(/^---\s*$/)) {
      flushBlock();
      currentBlock = [];
      continue;
    }

    currentBlock.push(line);
  }
  flushBlock();

  return entries;
}

function findMemoryDirs(rootDir: string): { project: string; memoryDir: string }[] {
  const results: { project: string; memoryDir: string }[] = [];

  // Check if rootDir itself has .ao/memory
  const directMemory = join(rootDir, ".ao", "memory");
  if (existsSync(directMemory) && statSync(directMemory).isDirectory()) {
    results.push({ project: basename(rootDir), memoryDir: directMemory });
  }

  // Scan subdirectories
  try {
    for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const memDir = join(rootDir, entry.name, ".ao", "memory");
      if (existsSync(memDir) && statSync(memDir).isDirectory()) {
        results.push({ project: entry.name, memoryDir: memDir });
      }
    }
  } catch {}

  return results;
}

// Main
const ts = now();
const memoryDirs = findMemoryDirs(reposDir);
const summary: Record<string, Record<string, number>> = {};
let totalImported = 0;
let totalSkipped = 0;

const insert = db.prepare(`
  INSERT INTO memory_entries (entry_type, agent_role, project, title, body, task_id, pr_number, run_id, status, tags, metadata, created_at, occurred_at, updated_at, content_hash)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', '[]', '{}', ?, ?, ?, ?)
`);

const checkHash = db.prepare("SELECT id FROM memory_entries WHERE content_hash = ?");

const importAll = db.transaction(() => {
  for (const { project, memoryDir } of memoryDirs) {
    summary[project] = {};
    try {
      for (const file of readdirSync(memoryDir)) {
        const agentRole = roleToFile[file];
        if (!agentRole) continue;

        const content = readFileSync(join(memoryDir, file), "utf-8");
        const entries = parseMemoryFile(content, agentRole);

        let count = 0;
        for (const entry of entries) {
          const hash = contentHash(entry.entryType, agentRole, project, entry.title, entry.body);
          if (checkHash.get(hash)) {
            totalSkipped++;
            continue;
          }

          insert.run(
            entry.entryType, agentRole, project,
            entry.title, entry.body,
            entry.taskId || null, entry.prNumber || null, entry.runId || null,
            ts, entry.date + "T00:00:00.000Z", ts, hash
          );
          count++;
          totalImported++;
        }
        summary[project][agentRole] = count;
      }
    } catch (err) {
      console.error(`Error processing ${project}: ${err}`);
    }
  }
});

importAll();

// Print results
console.log("\n=== Migration Complete ===\n");
console.log(`Scanned: ${memoryDirs.length} projects with .ao/memory/`);
console.log(`Imported: ${totalImported} entries`);
console.log(`Skipped (duplicates): ${totalSkipped}\n`);

const roles = [...new Set(Object.values(summary).flatMap(s => Object.keys(s)))].sort();
const header = ["Project", ...roles, "Total"].map(h => h.padEnd(16)).join(" | ");
console.log(header);
console.log("-".repeat(header.length));

for (const [project, counts] of Object.entries(summary).sort()) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const row = [project, ...roles.map(r => String(counts[r] || 0)), String(total)]
    .map(v => v.padEnd(16))
    .join(" | ");
  console.log(row);
}

console.log(`\nDatabase: ${resolveDbPath(dbPath)}`);
