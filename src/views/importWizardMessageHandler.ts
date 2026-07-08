import * as vscode from "vscode";
import type {
  ImportWizardInboundMessage,
  ImportWizardOutboundMessage,
  ImportWizardPreviewKind,
} from "../contracts/webviews";
import type { ConnectionManager } from "../core/connectionManager";
import type { ImportResult } from "../import/dataImporter";
import { ImportWizardService } from "../import/wizard/ImportWizardService";
import { ImportTargetCatalogService } from "../import/wizard/ImportTargetCatalogService";
import type {
  BackgroundValidationProgress,
  ImportWizardSessionOptions,
  ImportWizardState,
  ImportWizardValidationSummary,
} from "../import/wizard/ImportWizardState";

interface ImportWizardMessageHandlerDependencies {
  service: ImportWizardService;
  connectionManager: ConnectionManager;
  catalogService: ImportTargetCatalogService;
  postMessage: (
    message: ImportWizardOutboundMessage,
  ) => Thenable<boolean> | Promise<boolean>;
  onTargetTableChanged?: (targetTable: string) => void;
}

function renderExecutionPlanDocument(state: ImportWizardState): string {
  const lines = [
    "# Advanced import plan",
    "",
    `- File: \`${state.filePath}\``,
    `- Target table: \`${state.targetTable}\``,
    `- Database kind: \`${state.databaseKind}\``,
    `- Preview rows: \`${state.previewRowCount}\``,
    `- Selected columns: \`${state.columns.filter((column) => column.included).length}\``,
    "",
    "## CREATE TABLE SQL",
    "",
    "```sql",
    state.executionPlan.createTableSql,
    "```",
    "",
  ];

  if (state.executionPlan.loadSql) {
    lines.push(
      "## Load SQL preview",
      "",
      "```sql",
      state.executionPlan.loadSql,
      "```",
      "",
    );
  } else {
    lines.push(
      "## Load SQL preview",
      "",
      "No direct load SQL preview is available for this execution mode.",
      "",
    );
  }

  if (state.warnings.length > 0) {
    lines.push("## Warnings", "");
    for (const warning of state.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }

  if (
    state.executionPlan.nextSteps &&
    state.executionPlan.nextSteps.length > 0
  ) {
    lines.push("## Next steps", "");
    for (const nextStep of state.executionPlan.nextSteps) {
      lines.push(`1. ${nextStep}`);
    }
  }

  return lines.join("\n");
}

const DEFAULT_BACKGROUND_VALIDATION_SAMPLE_SIZE = 5000;

export class ImportWizardMessageHandler {
  private sessionId?: string;
  private webviewReady = false;
  private connectionName?: string;

  public constructor(
    private readonly deps: ImportWizardMessageHandlerDependencies,
  ) {}

  public async initialize(options: ImportWizardSessionOptions): Promise<void> {
    if (this.sessionId) {
      this.deps.service.disposeSession(this.sessionId);
    }

    const catalog = await this.deps.catalogService.loadCatalog(
      options.connectionName,
      options.connectionDetails.database,
    );
    const state = await this.deps.service.createSession({
      ...options,
      availableDatabases: catalog.availableDatabases,
      availableSchemas: [],
    });
    this.sessionId = state.id;
    this.connectionName = options.connectionName;

    const targetDatabase =
      state.targetLocation.database?.trim() ||
      options.connectionDetails.database?.trim();
    const schemaCatalog = await this.deps.catalogService.loadCatalog(
      options.connectionName,
      targetDatabase,
    );
    await this.deps.service.setTargetCatalog(
      state.id,
      catalog.availableDatabases,
      schemaCatalog.availableSchemas,
    );

    if (this.webviewReady) {
      await this.postState(true);
      this.startBackgroundValidation(DEFAULT_BACKGROUND_VALIDATION_SAMPLE_SIZE);
    }
  }

  public async handleMessage(
    message: ImportWizardInboundMessage,
  ): Promise<void> {
    switch (message.type) {
      case "ready":
        this.webviewReady = true;
        await this.postState(true);
        this.startBackgroundValidation(
          DEFAULT_BACKGROUND_VALIDATION_SAMPLE_SIZE,
        );
        return;
      case "setPreviewRowCount":
        await this.deps.service.setPreviewRowCount(
          this.requireSessionId(),
          Number(message.previewRowCount),
        );
        await this.postState();
        return;
      case "setSheet":
        await this.deps.service.setSheet(
          this.requireSessionId(),
          message.sheetName,
        );
        await this.postState();
        this.startBackgroundValidation(
          DEFAULT_BACKGROUND_VALIDATION_SAMPLE_SIZE,
        );
        return;
      case "renameColumn":
        await this.deps.service.renameColumn(
          this.requireSessionId(),
          Number(message.sourceIndex),
          String(message.targetName || ""),
        );
        await this.postState();
        return;
      case "toggleColumn":
        await this.deps.service.toggleColumn(
          this.requireSessionId(),
          Number(message.sourceIndex),
          message.included,
        );
        await this.postState();
        return;
      case "reorderColumns":
        await this.deps.service.reorderColumns(
          this.requireSessionId(),
          Array.isArray(message.orderedSourceIndexes)
            ? message.orderedSourceIndexes
            : [],
        );
        await this.postState();
        return;
      case "setColumnType":
        await this.deps.service.setColumnType(
          this.requireSessionId(),
          Number(message.sourceIndex),
          String(message.selectedType || ""),
        );
        await this.postState();
        this.startBackgroundValidation(
          DEFAULT_BACKGROUND_VALIDATION_SAMPLE_SIZE,
        );
        return;
      case "setTargetDatabase":
        await this.deps.service.setTargetDatabase(
          this.requireSessionId(),
          message.database,
        );
        await this.refreshTargetSchemas(message.database);
        await this.postState();
        return;
      case "setTargetSchema":
        await this.deps.service.setTargetSchema(
          this.requireSessionId(),
          message.schema,
        );
        await this.postState();
        return;
      case "setTargetTableName":
        await this.deps.service.setTargetTableName(
          this.requireSessionId(),
          String(message.tableName || ""),
        );
        await this.postState();
        return;
      case "requestSqlPreview":
        await this.deps.service.requestSqlPreview(this.requireSessionId());
        await this.postSqlPreview();
        return;
      case "copySql":
        await this.copySqlPreview(message.kind || "create");
        return;
      case "openSqlPreview":
        await this.openSqlPreview(message.kind || "create");
        return;
      case "executeImport":
        await this.executeImport();
        return;
      case "startBackgroundValidation":
        this.startBackgroundValidation(
          message.backgroundValidationSampleSize ||
            DEFAULT_BACKGROUND_VALIDATION_SAMPLE_SIZE,
        );
        return;
      case "cancelBackgroundValidation":
        this.deps.service.cancelBackgroundValidation(this.requireSessionId());
        return;
      default:
        return;
    }
  }

  public dispose(): void {
    if (this.sessionId) {
      this.deps.service.disposeSession(this.sessionId);
    }
    this.sessionId = undefined;
  }

  private startBackgroundValidation(sampleSize: number): void {
    const sessionId = this.sessionId;
    if (!sessionId) {
      return;
    }

    this.deps.service.startBackgroundValidation(
      sessionId,
      sampleSize,
      (
        progress: BackgroundValidationProgress,
        summary?: ImportWizardValidationSummary,
      ) => {
        void this.deps.postMessage({
          type: "backgroundValidationProgress",
          progress,
          summary,
        });
      },
    );
  }

  private requireSessionId(): string {
    if (!this.sessionId) {
      throw new Error("Import wizard session is not initialized.");
    }
    return this.sessionId;
  }

  private getState(): ImportWizardState {
    return this.deps.service.getSessionState(this.requireSessionId());
  }

  private async refreshTargetSchemas(database?: string): Promise<void> {
    if (!this.connectionName) {
      return;
    }

    const catalog = await this.deps.catalogService.loadCatalog(
      this.connectionName,
      database,
    );
    await this.deps.service.updateAvailableSchemas(
      this.requireSessionId(),
      catalog.availableSchemas,
    );
  }

  private async postState(initial: boolean = false): Promise<void> {
    const state = this.getState();
    this.deps.onTargetTableChanged?.(state.targetTable);
    if (initial) {
      await this.deps.postMessage({
        type: "sessionInitialized",
        state,
      });
    } else {
      await this.deps.postMessage({
        type: "previewUpdated",
        state,
      });
    }
    await this.deps.postMessage({
      type: "validationUpdated",
      issues: state.issues,
      warnings: state.warnings,
      hasValidationErrors: state.hasValidationErrors,
    });
    await this.deps.postMessage({
      type: "sqlPreviewUpdated",
      executionPlan: state.executionPlan,
    });
  }

  private async postSqlPreview(): Promise<void> {
    const executionPlan = await this.deps.service.requestSqlPreview(
      this.requireSessionId(),
    );
    await this.deps.postMessage({
      type: "sqlPreviewUpdated",
      executionPlan,
    });
  }

  private resolvePreviewContent(kind: ImportWizardPreviewKind): {
    content: string;
    language: string;
    title: string;
  } {
    const state = this.getState();
    const executionPlan = state.executionPlan;

    if (kind === "create") {
      return {
        content: executionPlan.createTableSql,
        language: "sql",
        title: "Create Table Preview",
      };
    }

    if (kind === "load") {
      if (!executionPlan.loadSql) {
        throw new Error(
          "No load SQL preview is available for the current execution mode.",
        );
      }

      return {
        content: executionPlan.loadSql,
        language: "sql",
        title: "Load SQL Preview",
      };
    }

    return {
      content: renderExecutionPlanDocument(state),
      language: "markdown",
      title: "Advanced Import Plan",
    };
  }

  private async copySqlPreview(
    kind: ImportWizardPreviewKind,
  ): Promise<void> {
    const preview = this.resolvePreviewContent(kind);
    await vscode.env.clipboard.writeText(preview.content);
    vscode.window.showInformationMessage(
      `${preview.title} copied to clipboard.`,
    );
  }

  private async openSqlPreview(
    kind: ImportWizardPreviewKind,
  ): Promise<void> {
    const preview = this.resolvePreviewContent(kind);
    const document = await vscode.workspace.openTextDocument({
      content: preview.content,
      language: preview.language,
    });
    if (this.connectionName) {
      this.deps.connectionManager.setDocumentConnection(
        document.uri.toString(),
        this.connectionName,
      );
    }
    await vscode.window.showTextDocument(document, { preview: false });
  }

  private async handleWorkflowResult(
    state: ImportWizardState,
    result: ImportResult,
  ): Promise<void> {
    const workflowMarkdown =
      result.details?.snowflakeWorkflow?.workflowMarkdown;
    const content = workflowMarkdown || renderExecutionPlanDocument(state);
    const document = await vscode.workspace.openTextDocument({
      content,
      language: "markdown",
    });
    if (this.connectionName) {
      this.deps.connectionManager.setDocumentConnection(
        document.uri.toString(),
        this.connectionName,
      );
    }
    await vscode.window.showTextDocument(document, { preview: false });
  }

  private async executeImport(): Promise<void> {
    const sessionId = this.requireSessionId();
    const state = this.getState();
    await this.deps.postMessage({ type: "executionStarted" });

    try {
      const result = await vscode.window.withProgress<ImportResult>(
        {
          location: vscode.ProgressLocation.Window,
          title: "Running advanced import...",
          cancellable: false,
        },
        async (progress) =>
          this.deps.service.executeImport(sessionId, (message) =>
            progress.report({ message }),
          ),
      );

      if (!result.success && state.executionPlan.mode === "workflow") {
        await this.handleWorkflowResult(state, result);
      } else if (!result.success) {
        throw new Error(result.message);
      } else {
        vscode.window.showInformationMessage(
          `Data imported successfully to table: ${state.targetTable}`,
        );
        void vscode.commands.executeCommand('netezza.refreshSchema');
      }

      await this.deps.postMessage({ type: "executionFinished", result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Advanced import failed: ${message}`);
      await this.deps.postMessage({ type: "executionFailed", message });
    }
  }
}
