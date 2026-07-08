import type { DatabaseAdvancedFeatures, DatabaseReferenceTopic } from '../../contracts/database';
import { NetezzaReferenceProvider } from './copilot/NetezzaReferenceProvider';
import {
    buildTableDDLFromCache,
    generateBatchDDL,
    generateDDL,
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
import { NZ_QUERIES } from './metadata/systemQueries';
import { ColumnTypeChooser, NetezzaDataType, netezzaImportTypeMapper } from './import/typeMapping';
import { netezzaMaintenanceProvider } from './maintenanceProvider';
import { NetezzaTuningAdvisor } from './tuning/netezzaTuningAdvisor';
import { netezzaSessionMonitorProvider } from './sessionMonitor';

const netezzaReferenceProvider = new NetezzaReferenceProvider();
const netezzaTuningAdvisor = new NetezzaTuningAdvisor();

export const netezzaAdvancedFeatures: DatabaseAdvancedFeatures = {
    ddl: {
        quoteNameIfNeeded,
        buildFindTableSchemaQuery(database: string, tableName: string): string {
            return NZ_QUERIES.findTableSchema(database, tableName);
        },
        buildTableStatsQuery(database: string, schema: string, tableName: string): string {
            return NZ_QUERIES.getTableStats(database, schema, tableName);
        },
        buildSkewCheckQuery(qualifiedTableName: string): string {
            return `SELECT DATASLICEID, COUNT(*) AS ROW_COUNT FROM ${qualifiedTableName} GROUP BY DATASLICEID ORDER BY DATASLICEID`;
        },
        getColumns,
        getDistributionInfo,
        getOrganizeInfo,
        getKeysInfo,
        getTableComment,
        getTableOwner,
        generateTableDDL,
        buildTableDDLFromCache,
        generateViewDDL,
        generateProcedureDDL,
        generateExternalTableDDL,
        generateSynonymDDL,
        generateBatchDDL,
        generateDDL
    },
    importTypeMapper: netezzaImportTypeMapper,
    tuningAdvisor: netezzaTuningAdvisor,
    maintenance: netezzaMaintenanceProvider,
    sessionMonitor: netezzaSessionMonitorProvider,
    copilotReferenceProvider: {
        getReference(topic: DatabaseReferenceTopic = 'all'): string {
            if (topic === 'procedure') {
                return netezzaReferenceProvider.getNetezzaReference('nzplsql');
            }
            if (topic === 'optimization') {
                return netezzaReferenceProvider.getNetezzaReference('optimization');
            }
            return netezzaReferenceProvider.getNetezzaReference('all');
        }
    }
};

export { ColumnTypeChooser, NetezzaDataType };
