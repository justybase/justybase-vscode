import type { DatabaseKind } from "../contracts/database";
import type { JoinKnowledgeExecutionCapture } from "./joinKnowledgeExecution";
import type { JoinKnowledgeService } from "./joinKnowledgeService";
import type { WorkspaceIndexCoordinator } from "./workspaceIndexCoordinator";

let activeService: JoinKnowledgeService | undefined;
let activeIndex: WorkspaceIndexCoordinator | undefined;
let activeExecutionCapture: JoinKnowledgeExecutionCapture | undefined;

/** The extension-host service used by command handlers and the LSP bridge. */
export function setJoinKnowledgeService(
  service: JoinKnowledgeService | undefined,
): void {
  activeService = service;
}

export function getJoinKnowledgeService(): JoinKnowledgeService | undefined {
  return activeService;
}

export function setWorkspaceIndexCoordinator(
  index: WorkspaceIndexCoordinator | undefined,
): void {
  activeIndex = index;
}

export function getWorkspaceIndexCoordinator(): WorkspaceIndexCoordinator | undefined {
  return activeIndex;
}

export function setJoinKnowledgeExecutionCapture(
  capture: JoinKnowledgeExecutionCapture | undefined,
): void {
  activeExecutionCapture = capture;
}

export function getJoinKnowledgeExecutionCapture(): JoinKnowledgeExecutionCapture | undefined {
  return activeExecutionCapture;
}

/**
 * Success hook for batch execution. Resolves once the evidence is counted (or
 * skipped); it never rejects, so capture cannot fail the statement it observes.
 */
export function recordJoinKnowledgeSuccessfulStatement(
  event: { sql: string; connectionName: string; executionKey?: string },
  connections: { getConnectionDatabaseKind(name?: string): DatabaseKind | undefined },
): Promise<void> {
  return activeExecutionCapture?.captureSuccessfulStatement({
    sql: event.sql,
    databaseKind: connections.getConnectionDatabaseKind(event.connectionName),
    executionKey: event.executionKey,
  }) ?? Promise.resolve();
}
