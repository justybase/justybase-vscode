/**
 * Webview-local copies of security panel message contracts.
 */

export interface SecurityPrincipal {
    NAME: string;
    TYPE: 'USER' | 'GROUP';
    [key: string]: unknown;
}

export interface SecurityPanelData {
    principals: SecurityPrincipal[];
}

export interface PermissionPayload {
    action?: string;
    grantVariant?: string;
    objectPrivileges?: string;
    objectTarget?: string;
    objectTypeClause?: string;
    adminPrivileges?: string;
    adminScope?: string;
    principalType?: string;
    principal?: string;
    customSql?: string;
    withGrantOption?: boolean;
    privilege?: string;
    objectType?: string;
    objectName?: string;
}

export type SecurityPanelWebviewToHostMessage =
    | { command: 'loadData' }
    | { command: 'previewSql'; payload?: PermissionPayload }
    | { command: 'executeSql'; payload?: PermissionPayload };

export type SecurityPanelHostToWebviewMessage =
    | { command: 'setLoading'; loading: boolean }
    | { command: 'setData'; data: SecurityPanelData }
    | { command: 'previewSql'; sql: string }
    | { command: 'executed'; sql: string }
    | { command: 'error'; text: string };
