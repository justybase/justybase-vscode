import type { ConnectionDetails } from './types';
import type { BatchDDLOptions, BatchDDLResult, DDLResult } from './ddl';
import { getRequiredDatabaseDdlProvider } from './core/connectionFactory';

export type {
    BatchDDLOptions,
    BatchDDLResult,
    ColumnInfo,
    DDLResult,
    ExternalTableInfo,
    KeyInfo,
    ProcedureInfo,
} from './ddl';
export {
    buildTableDDLFromCache,
    generateExternalTableDDL,
    generateProcedureDDL,
    generateSynonymDDL,
    generateTableDDL,
    generateViewDDL,
    getColumns,
    getDistributionInfo,
    getKeysInfo,
    getOrganizeInfo,
    getTableComment,
    getTableOwner,
    quoteNameIfNeeded
} from './ddl';

export async function generateDDL(
    connectionDetails: ConnectionDetails,
    database: string,
    schema: string,
    objectName: string,
    objectType: string
): Promise<DDLResult> {
    return await getRequiredDatabaseDdlProvider(connectionDetails.dbType).generateDDL(
        connectionDetails,
        database,
        schema,
        objectName,
        objectType
    );
}

export async function generateBatchDDL(options: BatchDDLOptions): Promise<BatchDDLResult> {
    return await getRequiredDatabaseDdlProvider(options.connectionDetails.dbType).generateBatchDDL(options);
}
