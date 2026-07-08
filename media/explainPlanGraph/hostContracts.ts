/**
 * Webview-local copies of explain plan graph message contracts.
 */

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

export interface CanvasPoint {
    x: number;
    y: number;
}

export interface NodeDragState {
    nodeId: number;
    startClientX: number;
    startClientY: number;
    originX: number;
    originY: number;
}

export interface PanDragState {
    startClientX: number;
    startClientY: number;
    originPanX: number;
    originPanY: number;
}

export interface TransformState {
    scale: number;
    panX: number;
    panY: number;
}
