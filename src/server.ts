#!/usr/bin/env node --experimental-strip-types
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resolveDbPath, initDb, initVec, errorResult } from "./db.ts";
import { getDimensions } from "./embeddings.ts";
import { storeTools, handleStore } from "./tools/store.ts";
import { recallTools, handleRecall } from "./tools/recall.ts";
import { statsTools, handleStats } from "./tools/stats.ts";
import { contextTools, handleContext } from "./tools/context.ts";
import { summarizeTools, handleSummarize } from "./tools/summarize.ts";
import { documentTools, handleDocuments } from "./tools/documents.ts";
import { knowledgeTools, handleKnowledge } from "./tools/knowledge.ts";
import { episodeTools, handleEpisodes } from "./tools/episodes.ts";

// Parse CLI args
const args = process.argv.slice(2);
let dbPath: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--db" && args[i + 1]) dbPath = args[++i];
}

const db = initDb(resolveDbPath(dbPath));
initVec(db, getDimensions());

const allTools = [
  ...storeTools,
  ...recallTools,
  ...documentTools,
  ...knowledgeTools,
  ...episodeTools,
  ...contextTools,
  ...summarizeTools,
  ...statsTools,
];

const handlers: Array<(db: any, name: string, args: any) => any> = [
  handleStore, handleRecall, handleDocuments, handleKnowledge,
  handleEpisodes, handleContext, handleSummarize, handleStats,
];

const server = new Server(
  { name: "ao-memory-mcp", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: allTools,
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: input } = req.params;

  for (const handler of handlers) {
    const result = handler(db, name, input || {});
    if (result !== null) {
      // Handle async results (embed operations)
      if (result instanceof Promise) return await result;
      return result;
    }
  }

  return errorResult(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
