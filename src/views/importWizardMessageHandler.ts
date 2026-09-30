import * as vscode from "vscode";
import * as path from "node:path";
import type {
  ImportWizardInboundMessage,
  ImportWizardOutboundMessage,
  ImportWizardPreviewKind,
} from "../contracts/webviews";
import type { ConnectionManager } from "../core/connectionManager";
import { createClipboardImportSource, removeClipboardImportSource } from "../import/clipboardImportSource";
import { getOutputChannel } from "../core/queryRunnerUtils";
import type { ImportResult } from "../import/dataImporter";
import { ImportWizardService } from "../import/wizard/ImportWizardService";
import { ImportTargetCatalogService } from "../import/wizard/ImportTargetCatalogService";
import type {
  BackgroundValidationProgress,
  ImportWizardSessionOptions,
  ImportWizardState,
  ImportWizardValidationSummary,
} from "../import/wizard/ImportWizardState";
import { presentAccessError } from "../utils/accessErrorHandling";

interface ImportWizardMessageHandlerDependencies {
  context: vscode.ExtensionContext;
  service: ImportWizardService;
  connectionManager: ConnectionManager;
  catalogService: ImportTargetCatalogService;
  postMessage: (
    message: ImportWizardOutboundMessage,
  ) => Thenable<boolean> | Promise<boolean>;
  onTargetTableChanged?: (targetTable: string) => void;
  onClose?: () => void;
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
  private currentOptions?: ImportWizardSessionOptions;
  private clipboardSourceDirectory?: string;
  private isExecuting = false;
  private isTransitioning = false;

  public constructor(
    private readonly deps: ImportWizardMessageHandlerDependencies,
  ) {}

  public async initialize(
    options: ImportWizardSessionOptions,
    fromSessionTransition = false,
  ): Promise<void> {
    if (this.isExecuting || (this.isTransitioning && !fromSessionTransition)) {
      if (options.clipboardSourceDirectory !== this.clipboardSourceDirectory) {
        await removeClipboardImportSource(options.clipboardSourceDirectory);
      }
      throw new Error("An import or source change is already in progress.");
    }

    const previousPath = this.currentOptions?.filePath;
    if (this.sessionId) {
      this.deps.service.disposeSession(this.sessionId);
    }

    if (previousPath && previousPath !== options.filePath && this.clipboardSourceDirectory) {
      await removeClipboardImportSource(this.clipboardSourceDirectory);
      this.clipboardSourceDirectory = undefined;
    }

    this.currentOptions = { ...options };
    this.clipboardSourceDirectory = options.clipboardSourceDirectory;

    const availableConnections = await Promise.all(
      this.deps.connectionManager.getConnectionNames().map(async (name) => {
        const details = await this.deps.connectionManager.getConnection(name);
        return details ? {
          name,
          label: details.name || name,
          database: details.database,
          databaseKind: details.dbType,
        } : undefined;
      }),
    );

    const catalog = await this.deps.catalogService.loadCatalog(
      options.connectionName,
      options.connectionDetails.database,
    );
    const state = await this.deps.service.createSession({
      ...options,
      availableConnections: availableConnections.filter((item) => item !== undefined),
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
    if (this.isExecuting || this.isTransitioning) {
      return;
    }
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
      case "setHasHeaders":
        await this.deps.service.setHasHeaders(
          this.requireSessionId(),
          Boolean(message.hasHeaders),
        );
        await this.postState();
        this.startBackgroundValidation(DEFAULT_BACKGROUND_VALIDATION_SAMPLE_SIZE);
        return;
      case "setCreateTable":
        await this.deps.service.setCreateTable(
          this.requireSessionId(),
          Boolean(message.createTable),
        );
        await this.postState();
        return;
      case "setConnection":
        await this.runSessionTransition(() =>
          this.switchConnection(message.connectionName),
        );
        return;
      case "requestClipboardSource":
        await this.runSessionTransition(() => this.loadClipboardSource());
        return;
      case "requestFileSource":
        await this.runSessionTransition(() => this.loadFileSource());
        return;
      case "closeWizard":
        this.deps.onClose?.();
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
    void removeClipboardImportSource(this.clipboardSourceDirectory);
    this.clipboardSourceDirectory = undefined;
    this.currentOptions = undefined;
  }

  private async switchConnection(connectionName: string): Promise<void> {
    const currentOptions = this.currentOptions;
    if (!currentOptions || !connectionName || connectionName === this.connectionName) {
      return;
    }
    const connectionDetails = await this.deps.connectionManager.getConnectionDetailsForImport(
      undefined,
      connectionName,
    );
    if (!connectionDetails) {
      throw new Error(`Connection "${connectionName}" is unavailable.`);
    }
    const currentState = this.getState();
    await this.initialize({
      ...currentOptions,
      connectionName,
      connectionDetails,
      targetTable: currentState.targetLocation.tableName,
      hasHeaders: currentState.hasHeaders,
      createTable: currentState.createTable,
    }, true);
  }

  private async runSessionTransition(action: () => Promise<void>): Promise<void> {
    if (this.isExecuting || this.isTransitioning) {
      return;
    }
    this.isTransitioning = true;
    try {
      await this.deps.postMessage({ type: "sessionTransitionStarted" });
      await action();
    } finally {
      this.isTransitioning = false;
      await this.deps.postMessage({ type: "sessionTransitionFinished" });
    }
  }

  private async loadClipboardSource(): Promise<void> {
    const currentOptions = this.currentOptions;
    if (!currentOptions) {
      return;
    }
    let sourceDirectory: string | undefined;
    try {
      const text = await vscode.env.clipboard.readText();
      const source = await createClipboardImportSource(
        this.deps.context.globalStorageUri.fsPath,
        text,
      );
      sourceDirectory = source.directoryPath;
      const currentState = this.getState();
      await this.initialize({
        ...currentOptions,
        filePath: source.filePath,
        sourceKind: "clipboard",
        sourceName: "Clipboard",
        clipboardSourceDirectory: source.directoryPath,
        targetTable: currentState.targetTable,
        hasHeaders: true,
      }, true);
    } catch (error) {
      await removeClipboardImportSource(sourceDirectory);
      vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  private async loadFileSource(): Promise<void> {
    const currentOptions = this.currentOptions;
    if (!currentOptions) {
      return;
    }
    const [uri] = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { "Tabular data": ["csv", "txt", "xlsx", "xlsb"] },
      title: "Choose import source",
    }) || [];
    if (!uri) {
      return;
    }
    const currentTable = this.getState().targetTable;
    await this.initialize({
      ...currentOptions,
      filePath: uri.fsPath,
      sourceKind: "file",
      sourceName: path.basename(uri.fsPath),
      clipboardSourceDirectory: undefined,
      targetTable: currentTable,
      hasHeaders: undefined,
    }, true);
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
    if (this.isExecuting || this.isTransitioning) {
      return;
    }
    const sessionId = this.requireSessionId();
    const state = this.getState();
    this.isExecuting = true;

    try {
      await this.deps.postMessage({ type: "executionStarted" });
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
      if (await presentAccessError(error, {
        outputChannel: getOutputChannel(),
        operation: "Advanced import",
      })) {
        await this.deps.postMessage({
          type: "executionFailed",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Advanced import failed: ${message}`);
      await this.deps.postMessage({ type: "executionFailed", message });
    } finally {
      this.isExecuting = false;
    }
  }
}
