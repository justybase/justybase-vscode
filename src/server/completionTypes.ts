import type { CstNode } from "chevrotain";
import type { Position } from "vscode-languageserver/node";
import type { DatabaseKind } from "../contracts/database";
import type { MetadataColumnItem, MetadataObjectItem } from "../lsp/protocol";
import type { LocalDefinition } from "../providers/types";

/**
 * Shared completion-engine types used across the extracted server modules.
 */
export type FromJoinContext =
  | { kind: "from_join_name"; partial: string }
  | { kind: "db_dot"; dbName: string; partial: string }
  | { kind: "db_double_dot"; dbName: string; partial: string }
  | {
      kind: "db_schema_dot";
      dbName: string;
      schemaName: string;
      partial: string;
    };

export type TableTargetPathContext = {
  path: FromJoinContext;
  targetType: "table" | "view" | "procedure";
};

export interface ScopeSource {
  qualifier: string;
  db?: string;
  schema?: string;
  table: string;
}

export interface ScopedColumnCandidate {
  column: string;
  qualifiers: string[];
  description?: string;
}

export interface StatementBoundary {
  sql: string;
  start: number;
  end: number;
}

export interface QualifiedTableName {
  database?: string;
  schema?: string;
  table: string;
}

export interface TableSourceBinding {
  tableRef?: QualifiedTableName;
  subquery?: CstNode;
}

export interface SqlParserMethods {
  statements(): CstNode;
}

export interface ParsedContext {
  contentHash: string;
  cleanText: string;
  allLocalDefs: LocalDefinition[];
  localDefs: LocalDefinition[];
  variables: string[];
}

export interface CompletionRequestContext {
  documentUri: string;
  documentVersion: number;
  position: Position;
  databaseKind?: DatabaseKind;
  effectiveDb?: string;
  effectiveSchema?: string;
  netezzaSchemasEnabled?: boolean;
  linePrefix: string;
  prevLine: string;
  cursorOffset: number;
  documentText: string;
  statement: StatementBoundary | null;
  statementOffset: number;
  statementPrefix: string;
  localDefs: LocalDefinition[];
  resolutionLocalDefs: LocalDefinition[];
  variables: string[];
  completionKeywords: readonly string[];
  sqlFunctionNames: readonly string[];
  specialBuiltinValues: readonly string[];
}

export interface CompletionMetadataProvider {
  getContext(documentUri: string): Promise<{
    effectiveDatabase?: string;
    effectiveSchema?: string;
    databaseKind?: DatabaseKind;
    netezzaSchemasEnabled?: boolean;
  }>;
  getDatabases(documentUri: string): Promise<MetadataObjectItem[]>;
  getSchemas(
    documentUri: string,
    database: string,
  ): Promise<MetadataObjectItem[]>;
  getTables(
    documentUri: string,
    database: string,
    schema?: string,
  ): Promise<MetadataObjectItem[]>;
  getViews(
    documentUri: string,
    database: string,
    schema?: string,
  ): Promise<MetadataObjectItem[]>;
  getProcedures(
    documentUri: string,
    database: string,
    schema?: string,
  ): Promise<MetadataObjectItem[]>;
  getColumns(
    documentUri: string,
    database: string,
    table: string,
    schema?: string,
  ): Promise<MetadataColumnItem[]>;
  getNetezzaDefaultSchema?(
    documentUri: string,
    database: string,
  ): Promise<string | undefined>;
}