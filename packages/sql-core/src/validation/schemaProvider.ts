import type { TableInfo } from "./types";

export interface TableQualificationRequest {
  database?: string;
  schema?: string;
  name: string;
  documentUri?: string;
}

export interface QualificationProposal {
  database?: string;
  schema?: string;
  name: string;
  qualifiedText: string;
  isPreferred?: boolean;
}

/** The semantic validator's platform-neutral metadata boundary. */
export interface SchemaProvider {
  getTable(
    database: string | undefined,
    schema: string | undefined,
    tableName: string,
  ): TableInfo | undefined;
  tableExists(
    database: string | undefined,
    schema: string | undefined,
    tableName: string,
  ): boolean;
  proposeTableQualification?(
    request: TableQualificationRequest,
  ): QualificationProposal[];
  canValidateUnqualifiedTableReferences?(): boolean;
  getTablesInSchema?(database: string | undefined, schema: string): TableInfo[];
  getDatabases?(): string[] | undefined;
  getKnownFunctions?(): ReadonlySet<string> | undefined;
}
