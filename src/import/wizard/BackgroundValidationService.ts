import type { DatabaseImportWizardAdapter } from "./adapters/DatabaseImportWizardAdapter";
import { getBaseImportTypeName } from "./adapters/DatabaseImportWizardAdapter";
import type {
  BackgroundValidationProgress,
  BackgroundValidationStatus,
  ImportWizardCellIssue,
  ImportWizardColumn,
  ImportWizardValidationSummary,
} from "./ImportWizardState";
import type { TabularDataImporter } from "../tabularDataImporter";

function normalizeDateCandidate(value: string): string | null {
  const isoMatch = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  const localMatch = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (!localMatch) {
    return null;
  }

  const [, day, month, year] = localMatch;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function normalizeTimestampCandidate(value: string): string | null {
  const normalized = value.replace("T", " ").trim();
  const isoMatch = normalized.match(
    /^(\d{4}-\d{1,2}-\d{1,2})(?:\s+(\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?$/,
  );
  if (isoMatch) {
    const [, datePart, hour = "00", minute = "00", second = "00"] = isoMatch;
    const normalizedDate = normalizeDateCandidate(datePart);
    return normalizedDate
      ? `${normalizedDate} ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}:${second.padStart(2, "0")}`
      : null;
  }

  const localMatch = normalized.match(
    /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s+(\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?$/,
  );
  if (!localMatch) {
    return null;
  }

  const [, day, month, year, hour = "00", minute = "00", second = "00"] =
    localMatch;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")} ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}:${second.padStart(2, "0")}`;
}

function isRealDate(value: string): boolean {
  const normalized = normalizeDateCandidate(value);
  if (!normalized) {
    return false;
  }

  const [yearText, monthText, dayText] = normalized.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(`${normalized}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() + 1 === month &&
    parsed.getUTCDate() === day
  );
}

function isRealTimestamp(value: string): boolean {
  const normalized = normalizeTimestampCandidate(value);
  if (!normalized) {
    return false;
  }

  const parsed = new Date(normalized.replace(" ", "T") + "Z");
  return !Number.isNaN(parsed.getTime());
}

function validateValue(value: string, typeName: string): string | null {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return null;
  }

  const baseType = getBaseImportTypeName(typeName);

  if (
    ["INT", "INTEGER", "BIGINT", "SMALLINT", "TINYINT", "NUMBER"].includes(
      baseType,
    )
  ) {
    return /^[-+]?\d+$/.test(trimmed) ? null : "Expected an integer value.";
  }

  if (
    [
      "NUMERIC",
      "DECIMAL",
      "REAL",
      "DOUBLE",
      "FLOAT",
      "DOUBLE PRECISION",
      "MONEY",
      "SMALLMONEY",
      "DECFLOAT",
    ].includes(baseType)
  ) {
    return /^[-+]?\d+(?:[.,]\d+)?$/.test(trimmed)
      ? null
      : "Expected a numeric value.";
  }

  if (["BOOLEAN", "BOOL", "BIT"].includes(baseType)) {
    return /^(true|false|1|0|yes|no|y|n|t|f)$/i.test(trimmed)
      ? null
      : "Expected a boolean value.";
  }

  if (baseType === "DATE") {
    return isRealDate(trimmed) ? null : "Expected a valid date value.";
  }

  if (
    ["TIMESTAMP", "DATETIME", "DATETIME2", "TIMESTAMP_NTZ"].includes(baseType)
  ) {
    return isRealTimestamp(trimmed)
      ? null
      : "Expected a valid timestamp value.";
  }

  return null;
}

export interface BackgroundValidationJob {
  sessionId: string;
  columns: readonly ImportWizardColumn[];
  importer: TabularDataImporter;
  adapter: DatabaseImportWizardAdapter;
  sampleSize: number;
  progressCallback: (
    progress: BackgroundValidationProgress,
    summary?: ImportWizardValidationSummary,
  ) => void;
}

export interface BackgroundValidationResult {
  sessionId: string;
  summary: ImportWizardValidationSummary;
  rowsValidated: number;
  duration: number;
}

const YIELD_INTERVAL = 100;
const MIN_PROGRESS_INTERVAL_MS = 200;

export class BackgroundValidationService {
  private readonly activeJobs = new Map<
    string,
    {
      token: symbol;
      job: BackgroundValidationJob;
      cancelled: boolean;
      phase: BackgroundValidationProgress["phase"];
      rowsProcessed: number;
      totalRows: number;
      issuesFound: number;
      startTime: number;
    }
  >();

  public startValidation(job: BackgroundValidationJob): void {
    if (this.activeJobs.has(job.sessionId)) {
      this.cancelValidation(job.sessionId);
    }

    const token = Symbol(job.sessionId);
    this.activeJobs.set(job.sessionId, {
      token,
      job,
      cancelled: false,
      phase: "starting",
      rowsProcessed: 0,
      totalRows: job.sampleSize,
      issuesFound: 0,
      startTime: Date.now(),
    });
    void this.runValidation(job, token);
  }

  public cancelValidation(sessionId: string): void {
    const entry = this.activeJobs.get(sessionId);
    if (entry) {
      entry.cancelled = true;
    }
  }

  public isValidationActive(sessionId: string): boolean {
    const entry = this.activeJobs.get(sessionId);
    return entry !== undefined && !entry.cancelled;
  }

  public getStatus(sessionId: string): BackgroundValidationStatus | undefined {
    const entry = this.activeJobs.get(sessionId);
    if (!entry) {
      return undefined;
    }
    return {
      isActive: !entry.cancelled,
      progress: {
        phase: entry.cancelled ? "cancelled" : entry.phase,
        rowsProcessed: entry.rowsProcessed,
        totalRows: entry.totalRows,
        issuesFound: entry.issuesFound,
      },
      startTime: entry.startTime,
    };
  }

  private async runValidation(
    job: BackgroundValidationJob,
    token: symbol,
  ): Promise<void> {
    const {
      sessionId,
      columns,
      importer,
      adapter,
      sampleSize,
      progressCallback,
    } = job;

    const getTrackedEntry = ():
      | {
          token: symbol;
          job: BackgroundValidationJob;
          cancelled: boolean;
          phase: BackgroundValidationProgress["phase"];
          rowsProcessed: number;
          totalRows: number;
          issuesFound: number;
          startTime: number;
        }
      | undefined => {
      const entry = this.activeJobs.get(sessionId);
      return entry?.token === token ? entry : undefined;
    };

    const updateEntry = (
      rows: number,
      issues: number,
      phase?: BackgroundValidationProgress["phase"],
      totalRowsOverride?: number,
    ): void => {
      const entry = this.activeJobs.get(sessionId);
      if (entry?.token === token) {
        entry.rowsProcessed = rows;
        entry.issuesFound = issues;
        if (phase) {
          entry.phase = phase;
        }
        if (typeof totalRowsOverride === "number") {
          entry.totalRows = totalRowsOverride;
        }
      }
    };

    const reportProgress = (
      progress: BackgroundValidationProgress,
      summary?: ImportWizardValidationSummary,
    ): void => {
      const entry = getTrackedEntry();
      if (!entry) {
        return;
      }

      updateEntry(
        progress.rowsProcessed,
        progress.issuesFound,
        progress.phase,
        progress.totalRows,
      );
      if (!entry.cancelled || progress.phase === "cancelled") {
        progressCallback(progress, summary);
      }
    };

    try {
      reportProgress({
        phase: "reading",
        rowsProcessed: 0,
        totalRows: sampleSize,
        issuesFound: 0,
      });

      const rawRows = await importer.getSampleRows(sampleSize);

      const entry = getTrackedEntry();
      if (!entry || entry.cancelled) {
        if (entry?.cancelled) {
          reportProgress({
            phase: "cancelled",
            rowsProcessed: 0,
            totalRows: sampleSize,
            issuesFound: 0,
          });
        }
        return;
      }

      const totalRows = rawRows.length;
      const issues: ImportWizardCellIssue[] = [];
      const warnings: string[] = [];
      let lastProgressTime = Date.now();

      reportProgress({
        phase: "validating",
        rowsProcessed: 0,
        totalRows,
        issuesFound: 0,
      });

      for (let rowIndex = 0; rowIndex < totalRows; rowIndex += 1) {
        const currentEntry = getTrackedEntry();
        if (!currentEntry || currentEntry.cancelled) {
          if (currentEntry?.cancelled) {
            reportProgress({
              phase: "cancelled",
              rowsProcessed: rowIndex,
              totalRows,
              issuesFound: issues.length,
            });
          }
          return;
        }

        const row = rawRows[rowIndex] || [];
        for (
          let columnIndex = 0;
          columnIndex < columns.length;
          columnIndex += 1
        ) {
          const column = columns[columnIndex];
          if (!column.included) {
            continue;
          }

          const value = row[column.sourceIndex] ?? "";
          const validationMessage = validateValue(value, column.selectedType);
          if (!validationMessage) {
            continue;
          }

          issues.push({
            rowIndex,
            columnIndex,
            sourceIndex: column.sourceIndex,
            severity: "error",
            message: validationMessage,
            value,
          });
        }

        updateEntry(rowIndex + 1, issues.length);

        if (rowIndex % YIELD_INTERVAL === 0) {
          const now = Date.now();
          if (now - lastProgressTime >= MIN_PROGRESS_INTERVAL_MS) {
            reportProgress({
              phase: "validating",
              rowsProcessed: rowIndex + 1,
              totalRows,
              issuesFound: issues.length,
            });
            lastProgressTime = now;
          }
          await this.yieldToEventLoop();
        }
      }

      const columnWarnings = this.validateColumns(columns, adapter);
      warnings.push(...columnWarnings);

      const hasColumnErrors = columnWarnings.some(
        (w) => w.includes("must have") || w.includes("Duplicate"),
      );

      const summary: ImportWizardValidationSummary = {
        issues,
        warnings,
        hasErrors: issues.length > 0 || hasColumnErrors,
      };

      reportProgress({
        phase: "complete",
        rowsProcessed: totalRows,
        totalRows,
        issuesFound: issues.length,
      }, summary);
    } finally {
      const entry = this.activeJobs.get(sessionId);
      if (entry?.token === token) {
        this.activeJobs.delete(sessionId);
      }
    }
  }

  private validateColumns(
    columns: readonly ImportWizardColumn[],
    adapter: DatabaseImportWizardAdapter,
  ): string[] {
    const warnings: string[] = [];
    const includedColumns = columns.filter((column) => column.included);

    if (includedColumns.length === 0) {
      warnings.push("Select at least one column to import.");
      return warnings;
    }

    const seenTargetNames = new Map<string, string>();
    for (const column of includedColumns) {
      const normalizedTarget = column.targetName.trim().toUpperCase();
      if (!normalizedTarget) {
        warnings.push(`Column "${column.sourceName}" must have a target name.`);
        continue;
      }

      const existing = seenTargetNames.get(normalizedTarget);
      if (existing) {
        warnings.push(
          `Duplicate target column name detected: ${column.targetName}.`,
        );
      } else {
        seenTargetNames.set(normalizedTarget, column.targetName);
      }

      const typeIssues = adapter.validateTypeOverride(column.selectedType);
      for (const typeIssue of typeIssues) {
        warnings.push(`${column.targetName}: ${typeIssue.message}`);
      }
    }

    return warnings;
  }

  private yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }
}

export const backgroundValidationService = new BackgroundValidationService();
