#!/usr/bin/env node --experimental-strip-types
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resolveDbPath, initDb, errorResult } from "./db.ts";
import { storeTools, handleStore } from "./tools/store.ts";
import { recallTools, handleRecall } from "./tools/recall.ts";
import { statsTools, handleStats } from "./tools/stats.ts";
import { contextTools, handleContext } from "./tools/context.ts";
import { summarizeTools, handleSummarize } from "./tools/summarize.ts";
import { patternTools, handlePatterns } from "./tools/patterns.ts";

// Parse CLI args
const args = process.argv.slice(2);
let dbPath: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--db" && args[i + 1]) {
    dbPath = args[++i];
  }
}

const db = initDb(resolveDbPath(dbPath));

const allTools = [
  ...storeTools,
  ...recallTools,
  ...statsTools,
  ...contextTools,
  ...summarizeTools,
  ...patternTools,
];

const handlers = [handleStore, handleRecall, handleStats, handleContext, handleSummarize, handlePatterns];

const server = new Server(
  { name: "ao-memory-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: allTools,
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: input } = req.params;

  for (const handler of handlers) {
    const result = handler(db, name, input || {});
    if (result) return result;
  }

  return errorResult(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
