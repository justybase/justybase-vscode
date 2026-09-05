export interface PostgresqlAlterTableDesignerColumn {
    name: string;
    /** Full PostgreSQL type as rendered by format_type, e.g. `character varying(120)`. */
    type: string;
    notNull: boolean;
    /** Empty string means no DEFAULT clause; otherwise a raw SQL expression. */
    defaultValue: string;
    comment: string;
    ordinal: number;
    isPrimaryKey: boolean;
    isForeignKey: boolean;
}

export interface PostgresqlAlterTableDesignerOptions {
    /** Empty string means the database default tablespace. */
    tablespace: string;
    /** Empty string means the table default fillfactor. */
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

export type PostgresqlAlterTableDesignerInboundMessage = PostgresqlAlterTableDesignerWebviewToHostMessage;
export type PostgresqlAlterTableDesignerOutboundMessage = PostgresqlAlterTableDesignerHostToWebviewMessage;