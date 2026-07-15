import * as vscode from 'vscode';
import { ConnectionManager } from '../../core/connectionManager';
import { ResultPanelView } from '../../views/resultPanelView';
import { MetadataCache } from '../../metadataCache';
import { CopilotMetadataTools } from './tools/CopilotMetadataTools';
import { CopilotImportExportTools } from './tools/CopilotImportExportTools';
import { CopilotToolRuntime } from './tools/copilotToolRuntime';
import { CopilotSchemaIntrospectionTools } from './tools/CopilotSchemaIntrospectionTools';
import { CopilotExplainTuningTools } from './tools/CopilotExplainTuningTools';
import { CopilotValidationTools } from './tools/CopilotValidationTools';
import { CopilotDependencyTools } from './tools/CopilotDependencyTools';

export class CopilotToolsHandler {
    private readonly runtime: CopilotToolRuntime;
    private readonly metadataTools: CopilotMetadataTools;
    private readonly importExportTools: CopilotImportExportTools;
    private readonly schemaTools: CopilotSchemaIntrospectionTools;
    private readonly explainTuningTools: CopilotExplainTuningTools;
    private readonly validationTools: CopilotValidationTools;
    private readonly dependencyTools: CopilotDependencyTools;

    constructor(
        connectionManager: ConnectionManager,
        context: vscode.ExtensionContext,
        resultPanelProvider?: ResultPanelView,
        metadataCache?: MetadataCache
    ) {
        this.runtime = new CopilotToolRuntime({
            connectionManager,
            context,
            resultPanelProvider
        });

        this.metadataTools = new CopilotMetadataTools({
            connectionManager,
            runQuerySafe: (sql, description) => this.runtime.runQuerySafe(sql, description)
        });

        this.importExportTools = new CopilotImportExportTools({
            formatStructuredToolResponse: payload => this.runtime.formatStructuredToolResponse(payload)
        });

        this.schemaTools = new CopilotSchemaIntrospectionTools({
            connectionManager,
            context,
            metadataCache,
            runtime: this.runtime
        });

        this.explainTuningTools = new CopilotExplainTuningTools({
            connectionManager,
            context,
            runtime: this.runtime,
            getTableStats: (tableName, database) => this.getTableStats(tableName, database)
        });

        this.validationTools = new CopilotValidationTools({
            runtime: this.runtime,
            getExplainPlan: (sql, verbose, database) => this.getExplainPlan(sql, verbose, database)
        });

        this.dependencyTools = new CopilotDependencyTools({
            connectionManager,
            runtime: this.runtime
        });

    }

    async getTablesFromDatabase(database?: string, schema?: string): Promise<string> {
        return this.schemaTools.getTablesFromDatabase(database, schema);
    }

    async getColumnsForTables(tables: string[], database?: string): Promise<string> {
        return this.schemaTools.getColumnsForTables(tables, database);
    }

    async getExplainPlan(sql: string, verbose: boolean, database?: string): Promise<string> {
        return this.explainTuningTools.getExplainPlan(sql, verbose, database);
    }

    async getExplainPlanAnalysis(sql: string, verbose: boolean, database?: string): Promise<string> {
        return this.explainTuningTools.getExplainPlanAnalysis(sql, verbose, database);
    }

    async tableStats(table: string): Promise<string> {
        return this.schemaTools.tableStats(table);
    }

    async getTableStats(tableName: string, database?: string): Promise<string> {
        return this.schemaTools.getTableStats(tableName, database);
    }

    async getTuningAdvice(
        sql?: string,
        database?: string,
        analyzeAllTables: boolean = true,
        maxTables: number = 5
    ): Promise<string> {
        return this.explainTuningTools.getTuningAdvice(sql, database, analyzeAllTables, maxTables);
    }

    async getDatabases(): Promise<string> {
        return this.metadataTools.getDatabases();
    }

    async getSchemas(database?: string): Promise<string> {
        return this.metadataTools.getSchemas(database);
    }

    async getProcedures(database?: string, schema?: string): Promise<string> {
        return this.metadataTools.getProcedures(database, schema);
    }

    async getViews(database?: string, schema?: string): Promise<string> {
        return this.metadataTools.getViews(database, schema);
    }

    async getExternalTables(database?: string, schema?: string, pattern?: string): Promise<string> {
        return this.metadataTools.getExternalTables(database, schema, pattern);
    }

    async getObjectDefinition(objectName: string, objectType: 'view' | 'procedure', database?: string): Promise<string> {
        return this.metadataTools.getObjectDefinition(objectName, objectType, database);
    }

    async validateSqlParser(sql: string): Promise<string> {
        return this.validationTools.validateSqlParser(sql);
    }

    async validateSqlOnDatabase(sql: string, database?: string): Promise<string> {
        return this.validationTools.validateSqlOnDatabase(sql, database);
    }

    async validateSql(sql: string): Promise<string> {
        return this.validationTools.validateSql(sql);
    }

    async getSqlDiagnostics(includeWarnings: boolean = true): Promise<string> {
        return this.validationTools.getSqlDiagnostics(includeWarnings);
    }

    async inspectImportFile(filePath: string, sampleRows: number = 5): Promise<string> {
        return this.importExportTools.inspectImportFile(filePath, sampleRows);
    }

    async proposeImportMapping(filePath: string, targetTable: string): Promise<string> {
        return this.importExportTools.proposeImportMapping(filePath, targetTable);
    }

    async getObjectDependencies(
        object: string,
        database?: string,
        objectType?: 'TABLE' | 'VIEW' | 'PROCEDURE'
    ): Promise<string> {
        return this.dependencyTools.getObjectDependencies(object, database, objectType);
    }

    async findTableLocations(tableName: string): Promise<string> {
        return this.schemaTools.findTableLocations(tableName);
    }

    async searchSchema(pattern: string, searchType: string, database?: string): Promise<string> {
        return this.schemaTools.searchSchema(pattern, searchType, database);
    }

    async getComments(
        tableName: string,
        database?: string,
        schema?: string,
        includeColumns: boolean = true
    ): Promise<string> {
        return this.schemaTools.getComments(tableName, database, schema, includeColumns);
    }

    async getDDL(params: {
        objectName: string;
        objectType: string;
        database?: string;
        schema?: string;
    }): Promise<string> {
        return this.schemaTools.getDDL(params);
    }

}
