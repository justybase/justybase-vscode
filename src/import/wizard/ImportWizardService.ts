import { normalizeDatabaseKind } from "../../contracts/database";
import { ImportPreviewService } from "./ImportPreviewService";
import { ImportValidationService } from "./ImportValidationService";
import { ImportWizardSession } from "./ImportWizardSession";
import { getImportWizardAdapter } from "./adapters";
import type {
  BackgroundValidationProgress,
  ImportExecutionPlan,
  ImportWizardSessionOptions,
  ImportWizardState,
  ImportWizardValidationSummary,
} from "./ImportWizardState";
import type { ProgressCallback, ImportResult } from "../dataImporter";
import {
  backgroundValidationService,
  type BackgroundValidationJob,
} from "./BackgroundValidationService";

export type BackgroundValidationProgressCallback = (
  progress: BackgroundValidationProgress,
  summary?: ImportWizardValidationSummary,
) => void;

export class ImportWizardService {
  private readonly sessions = new Map<string, ImportWizardSession>();
  private readonly progressCallbacks = new Map<
    string,
    BackgroundValidationProgressCallback
  >();

  public constructor(
    private readonly previewService: ImportPreviewService = new ImportPreviewService(),
    private readonly validationService: ImportValidationService = new ImportValidationService(),
  ) {}

  public async createSession(
    options: ImportWizardSessionOptions,
  ): Promise<ImportWizardState> {
    const adapter = getImportWizardAdapter(
      normalizeDatabaseKind(options.connectionDetails.dbType),
    );
    const session = new ImportWizardSession(
      options,
      adapter,
      this.previewService,
      this.validationService,
    );
    const state = await session.initialize();
    this.sessions.set(state.id, session);
    return state;
  }

  public getSessionState(sessionId: string): ImportWizardState {
    return this.requireSession(sessionId).getState();
  }

  public async setPreviewRowCount(
    sessionId: string,
    previewRowCount: number,
  ): Promise<ImportWizardState> {
    return this.requireSession(sessionId).setPreviewRowCount(previewRowCount);
  }

  public async setSheet(
    sessionId: string,
    sheetName?: string,
  ): Promise<ImportWizardState> {
    return this.requireSession(sessionId).setSheet(sheetName);
  }

  public async renameColumn(
    sessionId: string,
    sourceIndex: number,
    targetName: string,
  ): Promise<ImportWizardState> {
    return this.requireSession(sessionId).renameColumn(sourceIndex, targetName);
  }

  public async toggleColumn(
    sessionId: string,
    sourceIndex: number,
    included?: boolean,
  ): Promise<ImportWizardState> {
    return this.requireSession(sessionId).toggleColumn(sourceIndex, included);
  }

  public async reorderColumns(
    sessionId: string,
    orderedSourceIndexes: readonly number[],
  ): Promise<ImportWizardState> {
    return this.requireSession(sessionId).reorderColumns(orderedSourceIndexes);
  }

  public async setColumnType(
    sessionId: string,
    sourceIndex: number,
    selectedType: string,
  ): Promise<ImportWizardState> {
    return this.requireSession(sessionId).setColumnType(
      sourceIndex,
      selectedType,
    );
  }

  public async setTargetDatabase(
    sessionId: string,
    database?: string,
  ): Promise<ImportWizardState> {
    return this.requireSession(sessionId).setTargetDatabase(database);
  }

  public async setTargetSchema(
    sessionId: string,
    schema?: string,
  ): Promise<ImportWizardState> {
    return this.requireSession(sessionId).setTargetSchema(schema);
  }

  public async setTargetTableName(
    sessionId: string,
    tableName: string,
  ): Promise<ImportWizardState> {
    return this.requireSession(sessionId).setTargetTableName(tableName);
  }

  public async updateAvailableSchemas(
    sessionId: string,
    availableSchemas: readonly string[],
  ): Promise<ImportWizardState> {
    return this.requireSession(sessionId).updateAvailableSchemas(availableSchemas);
  }

  public async setTargetCatalog(
    sessionId: string,
    availableDatabases: readonly string[],
    availableSchemas: readonly string[],
  ): Promise<ImportWizardState> {
    return this.requireSession(sessionId).setTargetCatalog(
      availableDatabases,
      availableSchemas,
    );
  }

  public async requestSqlPreview(
    sessionId: string,
  ): Promise<ImportExecutionPlan> {
    return this.requireSession(sessionId).requestSqlPreview();
  }

  public async executeImport(
    sessionId: string,
    progressCallback?: ProgressCallback,
  ): Promise<ImportResult> {
    return this.requireSession(sessionId).executeImport(progressCallback);
  }

  public startBackgroundValidation(
    sessionId: string,
    sampleSize: number,
    progressCallback: BackgroundValidationProgressCallback,
  ): void {
    const session = this.requireSession(sessionId);
    const state = session.getState();
    const importer = session.getImporter();
    const adapter = session.getAdapter();

    this.progressCallbacks.set(sessionId, progressCallback);

    const job: BackgroundValidationJob = {
      sessionId,
      columns: state.columns,
      importer,
      adapter,
      sampleSize,
      progressCallback: (progress, summary) => {
        const callback = this.progressCallbacks.get(sessionId);
        if (callback) {
          callback(progress, summary);
        }

        if (progress.phase === "complete" && summary) {
          this.progressCallbacks.delete(sessionId);
        }
      },
    };

    backgroundValidationService.startValidation(job);
  }

  public cancelBackgroundValidation(sessionId: string): void {
    backgroundValidationService.cancelValidation(sessionId);
    this.progressCallbacks.delete(sessionId);
  }

  public isBackgroundValidationActive(sessionId: string): boolean {
    return backgroundValidationService.isValidationActive(sessionId);
  }

  public disposeSession(sessionId: string): void {
    backgroundValidationService.cancelValidation(sessionId);
    this.progressCallbacks.delete(sessionId);
    const session = this.sessions.get(sessionId);
    session?.dispose();
    this.sessions.delete(sessionId);
  }

  private requireSession(sessionId: string): ImportWizardSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown import wizard session: ${sessionId}`);
    }
    return session;
  }
}
