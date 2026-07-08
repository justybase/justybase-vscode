import type { ColumnInfo, TableInfo } from "../sqlParser/types";
import type { SchemaProvider } from "../sqlParser/schemaProvider";
import type { MetadataTableInfoResponse } from "../lsp/protocol";
import type {
  QualificationProposal,
  TableQualificationRequest,
} from "../core/tableQualificationResolver";

export interface LspSchemaProviderBridge {
  findCachedTableInfo(
    documentUri: string,
    table: string,
    database?: string,
    schema?: string,
  ): MetadataTableInfoResponse | undefined;

  hasAnyTableInfo(documentUri: string): boolean;

  hasCachedTableListForDatabase?(
    documentUri: string,
    database: string,
  ): boolean;

  getCachedQualificationProposals(
    documentUri: string,
    request: TableQualificationRequest,
  ): QualificationProposal[];
}

export class LspSchemaProvider implements SchemaProvider {
  constructor(
    private readonly metadataBridge: LspSchemaProviderBridge,
    private readonly documentUri: string,
    private readonly effectiveDatabase?: string,
  ) {}

  getTable(
    database: string | undefined,
    schema: string | undefined,
    tableName: string,
  ): TableInfo | undefined {
    const tableInfo = this.metadataBridge.findCachedTableInfo(
      this.documentUri,
      tableName,
      database,
      schema,
    );
    if (!tableInfo || tableInfo.columns.length === 0) {
      return undefined;
    }

    return {
      name: tableInfo.table,
      database: tableInfo.database,
      schema: tableInfo.schema,
      isCte: false,
      isTempTable: false,
      columns: tableInfo.columns.map(
        (column) =>
          ({
            name: column.name,
            dataType: column.type,
          }) satisfies ColumnInfo,
      ),
    };
  }

  tableExists(
    database: string | undefined,
    schema: string | undefined,
    tableName: string,
  ): boolean {
    const tableInfo = this.metadataBridge.findCachedTableInfo(
      this.documentUri,
      tableName,
      database,
      schema,
    );
    if (!tableInfo) {
      return true;
    }
    return tableInfo.exists;
  }

  canValidateUnqualifiedTableReferences(): boolean {
    if (
      this.effectiveDatabase &&
      this.metadataBridge.hasCachedTableListForDatabase?.(
        this.documentUri,
        this.effectiveDatabase,
      )
    ) {
      return true;
    }

    return this.metadataBridge.hasAnyTableInfo(this.documentUri);
  }

  proposeTableQualification(
    request: TableQualificationRequest,
  ): QualificationProposal[] {
    if (request.database && request.schema) {
      return [];
    }

    return this.metadataBridge.getCachedQualificationProposals(
      this.documentUri,
      request,
    );
  }
}
