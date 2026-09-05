export interface PostgresqlAlterTableDesignerColumn {
    name: string;
    type: string;
    notNull: boolean;
    defaultValue: string;
    comment: string;
    ordinal: number;
    isPrimaryKey: boolean;
    isForeignKey: boolean;
}

export interface PostgresqlAlterTableDesignerOptions {
    tablespace: string;
    fillfactor: string;
    comment: string;
}

export interface PostgresqlAlterTableDesign {
    columns: PostgresqlAlterTableDesignerColumn[];
    options: PostgresqlAlterTableDesignerOptions;
}

export interface PostgresqlAlterTableDesignerInitialContext {
    schema: string;
    tableName: string;
    qualifiedTable: string;
    columns: PostgresqlAlterTableDesignerColumn[];
    options: PostgresqlAlterTableDesignerOptions;
    tablespaces: string[];
}

export type PostgresqlAlterTableDesignerWebviewToHostMessage =
    | { command: 'executeDesign'; design: PostgresqlAlterTableDesign }
    | { command: 'saveAsSql'; design: PostgresqlAlterTableDesign }
    | { command: 'copyDDL'; design: PostgresqlAlterTableDesign }
    | { command: 'reload' };

export type PostgresqlAlterTableDesignerHostToWebviewMessage =
    | { command: 'setError'; text: string }
    | { command: 'setInfo'; text: string }
    | { command: 'clearStatus' }
    | { command: 'setExecuting'; executing: boolean }
    | { command: 'setContext'; context: PostgresqlAlterTableDesignerInitialContext };