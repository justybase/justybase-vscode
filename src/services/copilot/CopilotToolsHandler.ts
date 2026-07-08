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
import { CopilotProcedureTools } from './tools/CopilotProcedureTools';
import { CopilotQueryTools } from './tools/CopilotQueryTools';

export class CopilotToolsHandler {
    private readonly runtime: CopilotToolRuntime;
    private readonly metadataTools: CopilotMetadataTools;
    private readonly importExportTools: CopilotImportExportTools;
    private readonly schemaTools: CopilotSchemaIntrospectionTools;
    private readonly explainTuningTools: CopilotExplainTuningTools;
    private readonly validationTools: CopilotValidationTools;
    private readonly dependencyTools: CopilotDependencyTools;
    private readonly procedureTools: CopilotProcedureTools;
    private readonly queryTools: CopilotQueryTools;

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
            connectionManager,
            context,
            resultPanelProvider,
            getActiveConnectionDetails: () => this.runtime.getActiveConnectionDetails(),
            formatStructuredToolResponse: payload => this.runtime.formatStructuredToolResponse(payload),
            resolveSqlInput: (sql, sqlFilePath) => this.runtime.resolveSqlInput(sql, sqlFilePath),
            getEditorSqlCandidate: () => this.runtime.getEditorSqlCandidate(),
            getActiveResultSetForExport: () => this.runtime.getActiveResultSetForExport()
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
            getTableStats: (tableName, database, mode) => this.getTableStats(tableName, database, mode)
        });

        this.validationTools = new CopilotValidationTools({
            runtime: this.runtime,
            getExplainPlan: (sql, verbose, database) => this.getExplainPlan(sql, verbose, database)
        });

        this.dependencyTools = new CopilotDependencyTools({
            connectionManager,
            runtime: this.runtime
        });

        this.procedureTools = new CopilotProcedureTools({
            connectionManager,
            context,
            runtime: this.runtime
        });

        this.queryTools = new CopilotQueryTools({
            runtime: this.runtime
        });
    }

    async getTablesFromDatabase(database?: string, schema?: string): Promise<string> {
        return this.schemaTools.getTablesFromDatabase(database, schema);
    }

    async getColumnsForTables(tables: string[], database?: string): Promise<string> {
        return this.schemaTools.getColumnsForTables(tables, database);
    }

    async executeSelectQuery(sql: string, maxRows: number, database?: string): Promise<string> {
        return this.queryTools.executeSelectQuery(sql, maxRows, database);
    }

    async getExplainPlan(sql: string, verbose: boolean, database?: string): Promise<string> {
        return this.explainTuningTools.getExplainPlan(sql, verbose, database);
    }

    async getExplainPlanAnalysis(sql: string, verbose: boolean, database?: string): Promise<string> {
        return this.explainTuningTools.getExplainPlanAnalysis(sql, verbose, database);
    }

    async getSampleData(table: string, database: string | undefined, sampleSize: number): Promise<string> {
        return this.schemaTools.getSampleData(table, database, sampleSize);
    }

    async tableStats(table: string): Promise<string> {
        return this.schemaTools.tableStats(table);
    }

    async getTableStats(tableName: string, database?: string, mode: 'quick' | 'deep' = 'quick'): Promise<string> {
        return this.schemaTools.getTableStats(tableName, database, mode);
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

    async executeImport(
        filePath: string,
        targetTable: string,
        dryRun: boolean = true,
        timeoutSeconds?: number
    ): Promise<string> {
        return this.importExportTools.executeImport(filePath, targetTable, dryRun, timeoutSeconds);
    }

    async exportQueryResults(
        sql?: string,
        format?: string,
        outputPath?: string,
        timeoutSeconds?: number,
        source: 'sql' | 'activeResults' = 'sql',
        sqlFilePath?: string
    ): Promise<string> {
        return this.importExportTools.exportQueryResults(sql, format, outputPath, timeoutSeconds, source, sqlFilePath);
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

    async compileProcedure(sql: string, database?: string): Promise<string> {
        return this.procedureTools.compileProcedure(sql, database);
    }

    async executeProcedure(procedureName: string, args?: string, database?: string): Promise<string> {
        return this.procedureTools.executeProcedure(procedureName, args, database);
    }

    async runDiagnosticQueries(queries: string[], database?: string): Promise<string> {
        return this.procedureTools.runDiagnosticQueries(queries, database);
    }
}
