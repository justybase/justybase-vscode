import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ImportColumnOptions,
  ImportResult,
  ProgressCallback,
} from "../dataImporter";
import type { ImportPreviewService } from "./ImportPreviewService";
import type { ImportValidationService } from "./ImportValidationService";
import type { DatabaseImportWizardAdapter } from "./adapters/DatabaseImportWizardAdapter";
import type {
  ImportExecutionPlan,
  ImportWizardColumn,
  ImportWizardSessionOptions,
  ImportWizardState,
  ImportTargetLocationCapabilitiesState,
} from "./ImportWizardState";
import type { TabularDataImporter } from "../tabularDataImporter";
import {
  composeImportTargetTable,
  getImportTargetLocationCapabilities,
  parseImportTargetLocation,
  resolveDefaultImportTargetLocation,
} from "./importTargetLocation";

function cloneColumns(
  columns: readonly ImportWizardColumn[],
): ImportWizardColumn[] {
  return columns.map((column) => ({ ...column }));
}

export class ImportWizardSession {
  public readonly id = randomUUID();
  private importer?: TabularDataImporter;
  private state?: ImportWizardState;

  public constructor(
    private readonly options: ImportWizardSessionOptions,
    private readonly adapter: DatabaseImportWizardAdapter,
    private readonly previewService: ImportPreviewService,
    private readonly validationService: ImportValidationService,
  ) {}

  public async initialize(): Promise<ImportWizardState> {
    const preview = await this.previewService.initialize(
      this.options,
      this.adapter,
    );
    this.importer = preview.importer;
    const targetLocationCapabilities = this.buildTargetLocationCapabilities();
    const parsedLocation = parseImportTargetLocation(
      this.options.targetTable,
      this.options.connectionDetails,
      this.adapter.kind,
    );
    const targetLocation = resolveDefaultImportTargetLocation(
      parsedLocation,
      this.options.connectionDetails,
      this.adapter.kind,
      this.options.availableDatabases || [],
      this.options.availableSchemas || [],
    );
    this.options.targetTable = composeImportTargetTable(
      targetLocation,
      this.options.connectionDetails,
      this.adapter.kind,
    );
    this.importer.updateTargetTable(this.options.targetTable);
    this.state = {
      id: this.id,
      filePath: this.options.filePath,
      fileName: path.basename(this.options.filePath),
      fileFormat: preview.fileFormat,
      sheetName: preview.sheetName,
      availableSheets: preview.availableSheets,
      canChangeSheet: preview.availableSheets.length > 1,
      connectionName: this.options.connectionName,
      databaseKind: this.adapter.kind,
      targetTable: this.options.targetTable,
      targetLocation,
      targetLocationCapabilities,
      availableDatabases: [...(this.options.availableDatabases || [])],
      availableSchemas: [...(this.options.availableSchemas || [])],
      previewRowCount: this.options.previewRowCount,
      validationSampleSize: this.options.validationSampleSize,
      detectedDelimiter: preview.detectedDelimiter,
      decimalDelimiter: preview.decimalDelimiter,
      sourceHeaders: preview.sourceHeaders,
      columns: preview.columns,
      previewRows: [],
      issues: [],
      warnings: [],
      hasValidationErrors: false,
      executionPlan: {
        mode: this.adapter.getExecutionMode(),
        createTableSql: "",
        warnings: [],
      },
      typeOptions: this.adapter.getSupportedTypeOptions(),
    };

    await this.refreshDerivedState(preview.rawPreviewRows);
    return this.getState();
  }

  public getState(): ImportWizardState {
    const state = this.requireState();
    return {
      ...state,
      availableSheets: [...state.availableSheets],
      sourceHeaders: [...state.sourceHeaders],
      columns: cloneColumns(state.columns),
      previewRows: state.previewRows.map((row) => [...row]),
      issues: state.issues.map((issue) => ({ ...issue })),
      warnings: [...state.warnings],
      executionPlan: {
        ...state.executionPlan,
        warnings: [...state.executionPlan.warnings],
        nextSteps: state.executionPlan.nextSteps
          ? [...state.executionPlan.nextSteps]
          : undefined,
      },
      typeOptions: [...state.typeOptions],
      targetLocation: { ...state.targetLocation },
      availableDatabases: [...state.availableDatabases],
      availableSchemas: [...state.availableSchemas],
    };
  }

  public async renameColumn(
    sourceIndex: number,
    targetName: string,
  ): Promise<ImportWizardState> {
    const state = this.requireState();
    const column = state.columns.find(
      (item) => item.sourceIndex === sourceIndex,
    );
    if (!column) {
      throw new Error(`Unknown import column: ${sourceIndex}`);
    }

    const normalizedName = targetName.trim()
      ? this.adapter.normalizeTargetColumnName(targetName)
      : column.defaultTargetName;
    column.targetName = normalizedName;
    await this.refreshDerivedState();
    return this.getState();
  }

  public async toggleColumn(
    sourceIndex: number,
    included?: boolean,
  ): Promise<ImportWizardState> {
    const column = this.requireState().columns.find(
      (item) => item.sourceIndex === sourceIndex,
    );
    if (!column) {
      throw new Error(`Unknown import column: ${sourceIndex}`);
    }

    column.included = included ?? !column.included;
    await this.refreshDerivedState();
    return this.getState();
  }

  public async reorderColumns(
    orderedSourceIndexes: readonly number[],
  ): Promise<ImportWizardState> {
    const state = this.requireState();
    const bySourceIndex = new Map(
      state.columns.map((column) => [column.sourceIndex, column]),
    );
    const nextColumns: ImportWizardColumn[] = [];

    for (const sourceIndex of orderedSourceIndexes) {
      const column = bySourceIndex.get(sourceIndex);
      if (!column) {
        continue;
      }
      nextColumns.push(column);
      bySourceIndex.delete(sourceIndex);
    }

    for (const column of state.columns) {
      if (bySourceIndex.has(column.sourceIndex)) {
        nextColumns.push(column);
      }
    }

    state.columns = nextColumns.map((column, index) => ({
      ...column,
      order: index,
    }));
    await this.refreshDerivedState();
    return this.getState();
  }

  public async setColumnType(
    sourceIndex: number,
    selectedType: string,
  ): Promise<ImportWizardState> {
    const state = this.requireState();
    const column = state.columns.find(
      (item) => item.sourceIndex === sourceIndex,
    );
    if (!column) {
      throw new Error(`Unknown import column: ${sourceIndex}`);
    }

    const normalizedType = selectedType.trim();
    if (!normalizedType) {
      throw new Error("Type is required.");
    }

    column.selectedType = normalizedType.toUpperCase();
    column.overrideMode =
      column.selectedType === column.inferredType ? "inferred" : "user";
    await this.refreshDerivedState();
    return this.getState();
  }

  public async setPreviewRowCount(
    previewRowCount: number,
  ): Promise<ImportWizardState> {
    const state = this.requireState();
    state.previewRowCount = Math.max(
      1,
      Math.min(Math.trunc(previewRowCount), 100),
    );
    await this.refreshDerivedState();
    return this.getState();
  }

  public async setTargetDatabase(database?: string): Promise<ImportWizardState> {
    const state = this.requireState();
    if (!state.targetLocationCapabilities.supportsDatabaseSelection) {
      return this.getState();
    }
    if (state.targetLocationCapabilities.enforceActiveDatabase) {
      return this.getState();
    }

    const normalizedDatabase = database?.trim();
    if (!normalizedDatabase) {
      throw new Error("Database is required.");
    }

    state.targetLocation.database = normalizedDatabase;
    await this.applyTargetLocation(state);
    return this.getState();
  }

  public async setTargetSchema(schema?: string): Promise<ImportWizardState> {
    const state = this.requireState();
    if (!state.targetLocationCapabilities.supportsSchemaSelection) {
      return this.getState();
    }

    const normalizedSchema = schema?.trim();
    if (!normalizedSchema) {
      throw new Error("Schema is required.");
    }

    state.targetLocation.schema = normalizedSchema;
    await this.applyTargetLocation(state);
    return this.getState();
  }

  public async setTargetTableName(tableName: string): Promise<ImportWizardState> {
    const state = this.requireState();
    const normalizedTableName = tableName.trim();
    if (!normalizedTableName) {
      throw new Error("Target table name is required.");
    }

    state.targetLocation.tableName = normalizedTableName;
    await this.applyTargetLocation(state);
    return this.getState();
  }

  public async updateAvailableSchemas(
    availableSchemas: readonly string[],
  ): Promise<ImportWizardState> {
    const state = this.requireState();
    state.availableSchemas = [...availableSchemas];

    if (
      state.targetLocationCapabilities.supportsSchemaSelection &&
      state.targetLocation.schema &&
      !availableSchemas.some(
        (item) => item.toUpperCase() === state.targetLocation.schema!.toUpperCase(),
      )
    ) {
      state.targetLocation.schema = availableSchemas[0];
      await this.applyTargetLocation(state);
    } else if (
      state.targetLocationCapabilities.supportsSchemaSelection &&
      !state.targetLocation.schema &&
      availableSchemas.length > 0
    ) {
      state.targetLocation.schema = availableSchemas[0];
      await this.applyTargetLocation(state);
    } else if (
      state.targetLocationCapabilities.supportsSchemaSelection &&
      availableSchemas.length === 0 &&
      state.targetLocation.schema
    ) {
      state.targetLocation.schema = undefined;
      await this.applyTargetLocation(state);
    }

    return this.getState();
  }

  public async setTargetCatalog(
    availableDatabases: readonly string[],
    availableSchemas: readonly string[],
  ): Promise<ImportWizardState> {
    const state = this.requireState();
    state.availableDatabases = [...availableDatabases];
    state.availableSchemas = [...availableSchemas];
    state.targetLocation = resolveDefaultImportTargetLocation(
      state.targetLocation,
      this.options.connectionDetails,
      this.adapter.kind,
      availableDatabases,
      availableSchemas,
    );
    await this.applyTargetLocation(state);
    return this.getState();
  }

  public async setSheet(sheetName?: string): Promise<ImportWizardState> {
    const importer = this.requireImporter();
    const state = this.requireState();
    const normalizedSheet = sheetName?.trim();
    if (!normalizedSheet) {
      throw new Error("Sheet name is required.");
    }

    if (!state.availableSheets.includes(normalizedSheet)) {
      throw new Error(`Unknown worksheet: ${normalizedSheet}`);
    }

    importer.setSelectedSheet(normalizedSheet);
    const preview = await this.previewService.refresh(
      importer,
      this.adapter,
      state.previewRowCount,
      this.options.filePath,
    );
    state.fileFormat = preview.fileFormat;
    state.sheetName = preview.sheetName;
    state.availableSheets = preview.availableSheets;
    state.canChangeSheet = preview.availableSheets.length > 1;
    state.detectedDelimiter = preview.detectedDelimiter;
    state.decimalDelimiter = preview.decimalDelimiter;
    state.sourceHeaders = preview.sourceHeaders;
    state.columns = preview.columns;
    await this.refreshDerivedState(preview.rawPreviewRows);
    return this.getState();
  }

  public async requestSqlPreview(): Promise<ImportExecutionPlan> {
    await this.refreshDerivedState();
    return { ...this.requireState().executionPlan };
  }

  public async executeImport(
    progressCallback?: ProgressCallback,
  ): Promise<ImportResult> {
    if (this.requireState().hasValidationErrors) {
      throw new Error("Fix validation errors before executing the import.");
    }

    const execute = this.adapter.execute?.bind(this.adapter);
    if (!execute) {
      throw new Error(
        `Import execution is not available for ${this.adapter.kind}.`,
      );
    }

    return execute({
      filePath: this.options.filePath,
      targetTable: this.options.targetTable,
      connectionDetails: this.options.connectionDetails,
      columnOptions: this.buildColumnOptions(),
      progressCallback,
    });
  }

  public dispose(): void {
    this.importer = undefined;
    this.state = undefined;
  }

  public getImporter(): TabularDataImporter {
    return this.requireImporter();
  }

  public getAdapter(): DatabaseImportWizardAdapter {
    return this.adapter;
  }

  private requireImporter(): TabularDataImporter {
    if (!this.importer) {
      throw new Error("Import wizard session is not initialized.");
    }
    return this.importer;
  }

  private requireState(): ImportWizardState {
    if (!this.state) {
      throw new Error("Import wizard session is not initialized.");
    }
    return this.state;
  }

  private buildTargetLocationCapabilities(): ImportTargetLocationCapabilitiesState {
    return getImportTargetLocationCapabilities(this.adapter.kind);
  }

  private async applyTargetLocation(state: ImportWizardState): Promise<void> {
    const targetTable = composeImportTargetTable(
      state.targetLocation,
      this.options.connectionDetails,
      this.adapter.kind,
    );
    this.options.targetTable = targetTable;
    state.targetTable = targetTable;
    this.requireImporter().updateTargetTable(targetTable);
    await this.refreshDerivedState();
  }

  private buildColumnOptions(): ImportColumnOptions {
    const state = this.requireState();
    const selectedColumnIndexes = state.columns
      .filter((column) => column.included)
      .map((column) => column.sourceIndex);
    const forcedColumnTypes: Record<number, string> = {};
    const columnNameOverrides: Record<number, string> = {};

    for (const column of state.columns) {
      if (!column.included) {
        continue;
      }
      if (column.selectedType !== column.inferredType) {
        forcedColumnTypes[column.sourceIndex] = column.selectedType;
      }
      if (column.targetName !== column.defaultTargetName) {
        columnNameOverrides[column.sourceIndex] = column.targetName;
      }
    }

    return {
      selectedColumnIndexes,
      forcedColumnTypes:
        Object.keys(forcedColumnTypes).length > 0
          ? forcedColumnTypes
          : undefined,
      columnNameOverrides:
        Object.keys(columnNameOverrides).length > 0
          ? columnNameOverrides
          : undefined,
    };
  }

  private buildPreviewRows(rawRows: readonly string[][]): string[][] {
    const columns = this.requireState().columns;
    return rawRows.map((row) =>
      columns.map((column) => row[column.sourceIndex] ?? ""),
    );
  }

  private async refreshDerivedState(
    rawPreviewRows?: string[][],
  ): Promise<void> {
    const importer = this.requireImporter();
    const state = this.requireState();
    const columnOptions = this.buildColumnOptions();
    importer.applyColumnOptions(columnOptions);

    // Fetch enough rows for both preview and validation to avoid redundant file reads
    const fetchCount = Math.max(
      state.previewRowCount,
      state.validationSampleSize,
    );
    const rawRows =
      rawPreviewRows ?? (await importer.getSampleRows(fetchCount));
    const previewRows = this.buildPreviewRows(
      rawRows.slice(0, state.previewRowCount),
    );
    const validationRows = this.buildPreviewRows(
      rawRows.slice(0, state.validationSampleSize),
    );
    const validation = this.validationService.validate(
      state.columns,
      validationRows,
      state.validationSampleSize,
      this.adapter,
    );

    const executionPlan = this.adapter.buildExecutionPlan({
      filePath: state.filePath,
      targetTable: state.targetTable,
      connectionDetails: this.options.connectionDetails,
      columns: importer.getEffectiveColumnDescriptors(),
      previewRows: rawRows,
      detectedDelimiter: importer.getCsvDelimiter(),
      decimalDelimiter: importer.getDecimalDelimiter(),
      columnOptions,
      importer,
    });

    state.previewRows = previewRows;
    state.issues = validation.issues;
    state.warnings = Array.from(
      new Set([...validation.warnings, ...executionPlan.warnings]),
    );
    state.hasValidationErrors = validation.hasErrors;
    state.executionPlan = executionPlan;
    state.detectedDelimiter = importer.getCsvDelimiter();
    state.decimalDelimiter = importer.getDecimalDelimiter() as "." | ",";
    state.sheetName = importer.getSelectedSheet() || state.sheetName;
  }
}
