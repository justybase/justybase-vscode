/**
 * Identifier-only catalog for offline completion replays.
 *
 * A replay catalog holds table/column names, primary-key flags and declared
 * foreign-key references, nothing else (no data, types or hosts). The provider
 * answers the completion engine's metadata questions from it, including the
 * cached JOIN targets that drive the `0_1_` catalog-FK and `2_` heuristic
 * tiers, using the same pure matcher as the extension host.
 *
 * It is a measurement tool and is never imported by the extension bundle.
 */

import type { DatabaseForeignKeyColumnReference, DatabaseKind } from "../contracts/database";
import type { MetadataColumnItem, MetadataObjectItem } from "../lsp/protocol";
import { DEFAULT_JOIN_COMPLETION_SETTINGS } from "../lsp/joinCompletionSettings";
import type { CompletionMetadataProvider } from "../server/completionTypes";
import { computeJoinTargetCandidates, type JoinIndexTable } from "../server/joinTargetMatcher";
import {
  getRelatedColumnRole,
  isSelfNamedKeyColumn,
  normalizeRelatedColumnName,
} from "../utils/relatedColumnNames";

export interface ReplayCatalogColumn {
  name: string;
  /** Declared type (`NUMERIC(19,4)`), when the snapshot has one. */
  type?: string;
  isPk?: boolean;
  isFk?: boolean;
  references?: DatabaseForeignKeyColumnReference[];
}

export interface ReplayCatalogTable {
  schema: string;
  name: string;
  columns: ReplayCatalogColumn[];
}

export interface ReplayCatalog {
  database: string;
  defaultSchema: string;
  tables: ReplayCatalogTable[];
}

interface IndexedTable extends JoinIndexTable {
  source: ReplayCatalogTable;
}

function same(left: string | undefined, right: string | undefined): boolean {
  return (left ?? "").toUpperCase() === (right ?? "").toUpperCase();
}

/** Completion metadata answered from an in-memory {@link ReplayCatalog}. */
export class CatalogReplayMetadataProvider implements CompletionMetadataProvider {
  private readonly index: IndexedTable[];

  constructor(
    private readonly catalog: ReplayCatalog,
    private readonly databaseKind: DatabaseKind = "netezza",
  ) {
    this.index = catalog.tables.map((table) => ({
      source: table,
      name: table.name,
      schema: table.schema,
      columns: table.columns.flatMap((column) => {
        const normalizedName = normalizeRelatedColumnName(column.name);
        if (!normalizedName) {
          return [];
        }
        return [{
          name: column.name,
          normalizedName,
          isKey: getRelatedColumnRole(column) !== "unknown",
          selfNamedKey: isSelfNamedKeyColumn(column.name, table.name),
          joinReferences: column.references,
        }];
      }),
    }));
  }

  async getContext(): Promise<Awaited<ReturnType<CompletionMetadataProvider["getContext"]>>> {
    return {
      effectiveDatabase: this.catalog.database,
      effectiveSchema: this.catalog.defaultSchema,
      databaseKind: this.databaseKind,
      netezzaSchemasEnabled: true,
      joinCompletionSettings: DEFAULT_JOIN_COMPLETION_SETTINGS,
    };
  }

  async getDatabases(): Promise<MetadataObjectItem[]> {
    return [{ name: this.catalog.database }];
  }

  async getSchemas(): Promise<MetadataObjectItem[]> {
    return [...new Set(this.catalog.tables.map((table) => table.schema))]
      .map((schema) => ({ name: schema, database: this.catalog.database }));
  }

  async getTables(_uri: string, database: string, schema?: string): Promise<MetadataObjectItem[]> {
    if (!same(database, this.catalog.database)) {
      return [];
    }
    return this.catalog.tables
      .filter((table) => !schema || same(table.schema, schema))
      .map((table) => this.toObject(table));
  }

  async getViews(): Promise<MetadataObjectItem[]> { return []; }
  async getProcedures(): Promise<MetadataObjectItem[]> { return []; }

  async getColumns(
    _uri: string,
    database: string,
    table: string,
    schema?: string,
  ): Promise<MetadataColumnItem[]> {
    const found = this.find(database, table, schema);
    return (found?.columns ?? []).map((column) => ({
      name: column.name,
      ...(column.type ? { type: column.type } : {}),
      ...(column.isPk ? { isPk: true } : {}),
      ...(column.isFk ? { isFk: true } : {}),
      ...(column.references?.length ? { joinReferences: column.references } : {}),
    }));
  }

  async getCachedJoinTargets(
    _uri: string,
    database: string,
    sources: Array<{ schema?: string; table: string }>,
  ): Promise<MetadataObjectItem[]> {
    if (!same(database, this.catalog.database)) {
      return [];
    }
    const resolved = sources.map((source) => ({
      table: source.table,
      schema: source.schema?.trim()
        || this.find(database, source.table)?.schema
        || this.catalog.defaultSchema,
    }));
    return computeJoinTargetCandidates(database, this.catalog.defaultSchema, resolved, this.index)
      .map((candidate) => ({
        ...this.toObject(candidate.table.source),
        joinUsesDefaultSchema: candidate.joinUsesDefaultSchema,
        joinMatches: candidate.matches,
      }));
  }

  async getNetezzaDefaultSchema(): Promise<string | undefined> {
    return this.catalog.defaultSchema;
  }

  private find(database: string, table: string, schema?: string): ReplayCatalogTable | undefined {
    if (!same(database, this.catalog.database)) {
      return undefined;
    }
    const wanted = schema?.trim() || undefined;
    return this.catalog.tables.find((entry) =>
      same(entry.name, table) && (!wanted || same(entry.schema, wanted)))
      ?? (wanted ? undefined : this.catalog.tables.find((entry) => same(entry.name, table)));
  }

  private toObject(table: ReplayCatalogTable): MetadataObjectItem {
    return {
      name: table.name,
      database: this.catalog.database,
      schema: table.schema,
      objectType: "table",
    };
  }
}
