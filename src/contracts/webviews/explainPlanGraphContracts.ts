export interface ExplainPlanGraphWarning {
    type?: string;
    icon?: string;
    message?: string;
}

export interface ExplainPlanGraphNode {
    id: number;
    parentId?: number | null;
    depth?: number;
    type: string;
    table?: string;
    alias?: string;
    costStart?: number;
    costEnd?: number;
    costIntensity?: string;
    rows?: number;
    width?: number;
    confidence?: number;
    isFullScan?: boolean;
    isBroadcast?: boolean;
    warnings?: ExplainPlanGraphWarning[];
}

export interface ExplainPlanGraphPayload {
    nodes?: ExplainPlanGraphNode[];
}

export type ExplainPlanGraphWebviewToHostMessage =
    | { command: 'copyPlan' };

export type ExplainPlanGraphInboundMessage = ExplainPlanGraphWebviewToHostMessage;

export const EXPLAIN_PLAN_GRAPH_WEBVIEW_TO_HOST_COMMANDS = [
    'copyPlan',
] as const satisfies readonly ExplainPlanGraphWebviewToHostMessage['command'][];

export const EXPLAIN_PLAN_GRAPH_INBOUND_COMMANDS = EXPLAIN_PLAN_GRAPH_WEBVIEW_TO_HOST_COMMANDS;
