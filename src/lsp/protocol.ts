import type { DatabaseKind } from "../contracts/database";
import type { QualificationProposal } from "../core/tableQualificationResolver";

export const NETEZZA_GET_METADATA_REQUEST = "netezza/getMetadata";
export const NETEZZA_DOCUMENT_CONTEXT_CHANGED_NOTIFICATION =
  "netezza/documentContextChanged";
export const NETEZZA_METADATA_CACHE_INVALIDATED_NOTIFICATION =
  "netezza/metadataCacheInvalidated";

export type MetadataRequestKind =
  | "context"
  | "databases"
  | "schemas"
  | "tables"
  | "views"
  | "procedures"
  | "columns"
  | "cachedTableInfo"
  | "tableInfo"
  | "warmDatabaseColumns"
  | "qualifyTable"
  | "netezzaDefaultSchema";

export interface MetadataRequestParams {
  documentUri: string;
  kind: MetadataRequestKind;
  database?: string;
  schema?: string;
  table?: string;
  /** Batch-warm column metadata for these databases (one query per DB). */
  databases?: string[];
}

export interface MetadataContextResponse {
  connectionName?: string;
  effectiveDatabase?: string;
  effectiveSchema?: string;
  databaseKind?: DatabaseKind;
  netezzaSchemasEnabled?: boolean;
}

export interface DocumentContextChangedParams {
  documentUri: string;
}

/** Optional connection scope keeps legacy parameter-less invalidation valid. */
export interface MetadataCacheInvalidatedParams {
  connectionName?: string;
}

export interface MetadataObjectItem {
  name: string;
  database?: string;
  schema?: string;
  objectType?: "table" | "view" | "procedure";
  detail?: string;
  description?: string;
  /** Parsed from procedure signature when objectType is procedure. */
  argumentNames?: string[];
}

export interface MetadataColumnItem {
  name: string;
  type?: string;
  description?: string;
  isPk?: boolean;
  isFk?: boolean;
}

export interface MetadataTableInfoResponse {
  exists: boolean;
  table: string;
  database?: string;
  schema?: string;
  description?: string;
  columns: MetadataColumnItem[];
}

export type MetadataResponse =
  | MetadataContextResponse
  | MetadataObjectItem[]
  | MetadataColumnItem[]
  | MetadataTableInfoResponse
  | QualificationProposal[]
  | string
  | null;
