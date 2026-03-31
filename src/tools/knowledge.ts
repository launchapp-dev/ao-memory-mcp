import type Database from "better-sqlite3";
import { now, jsonResult, errorResult } from "../db.js";

export const knowledgeTools = [
  {
    name: "memory.entity.add",
    description:
      "Add an entity to the knowledge graph. Entities represent projects, people, technologies, concepts, files, or any named thing.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Entity name (e.g. 'ao-cli', 'React', 'Sami')" },
        entity_type: { type: "string", description: "Type (e.g. project, person, technology, concept, file, service)" },
        namespace: { type: "string", description: "Scope" },
        description: { type: "string", description: "Brief description" },
        metadata: { type: "object", description: "Custom metadata" },
      },
      required: ["name", "entity_type"],
    },
  },
  {
    name: "memory.entity.link",
    description:
      "Create a relationship between two entities. E.g. 'ao-cli uses Rust', 'invoicer depends_on Drizzle'.",
    inputSchema: {
      type: "object" as const,
      properties: {
        source: { type: "string", description: "Source entity name" },
        source_type: { type: "string", description: "Source entity type (for disambiguation)" },
        relation: { type: "string", description: "Relation type (e.g. uses, depends_on, created_by, part_of, related_to)" },
        target: { type: "string", description: "Target entity name" },
        target_type: { type: "string", description: "Target entity type" },
        weight: { type: "number", description: "Relation strength 0.0-1.0 (default 1.0)" },
        memory_id: { type: "number", description: "Link to a memory entry as evidence" },
        namespace: { type: "string", description: "Scope for auto-creating entities" },
        metadata: { type: "object", description: "Custom metadata" },
      },
      required: ["source", "source_type", "relation", "target", "target_type"],
    },
  },
  {
    name: "memory.entity.query",
    description:
      "Query the knowledge graph. Find entities and traverse relationships. Supports multi-hop traversal.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Entity name to start from" },
        entity_type: { type: "string", description: "Filter by entity type" },
        relation: { type: "string", description: "Filter by relation type" },
        direction: { type: "string", enum: ["outgoing", "incoming", "both"], description: "Traversal direction (default: both)" },
        depth: { type: "number", description: "Max traversal depth (default 1, max 3)" },
        namespace: { type: "string", description: "Filter by namespace" },
        limit: { type: "number", description: "Max results (default 50)" },
      },
    },
  },
  {
    name: "memory.entity.list",
    description: "List entities in the knowledge graph.",
    inputSchema: {
      type: "object" as const,
      properties: {
        entity_type: { type: "string", description: "Filter by type" },
        namespace: { type: "string", description: "Filter by namespace" },
        limit: { type: "number", description: "Max results (default 50)" },
      },
    },
  },
];

export function handleKnowledge(db: Database.Database, name: string, args: any) {
  if (name === "memory.entity.add") return entityAdd(db, args);
  if (name === "memory.entity.link") return entityLink(db, args);
  if (name === "memory.entity.query") return entityQuery(db, args);
  if (name === "memory.entity.list") return entityList(db, args);
  return null;
}

function getOrCreateEntity(db: Database.Database, name: string, entityType: string, namespace?: string): number {
  const existing = db.prepare(
    "SELECT id FROM entities WHERE name = ? AND entity_type = ? AND namespace IS ?"
  ).get(name, entityType, namespace || null) as any;

  if (existing) return existing.id;

  const ts = now();
  const result = db.prepare(`
    INSERT INTO entities (name, entity_type, namespace, metadata, created_at, updated_at)
    VALUES (?, ?, ?, '{}', ?, ?)
  `).run(name, entityType, namespace || null, ts, ts);

  return Number(result.lastInsertRowid);
}

function entityAdd(db: Database.Database, args: any) {
  const ts = now();
  const existing = db.prepare(
    "SELECT id FROM entities WHERE name = ? AND entity_type = ? AND namespace IS ?"
  ).get(args.name, args.entity_type, args.namespace || null) as any;

  if (existing) {
    // Update existing
    const sets: string[] = ["updated_at = ?"];
    const vals: any[] = [ts];
    if (args.description) { sets.push("description = ?"); vals.push(args.description); }
    if (args.metadata) { sets.push("metadata = ?"); vals.push(JSON.stringify(args.metadata)); }
    vals.push(existing.id);
    db.prepare(`UPDATE entities SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    return jsonResult({ id: existing.id, updated: true });
  }

  const result = db.prepare(`
    INSERT INTO entities (name, entity_type, namespace, description, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    args.name, args.entity_type, args.namespace || null,
    args.description || null, JSON.stringify(args.metadata || {}), ts, ts
  );

  return jsonResult({ id: Number(result.lastInsertRowid), created: true });
}

function entityLink(db: Database.Database, args: any) {
  const sourceId = getOrCreateEntity(db, args.source, args.source_type, args.namespace);
  const targetId = getOrCreateEntity(db, args.target, args.target_type, args.namespace);

  const existing = db.prepare(
    "SELECT id FROM relations WHERE source_entity_id = ? AND relation_type = ? AND target_entity_id = ?"
  ).get(sourceId, args.relation, targetId) as any;

  if (existing) {
    // Update weight/metadata
    const sets: string[] = [];
    const vals: any[] = [];
    if (args.weight !== undefined) { sets.push("weight = ?"); vals.push(args.weight); }
    if (args.memory_id) { sets.push("memory_id = ?"); vals.push(args.memory_id); }
    if (args.metadata) { sets.push("metadata = ?"); vals.push(JSON.stringify(args.metadata)); }
    if (sets.length > 0) {
      vals.push(existing.id);
      db.prepare(`UPDATE relations SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    }
    return jsonResult({ id: existing.id, updated: true });
  }

  const ts = now();
  const result = db.prepare(`
    INSERT INTO relations (source_entity_id, relation_type, target_entity_id, weight, memory_id, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(sourceId, args.relation, targetId, args.weight ?? 1.0, args.memory_id || null, JSON.stringify(args.metadata || {}), ts);

  return jsonResult({ id: Number(result.lastInsertRowid), created: true, source_id: sourceId, target_id: targetId });
}

function entityQuery(db: Database.Database, args: any) {
  const depth = Math.min(args.depth || 1, 3);
  const limit = args.limit || 50;
  const direction = args.direction || "both";

  // Find starting entities
  const startConditions: string[] = [];
  const startVals: any[] = [];
  if (args.name) { startConditions.push("name = ?"); startVals.push(args.name); }
  if (args.entity_type) { startConditions.push("entity_type = ?"); startVals.push(args.entity_type); }
  if (args.namespace) { startConditions.push("namespace = ?"); startVals.push(args.namespace); }

  if (startConditions.length === 0) {
    return errorResult("At least one of: name, entity_type, or namespace required");
  }

  const startEntities = db.prepare(
    `SELECT * FROM entities WHERE ${startConditions.join(" AND ")} LIMIT ?`
  ).all(...startVals, limit) as any[];

  if (startEntities.length === 0) return jsonResult({ entities: [], relations: [] });

  // Traverse relations
  const visited = new Set<number>();
  const allEntities: any[] = [...startEntities];
  const allRelations: any[] = [];
  let currentIds = startEntities.map(e => e.id);
  startEntities.forEach(e => visited.add(e.id));

  for (let d = 0; d < depth; d++) {
    if (currentIds.length === 0) break;
    const placeholders = currentIds.map(() => "?").join(",");

    const relConditions: string[] = [];
    if (direction === "outgoing" || direction === "both") {
      relConditions.push(`source_entity_id IN (${placeholders})`);
    }
    if (direction === "incoming" || direction === "both") {
      relConditions.push(`target_entity_id IN (${placeholders})`);
    }

    const relFilter = args.relation ? ` AND relation_type = ?` : "";
    const relVals = args.relation
      ? [...currentIds, ...(direction === "both" ? currentIds : []), args.relation]
      : [...currentIds, ...(direction === "both" ? currentIds : [])];

    const rels = db.prepare(`
      SELECT r.*,
        se.name as source_name, se.entity_type as source_type,
        te.name as target_name, te.entity_type as target_type
      FROM relations r
      JOIN entities se ON se.id = r.source_entity_id
      JOIN entities te ON te.id = r.target_entity_id
      WHERE (${relConditions.join(" OR ")})${relFilter}
      LIMIT ?
    `).all(...relVals, limit) as any[];

    allRelations.push(...rels);

    const nextIds: number[] = [];
    for (const rel of rels) {
      for (const id of [rel.source_entity_id, rel.target_entity_id]) {
        if (!visited.has(id)) {
          visited.add(id);
          nextIds.push(id);
        }
      }
    }

    if (nextIds.length > 0) {
      const ents = db.prepare(
        `SELECT * FROM entities WHERE id IN (${nextIds.map(() => "?").join(",")})`
      ).all(...nextIds) as any[];
      allEntities.push(...ents);
    }

    currentIds = nextIds;
  }

  return jsonResult({ entities: allEntities, relations: allRelations });
}

function entityList(db: Database.Database, args: any) {
  const conditions: string[] = [];
  const vals: any[] = [];
  if (args.entity_type) { conditions.push("entity_type = ?"); vals.push(args.entity_type); }
  if (args.namespace) { conditions.push("namespace = ?"); vals.push(args.namespace); }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = args.limit || 50;

  const rows = db.prepare(`SELECT * FROM entities ${where} ORDER BY name LIMIT ?`).all(...vals, limit);
  return jsonResult({ entities: rows, count: rows.length });
}
