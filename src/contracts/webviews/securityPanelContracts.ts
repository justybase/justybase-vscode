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

export type SecurityPanelInboundMessage = SecurityPanelWebviewToHostMessage;
export type SecurityPanelOutboundMessage = SecurityPanelHostToWebviewMessage;

export const SECURITY_PANEL_WEBVIEW_TO_HOST_COMMANDS = [
    'loadData',
    'previewSql',
    'executeSql'
] as const satisfies readonly SecurityPanelWebviewToHostMessage['command'][];

export const SECURITY_PANEL_HOST_TO_WEBVIEW_COMMANDS = [
    'setLoading',
    'setData',
    'previewSql',
    'executed',
    'error'
] as const satisfies readonly SecurityPanelHostToWebviewMessage['command'][];

export const SECURITY_PANEL_INBOUND_COMMANDS = SECURITY_PANEL_WEBVIEW_TO_HOST_COMMANDS;
export const SECURITY_PANEL_OUTBOUND_COMMANDS = SECURITY_PANEL_HOST_TO_WEBVIEW_COMMANDS;