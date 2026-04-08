# ao-memory-mcp

Cognitive memory MCP server for AI agents — semantic search, document RAG, knowledge graph, episodic memory, and hybrid retrieval.

Built on [SQLite](https://www.sqlite.org/) + [sqlite-vec](https://github.com/asg017/sqlite-vec) with local embeddings via [@huggingface/transformers](https://huggingface.co/docs/transformers.js). No external APIs required. Persistent, offline, and fast.

## Features

- **Semantic memory** — store and retrieve facts, decisions, and how-to knowledge with hybrid vector + keyword search
- **Document RAG** — ingest docs, specs, and READMEs; automatically chunked and embedded for retrieval
- **Knowledge graph** — entities and typed relations with multi-hop traversal
- **Episodic memory** — conversation turn logging and session summarization
- **Agent context boot** — single call loads all relevant memory for an agent at run start
- **Memory lifecycle** — summarization and archival to keep context fresh

## Installation

```bash
npm install -g @launchapp-dev/ao-memory-mcp
```

Or use directly with `npx`:

```bash
npx @launchapp-dev/ao-memory-mcp
```

## MCP Server Setup

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "ao-memory": {
      "command": "npx",
      "args": ["-y", "@launchapp-dev/ao-memory-mcp"]
    }
  }
}
```

With a custom database path:

```json
{
  "mcpServers": {
    "ao-memory": {
      "command": "npx",
      "args": ["-y", "@launchapp-dev/ao-memory-mcp", "--db", "/path/to/memory.db"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project or `~/.cursor/mcp.json` globally:

```json
{
  "mcpServers": {
    "ao-memory": {
      "command": "npx",
      "args": ["-y", "@launchapp-dev/ao-memory-mcp"]
    }
  }
}
```

### VS Code (Copilot)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "ao-memory": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@launchapp-dev/ao-memory-mcp"]
    }
  }
}
```

### CLI / Custom Integrations

The server communicates over stdio (MCP standard transport):

```bash
# Default DB at ~/.ao/memory.db
ao-memory-mcp

# Custom DB path
ao-memory-mcp --db /path/to/memory.db
```

## Integration with Animus CLI

[Animus](https://github.com/launchapp-dev/ao-cli) (the `ao` CLI, v0.3.0+) uses `ao-memory-mcp` as its default memory backend. Configure it in your `.ao/config.yaml`:

```yaml
mcp_servers:
  - name: memory
    transport: stdio
    command: ao-memory-mcp
    args: ["--db", "~/.ao/memory.db"]
```

Or with the HTTP transport for shared team memory:

```yaml
mcp_servers:
  - name: memory
    transport: http
    url: http://localhost:3100/mcp
```

Agents can then call `memory.context` at boot to load all relevant knowledge for their namespace before starting work.

## Database Location

By default the SQLite database is stored at `~/.ao/memory.db`. Override with the `--db` flag or by setting `AO_MEMORY_DB` environment variable.

---

## API Reference

Tools are grouped by capability. All tools follow the [MCP tool call](https://spec.modelcontextprotocol.io/specification/server/tools/) protocol.

---

### Core Memory

#### `memory.remember`

Store a new memory. Automatically embedded for semantic search. Deduplicates via content hash.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `memory_type` | `"semantic" \| "episodic" \| "procedural"` | Yes | `semantic` = facts/knowledge, `episodic` = events, `procedural` = how-to |
| `title` | string | Yes | Short summary |
| `content` | string | Yes | Full content (markdown supported) |
| `scope` | `"global" \| "user" \| "project" \| "session"` | No | Default: `project` |
| `namespace` | string | No | Project name, user ID, or session ID |
| `agent_role` | string | No | Agent role storing this memory |
| `task_id` | string | No | Task ID reference |
| `pr_number` | number | No | PR number |
| `run_id` | string | No | Run identifier |
| `tags` | string[] | No | Tags for filtering |
| `metadata` | object | No | Custom metadata |
| `confidence` | number | No | Confidence score 0.0–1.0 (default 1.0) |
| `occurred_at` | string | No | ISO 8601 timestamp (default: now) |

```json
{
  "memory_type": "procedural",
  "title": "Always run biome check before pushing",
  "content": "Run `npx biome check .` on the full repo before any push. CI checks all 179 files — running on a subdirectory misses errors in neighboring components.",
  "namespace": "ao-cloud",
  "agent_role": "ts-engineer",
  "tags": ["ci", "biome"]
}
```

**Returns:** `{ id: number, created: true }` or `{ duplicate: true, existing_id: number }`

---

#### `memory.recall`

Structured filter-based recall. Returns entries sorted by date (or custom order).

| Parameter | Type | Description |
|-----------|------|-------------|
| `memory_type` | string | Filter by `semantic`, `episodic`, or `procedural` |
| `scope` | string | Filter by scope |
| `namespace` | string | Filter by namespace |
| `agent_role` | string | Filter by agent role |
| `task_id` | string | Filter by task ID |
| `status` | string | `active` (default), `summarized`, or `archived` |
| `date_from` | string | ISO date lower bound |
| `date_to` | string | ISO date upper bound |
| `tags` | string[] | Must match ALL specified tags |
| `limit` | number | Max results (default 50) |
| `offset` | number | Pagination offset |
| `order` | string | `newest` (default), `oldest`, `most_accessed`, `highest_confidence` |

```json
{
  "memory_type": "procedural",
  "namespace": "ao-cloud",
  "order": "most_accessed",
  "limit": 10
}
```

**Returns:** `{ memories: Memory[], count: number }`

---

#### `memory.search`

Hybrid semantic + keyword search. Uses vector similarity (FTS5) and falls back to keyword-only if embeddings are unavailable.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Natural language search query |
| `memory_type` | string | No | Restrict to type |
| `namespace` | string | No | Restrict to namespace |
| `agent_role` | string | No | Restrict to agent role |
| `status` | string | No | Restrict to status |
| `limit` | number | No | Max results (default 10) |
| `alpha` | number | No | Semantic vs keyword weight: 0 = all keyword, 1 = all semantic (default 0.5) |

```json
{
  "query": "how to handle biome lint errors in CI",
  "namespace": "ao-cloud",
  "limit": 5
}
```

**Returns:** `{ memories: Memory[], count: number }`

---

#### `memory.get`

Get a single memory by ID. Updates access tracking.

```json
{ "id": 42 }
```

**Returns:** Full memory object.

---

#### `memory.update`

Update an existing memory by ID.

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | number | **Required.** Memory ID |
| `title` | string | New title |
| `content` | string | New content (re-embeds automatically) |
| `status` | string | `active`, `summarized`, or `archived` |
| `confidence` | number | Updated confidence score |
| `tags` | string[] | Replacement tags |
| `metadata` | object | Merged into existing metadata |
| `superseded_by` | number | ID of the memory that replaces this one |

```json
{ "id": 42, "confidence": 0.9, "tags": ["ci", "biome", "resolved"] }
```

**Returns:** `{ id: number, updated: true }`

---

#### `memory.forget`

Soft-delete memories (archived, not deleted). Still queryable with `status: "archived"`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `ids` | number[] | Specific IDs to archive |
| `agent_role` | string | Archive all for this agent role |
| `namespace` | string | Archive all in this namespace |
| `before` | string | Archive entries before this ISO date |

At least one filter is required.

```json
{ "namespace": "old-project", "before": "2025-01-01T00:00:00Z" }
```

**Returns:** `{ archived_count: number }`

---

### Document RAG

#### `memory.doc.ingest`

Ingest a document. Automatically chunked and embedded for semantic retrieval. Re-ingesting the same `source` replaces the previous version.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Document title |
| `content` | string | Yes | Full document content |
| `source` | string | No | File path, URL, or identifier (used for dedup) |
| `namespace` | string | No | Project/scope |
| `mime_type` | string | No | Content type (default: `text/plain`) |
| `chunk_size` | number | No | Max chars per chunk (default 1000) |
| `chunk_overlap` | number | No | Overlap between chunks (default 100) |
| `metadata` | object | No | Custom metadata |

```json
{
  "title": "ao-cloud Architecture",
  "content": "# ao-cloud\n\nao-cloud is a managed daemon execution service...",
  "source": "docs/architecture.md",
  "namespace": "ao-cloud"
}
```

**Returns:** `{ document_id: number, chunks: number, embedded: number }`

---

#### `memory.doc.search`

Search across ingested documents using hybrid semantic + keyword search. Returns relevant chunks with document context.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query |
| `namespace` | string | No | Restrict to namespace |
| `limit` | number | No | Max chunks to return (default 5) |
| `alpha` | number | No | Semantic vs keyword weight (default 0.6) |

```json
{ "query": "authentication middleware session tokens", "namespace": "ao-cloud" }
```

**Returns:** `{ chunks: Chunk[], count: number }`

---

#### `memory.doc.list`

List ingested documents.

```json
{ "namespace": "ao-cloud", "limit": 20 }
```

**Returns:** `{ documents: Document[], count: number }` — includes `chunk_count` per document.

---

#### `memory.doc.get`

Get a full document by ID, including all chunks.

```json
{ "id": 7 }
```

**Returns:** Document object with `chunks` array.

---

#### `memory.doc.delete`

Delete a document and all its chunks.

```json
{ "id": 7 }
```

**Returns:** `{ deleted: true, chunks_removed: number }`

---

### Knowledge Graph

#### `memory.entity.add`

Add an entity to the knowledge graph. Upserts on `(name, entity_type, namespace)`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Entity name (e.g. `"ao-cli"`, `"React"`) |
| `entity_type` | string | Yes | Type (e.g. `project`, `person`, `technology`, `concept`, `file`, `service`) |
| `namespace` | string | No | Scope |
| `description` | string | No | Brief description |
| `metadata` | object | No | Custom metadata |

```json
{
  "name": "ao-cli",
  "entity_type": "project",
  "namespace": "ao-ecosystem",
  "description": "Core orchestrator engine — 16-crate Rust workspace"
}
```

**Returns:** `{ id: number, created: true }` or `{ id: number, updated: true }`

---

#### `memory.entity.link`

Create a typed relationship between two entities. Upserts on `(source, relation, target)`. Auto-creates entities if they don't exist.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source` | string | Yes | Source entity name |
| `source_type` | string | Yes | Source entity type |
| `relation` | string | Yes | Relation type (e.g. `uses`, `depends_on`, `created_by`, `part_of`) |
| `target` | string | Yes | Target entity name |
| `target_type` | string | Yes | Target entity type |
| `weight` | number | No | Relation strength 0.0–1.0 (default 1.0) |
| `memory_id` | number | No | Link to a memory entry as evidence |
| `namespace` | string | No | Scope for auto-creating entities |
| `metadata` | object | No | Custom metadata |

```json
{
  "source": "ao-cloud",
  "source_type": "project",
  "relation": "uses",
  "target": "Better Auth",
  "target_type": "technology",
  "namespace": "ao-ecosystem"
}
```

**Returns:** `{ id: number, created: true, source_id: number, target_id: number }`

---

#### `memory.entity.query`

Query the knowledge graph. Find entities and traverse relationships with multi-hop support.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Entity name to start from |
| `entity_type` | string | Filter by entity type |
| `relation` | string | Filter by relation type |
| `direction` | `"outgoing" \| "incoming" \| "both"` | Traversal direction (default: `both`) |
| `depth` | number | Max traversal depth (default 1, max 3) |
| `namespace` | string | Filter by namespace |
| `limit` | number | Max results (default 50) |

At least one of `name`, `entity_type`, or `namespace` is required.

```json
{
  "name": "ao-cloud",
  "entity_type": "project",
  "depth": 2,
  "direction": "outgoing"
}
```

**Returns:** `{ entities: Entity[], relations: Relation[] }`

---

#### `memory.entity.list`

List entities in the knowledge graph.

```json
{ "entity_type": "technology", "namespace": "ao-ecosystem" }
```

**Returns:** `{ entities: Entity[], count: number }`

---

### Episodic Memory

#### `memory.episode.log`

Log a conversation turn or run event to episodic memory.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | Yes | Session/run identifier |
| `role` | `"user" \| "assistant" \| "system"` | Yes | Message role |
| `content` | string | Yes | Message or event content |
| `namespace` | string | No | Project or scope |
| `agent_role` | string | No | Agent role |
| `summary` | string | No | Optional short summary |
| `metadata` | object | No | Custom metadata (e.g. tool calls, token counts) |

```json
{
  "session_id": "run-abc123",
  "namespace": "ao-cloud",
  "agent_role": "ts-engineer",
  "role": "assistant",
  "content": "Fixed the biome lint error in CommandPalette.tsx by replacing role=listbox with a native select element.",
  "metadata": { "task_id": "TASK-187" }
}
```

**Returns:** `{ id: number, created: true }`

---

#### `memory.episode.list`

List episodes for a session or namespace.

| Parameter | Type | Description |
|-----------|------|-------------|
| `session_id` | string | Filter by session |
| `namespace` | string | Filter by namespace |
| `agent_role` | string | Filter by agent role |
| `limit` | number | Max results (default 50) |
| `order` | `"newest" \| "oldest"` | Default: `oldest` |

```json
{ "session_id": "run-abc123", "order": "oldest" }
```

**Returns:** `{ episodes: Episode[], count: number }`

---

#### `memory.episode.summarize`

Store a summary for a completed session. Also creates a cross-session recall entry in the core memory store.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | Yes | Session to summarize |
| `summary` | string | Yes | Summary text |
| `namespace` | string | No | Scope |
| `agent_role` | string | No | Agent role |

```json
{
  "session_id": "run-abc123",
  "namespace": "ao-cloud",
  "agent_role": "ts-engineer",
  "summary": "Fixed 3 biome lint errors (TASK-187): replaced role=listbox in CommandPalette with native select, removed non-null assertion, added tabIndex to focusable div."
}
```

**Returns:** `{ episodes_updated: number, session_id: string }`

---

### Agent Context

#### `memory.context`

Agent boot tool. Call at the start of each run to load all relevant memory. Returns recent memories, knowledge, procedures, entities, episode summaries, document count, and global memories for the given namespace.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `namespace` | string | Yes | Project/scope to load context for |
| `agent_role` | string | No | Agent role (narrows recent memories to this role) |
| `limit` | number | No | Max entries per section (default 10) |

```json
{
  "namespace": "ao-cloud",
  "agent_role": "ts-engineer",
  "limit": 15
}
```

**Returns:**

```json
{
  "recent_memories": [...],
  "knowledge": [...],
  "procedures": [...],
  "entities": [...],
  "episode_summaries": [...],
  "global_memories": [...],
  "document_count": 12,
  "total_active_memories": 47,
  "summarization_needed": false,
  "stale_entry_count": 3
}
```

When `summarization_needed` is `true` (≥20 stale entries), call `memory.summarize` before proceeding.

---

### Summarization & Lifecycle

#### `memory.summarize`

Create a summary of memory entries. The calling agent provides the summary text. Transitions summarized entries to `"summarized"` status.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `namespace` | string | Yes | Namespace to summarize |
| `summary_title` | string | Yes | Summary title |
| `summary_body` | string | Yes | Summary content (markdown) |
| `agent_role` | string | No | Agent role |
| `before` | string | No | Summarize entries before this ISO date (default: 3 days ago) |
| `entry_ids` | number[] | No | Specific IDs to summarize |

```json
{
  "namespace": "ao-cloud",
  "agent_role": "ts-engineer",
  "summary_title": "ao-cloud DS migration sweep #201-205",
  "summary_body": "Completed design system migration for CommandPalette, NotificationBell, and settings page. Fixed 12 biome errors across 3 components. All CI checks pass.",
  "before": "2026-04-01T00:00:00Z"
}
```

**Returns:** `{ summary_id: number, entries_summarized: number }`

---

#### `memory.cleanup`

Identify stale entries that need summarization, or archive old summarized entries.

| Parameter | Type | Description |
|-----------|------|-------------|
| `older_than_days` | number | Entries older than N days (default 7) |
| `min_entries` | number | Min entries per scope to flag (default 10) |
| `dry_run` | boolean | Preview only — default `true` |

```json
{ "older_than_days": 14, "dry_run": false }
```

**Returns:** `{ needs_summarization: [...], needs_archival: number, archived: number, dry_run: boolean }`

---

### Stats

#### `memory.stats`

Get aggregate statistics across all memory types.

```json
{ "namespace": "ao-cloud" }
```

**Returns:**

```json
{
  "memories": {
    "total": 312,
    "by_type": [...],
    "by_status": [...],
    "by_scope": [...],
    "by_role": [...],
    "by_namespace": [...],
    "oldest": "2025-10-01T00:00:00Z",
    "newest": "2026-04-08T12:00:00Z"
  },
  "documents": { "total": 14, "total_chunks": 287 },
  "knowledge_graph": { "entities": 38, "relations": 62 },
  "episodes": { "total": 1204 }
}
```

---

## Migration from Markdown Memory Files

If you have existing `.ao/memory/*.md` files (from earlier AO versions), import them into the database:

```bash
node --experimental-strip-types migrate.ts \
  --repos-dir /path/to/your/repos \
  --db ~/.ao/memory.db
```

The migration script:
- Scans subdirectories for `.ao/memory/` folders
- Parses `planner.md`, `product-owner.md`, `reconciler.md`, `reviewer.md`, `qa-tester.md`
- Deduplicates via content hash (safe to re-run)
- Prints a per-project import summary

---

## Architecture

```
ao-memory-mcp
├── src/
│   ├── server.ts        # MCP server entry point
│   ├── db.ts            # SQLite init, helpers, chunking
│   ├── embeddings.ts    # Local embeddings + hybrid search
│   ├── schema.sql       # Database schema
│   └── tools/
│       ├── store.ts     # memory.remember / update / forget
│       ├── recall.ts    # memory.recall / search / get
│       ├── documents.ts # memory.doc.*
│       ├── knowledge.ts # memory.entity.*
│       ├── episodes.ts  # memory.episode.*
│       ├── context.ts   # memory.context
│       ├── summarize.ts # memory.summarize / cleanup
│       └── stats.ts     # memory.stats
```

**Storage:** Single SQLite file with `sqlite-vec` extension for vector search and FTS5 for keyword search.

**Embeddings:** Local inference via `@huggingface/transformers` — no API key, no network calls. First run downloads the model (~20MB) and caches it locally.

**Hybrid search:** Combines cosine similarity (vector) and BM25 rank (FTS5) using a weighted `alpha` parameter.

---

## License

ELv2 — see [LICENSE](LICENSE).
