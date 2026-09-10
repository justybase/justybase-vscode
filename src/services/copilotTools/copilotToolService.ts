/**
 * Narrow service port consumed by the legacy Copilot language-model tools.
 *
 * Keeping the port beside the tools prevents the tool registry facade from
 * importing the CopilotService implementation back through its type imports.
 */
export interface CopilotToolService {
    getColumnsForTables(tables: string[], database?: string): Promise<string>;
    getComments(tableName: string, database?: string, schema?: string, includeColumns?: boolean): Promise<string>;
    getDDL(params: {
        objectName: string;
        objectType: string;
        database?: string;
        schema?: string;
    }): Promise<string>;
    getDatabases(): Promise<string>;
    getExplainPlanAnalysis(sql: string, verbose: boolean, database?: string): Promise<string>;
    getExternalTables(database?: string, schema?: string, pattern?: string): Promise<string>;
    getNetezzaReference(topic: 'optimization' | 'nzplsql' | 'all'): string;
    getObjectDependencies(
        object: string,
        database?: string,
        objectType?: 'TABLE' | 'VIEW' | 'PROCEDURE',
    ): Promise<string>;
    getProcedures(database?: string, schema?: string): Promise<string>;
    getSchemaContextForCurrentSql(): Promise<string>;
    getSchemaForSql(sql: string): Promise<string>;
    getSchemas(database?: string): Promise<string>;
    getSqlDiagnostics(includeWarnings?: boolean): Promise<string>;
    getTableStats(table: string, database?: string): Promise<string>;
    getTablesFromDatabase(database?: string, schema?: string): Promise<string>;
    getTuningAdvice(
        sql?: string,
        database?: string,
        analyzeAllTables?: boolean,
        maxTables?: number,
    ): Promise<string>;
    getViews(database?: string, schema?: string): Promise<string>;
    getWorkspaceTableProfilesSummary(
        mode?: 'full' | 'summary' | 'content',
        profileNames?: string[],
    ): Promise<string>;
    includeWorkspaceTableProfileNow(profileId: string): Promise<boolean>;
    inspectImportFile(filePath: string, sampleRows?: number): Promise<string>;
    proposeImportMapping(filePath: string, targetTable: string): Promise<string>;
    searchSchema(pattern: string, searchType: string, database?: string): Promise<string>;
    validateSql(sql: string): Promise<string>;
    validateSqlOnDatabase(sql: string, database?: string): Promise<string>;
    findTableLocations(tableName: string): Promise<string>;
}
