export type SessionMonitorScalar = string | number | boolean | null;

export interface SessionMonitorSession {
    ID: number;
    PID: number;
    USERNAME: string;
    DBNAME: string;
    TYPE: string;
    CONNTIME: string;
    STATUS: string;
    IPADDR: string;
    COMMAND: string;
    PRIORITY: number;
    CID: number;
    CLIENT_OS_USERNAME: string;
    [key: string]: SessionMonitorScalar | undefined;
}

export interface SessionMonitorQuery {
    QS_SESSIONID: number;
    QS_PLANID: number;
    QS_CLIENTID: number;
    QS_CLIIPADDR: string;
    QS_SQL: string;
    QS_STATE: string;
    QS_TSUBMIT: string;
    QS_TSTART: string;
    QS_PRIORITY: number;
    QS_PRITXT: string;
    QS_ESTCOST: number;
    QS_ESTDISK: number;
    QS_ESTMEM: number;
    QS_SNIPPETS: number;
    QS_CURSNIPT: number;
    QS_RESROWS: number;
    QS_RESBYTES: number;
    USERNAME?: string;
    [key: string]: SessionMonitorScalar | undefined;
}

export interface SessionMonitorStorageInfo {
    DATABASE: string;
    SCHEMA: string;
    ALLOC_MB: number;
    USED_MB: number;
    AVG_SKEW: number;
    TABLE_COUNT: number;
    [key: string]: SessionMonitorScalar | undefined;
}

export type SessionMonitorMetricRow = Record<string, SessionMonitorScalar>;

export interface SessionMonitorSystemUtilSummary {
    AVG_HOST_CPU_PCT?: number | string | null;
    AVG_SPU_CPU_PCT?: number | string | null;
    AVG_MEMORY_PCT?: number | string | null;
    AVG_DISK_PCT?: number | string | null;
    AVG_FABRIC_PCT?: number | string | null;
    SAMPLE_COUNT?: number | string | null;
    [key: string]: SessionMonitorScalar | undefined;
}

export interface SessionMonitorResources {
    gra: SessionMonitorMetricRow[];
    systemUtil: SessionMonitorMetricRow[];
    sysUtilSummary: SessionMonitorSystemUtilSummary | null;
}

export interface SessionMonitorAlertSettings {
    enabled: boolean;
    sessionThreshold: number;
    queryThreshold: number;
    hostCpuThreshold: number;
    spuCpuThreshold: number;
    memoryThreshold: number;
}

export type SessionMonitorLoadLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface SessionMonitorOverview {
    activeSessions: number;
    runningQueries: number;
    avgHostCpuPct: number;
    avgSpuCpuPct: number;
    avgMemoryPct: number;
    loadScore: number;
    loadLevel: SessionMonitorLoadLevel;
}

export type SessionMonitorAlertLevel = 'warning' | 'critical';

export interface SessionMonitorAlert {
    id: string;
    metric: string;
    level: SessionMonitorAlertLevel;
    message: string;
    value: number;
    threshold: number;
}

export interface SessionMonitorData {
    sessions: SessionMonitorSession[];
    queries: SessionMonitorQuery[];
    storage: SessionMonitorStorageInfo[];
    resources: SessionMonitorResources;
    overview: SessionMonitorOverview;
    alertSettings: SessionMonitorAlertSettings;
    alerts: SessionMonitorAlert[];
    refreshedAt: string;
}

export type SessionMonitorWebviewToHostMessage =
    | { command: 'refresh' }
    | { command: 'killSession'; sessionId: number; status?: string }
    | { command: 'toggleAutoRefresh'; enabled: boolean }
    | { command: 'updateAlertSettings'; settings: Partial<SessionMonitorAlertSettings> };

export type SessionMonitorHostToWebviewMessage =
    | { command: 'setLoading'; loading: boolean }
    | { command: 'updateData'; data: SessionMonitorData }
    | { command: 'error'; text: string };

export type SessionMonitorInboundMessage = SessionMonitorWebviewToHostMessage;
export type SessionMonitorOutboundMessage = SessionMonitorHostToWebviewMessage;

export const SESSION_MONITOR_WEBVIEW_TO_HOST_COMMANDS = [
    'refresh',
    'killSession',
    'toggleAutoRefresh',
    'updateAlertSettings'
] as const satisfies readonly SessionMonitorWebviewToHostMessage['command'][];

export const SESSION_MONITOR_HOST_TO_WEBVIEW_COMMANDS = [
    'setLoading',
    'updateData',
    'error'
] as const satisfies readonly SessionMonitorHostToWebviewMessage['command'][];

export const SESSION_MONITOR_INBOUND_COMMANDS = SESSION_MONITOR_WEBVIEW_TO_HOST_COMMANDS;
export const SESSION_MONITOR_OUTBOUND_COMMANDS = SESSION_MONITOR_HOST_TO_WEBVIEW_COMMANDS;