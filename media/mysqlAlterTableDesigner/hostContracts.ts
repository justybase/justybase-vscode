export interface MysqlAlterTableDesignerColumn {
    name: string;
    type: string;
    notNull: boolean;
    defaultValue: string;
    autoIncrement: boolean;
    comment: string;
    ordinal: number;
    isPrimaryKey: boolean;
    isForeignKey: boolean;
}

export interface MysqlAlterTableDesignerOptions {
    engine: string;
    charset: string;
    collation: string;
    autoIncrement: string;
    comment: string;
}

export interface MysqlAlterTableDesign {
    columns: MysqlAlterTableDesignerColumn[];
    options: MysqlAlterTableDesignerOptions;
}

export interface MysqlAlterTableDesignerInitialContext {
    schema: string;
    tableName: string;
    qualifiedTable: string;
    serverVersion: string;
    columns: MysqlAlterTableDesignerColumn[];
    options: MysqlAlterTableDesignerOptions;
    charsets: string[];
    collations: Array<{ name: string; charset: string }>;
}

export type MysqlAlterTableDesignerWebviewToHostMessage =
    | { command: 'executeDesign'; design: MysqlAlterTableDesign }
    | { command: 'saveAsSql'; design: MysqlAlterTableDesign }
    | { command: 'copyDDL'; design: MysqlAlterTableDesign }
    | { command: 'reload' };

export type MysqlAlterTableDesignerHostToWebviewMessage =
    | { command: 'setError'; text: string }
    | { command: 'setInfo'; text: string }
    | { command: 'clearStatus' }
    | { command: 'setExecuting'; executing: boolean }
    | { command: 'setContext'; context: MysqlAlterTableDesignerInitialContext };