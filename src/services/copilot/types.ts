export interface CopilotContext {
    selectedSql: string;
    ddlContext: string;
    variables: string;
    recentQueries: string;
    connectionInfo: string;
    workspaceTableProfilesContext?: string;
}

export interface TableReference {
    database?: string;
    schema?: string;
    name: string;
}

export interface DDLCacheEntry {
    ddl: string;
    timestamp: number;
}
