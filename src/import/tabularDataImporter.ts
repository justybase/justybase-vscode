import type { DatabaseKind } from '../contracts/database';
import { normalizeDatabaseKind } from '../contracts/database';
import { formatIdentifierForSql, formatQualifiedObjectName } from '../utils/identifierUtils';
import {
    ImportColumnDescriptor,
    ImportColumnOptions,
    NetezzaImporter,
    normalizeAndValidateForcedType,
    type ProgressCallback
} from './dataImporter';
import { normalizeAndDeduplicateHeaders, normalizeImportedHeader } from './importHeaderUtils';

export interface TabularDataImporterOptions {
    kind?: string | DatabaseKind;
    logDir?: string;
}

function normalizeKind(kind?: string | DatabaseKind): DatabaseKind | undefined {
    return kind ? normalizeDatabaseKind(kind) : undefined;
}

function normalizeSelectedColumnIndexes(indexes: readonly number[], totalColumns: number): number[] {
    const seen = new Set<number>();
    const normalized: number[] = [];

    for (const rawIndex of indexes) {
        const index = Number(rawIndex);
        if (!Number.isInteger(index) || index < 0 || index >= totalColumns || seen.has(index)) {
            continue;
        }
        seen.add(index);
        normalized.push(index);
    }

    return normalized;
}

function buildQualifiedTargetTableName(targetTable: string, kind?: DatabaseKind): string {
    const parts = targetTable
        .split('.')
        .map(part => part.trim())
        .filter(part => part.length > 0);

    if (parts.length === 0 || parts.length > 3) {
        throw new Error('Invalid target table format. Use TABLE, SCHEMA.TABLE, or DATABASE.SCHEMA.TABLE.');
    }

    if (parts.length === 1) {
        return formatIdentifierForSql(parts[0], kind);
    }

    if (parts.length === 2) {
        return formatQualifiedObjectName(undefined, parts[0], parts[1], kind);
    }

    return formatQualifiedObjectName(parts[0], parts[1], parts[2], kind);
}

export class TabularDataImporter {
    private readonly importer: NetezzaImporter;
    private readonly kind?: DatabaseKind;
    private targetTable: string;
    private normalizedHeaders: string[] = [];
    private inferredTypes: string[] = [];
    private selectedColumnIndexes: number[] = [];
    private forcedColumnTypes = new Map<number, string>();
    private columnNameOverrides = new Map<number, string>();

    public constructor(filePath: string, targetTable: string, options?: string | TabularDataImporterOptions) {
        const resolvedOptions = typeof options === 'string'
            ? { logDir: options }
            : options;
        this.kind = normalizeKind(resolvedOptions?.kind);
        this.targetTable = targetTable;
        this.importer = new NetezzaImporter(filePath, targetTable, resolvedOptions?.logDir);
    }

    private refreshInferredState(): void {
        const sourceHeaders = this.importer.getSourceHeaders();
        this.normalizedHeaders = normalizeAndDeduplicateHeaders(sourceHeaders, this.kind);

        const mappings = typeof this.importer.getColumnMappings === 'function'
            ? this.importer.getColumnMappings()
            : this.normalizedHeaders.map((header, index) => ({
                sourceColumn: sourceHeaders[index] || header,
                targetColumn: header,
                dataType: 'NVARCHAR(255)'
            }));
        this.inferredTypes = this.normalizedHeaders.map(
            (_header, index) => mappings[index]?.dataType || 'NVARCHAR(255)'
        );
    }

    private ensureAnalyzed(): void {
        if (this.normalizedHeaders.length === 0) {
            this.refreshInferredState();
        }
    }

    private getAllColumnIndexes(): number[] {
        this.ensureAnalyzed();
        return this.normalizedHeaders.map((_header, index) => index);
    }

    private getEffectiveColumnIndexes(): number[] {
        return this.selectedColumnIndexes.length > 0 ? this.selectedColumnIndexes : this.getAllColumnIndexes();
    }

    private getEffectiveColumnName(index: number): string {
        return this.columnNameOverrides.get(index) || this.normalizedHeaders[index] || `COLUMN_${index + 1}`;
    }

    private getEffectiveDataType(index: number): string {
        return this.forcedColumnTypes.get(index) || this.inferredTypes[index] || 'NVARCHAR(255)';
    }

    private buildDelegateColumnOptions(): ImportColumnOptions {
        return {
            selectedColumnIndexes: this.getEffectiveColumnIndexes(),
            forcedColumnTypes: Object.fromEntries(this.forcedColumnTypes.entries()),
            columnNameOverrides: Object.fromEntries(this.columnNameOverrides.entries()),
        };
    }

    public async analyzeDataTypes(progressCallback?: ProgressCallback): Promise<unknown[]> {
        const analyzedTypes = await this.importer.analyzeDataTypes(progressCallback);
        this.refreshInferredState();
        return analyzedTypes;
    }

    public applyColumnOptions(options?: ImportColumnOptions): void {
        this.ensureAnalyzed();
        this.selectedColumnIndexes = [];
        this.forcedColumnTypes.clear();
        this.columnNameOverrides.clear();

        if (!options) {
            return;
        }

        const allIndexes = this.getAllColumnIndexes();
        const selectedIndexes = options.selectedColumnIndexes && options.selectedColumnIndexes.length > 0
            ? normalizeSelectedColumnIndexes(options.selectedColumnIndexes, this.normalizedHeaders.length)
            : allIndexes;

        if (selectedIndexes.length === 0) {
            throw new Error('No valid columns selected for import.');
        }

        this.selectedColumnIndexes = selectedIndexes;

        if (options.forcedColumnTypes) {
            for (const [rawIndex, rawType] of Object.entries(options.forcedColumnTypes)) {
                const index = Number(rawIndex);
                if (!this.selectedColumnIndexes.includes(index) || !rawType || !rawType.trim()) {
                    continue;
                }
                this.forcedColumnTypes.set(index, normalizeAndValidateForcedType(rawType));
            }
        }

        if (options.columnNameOverrides) {
            for (const [rawIndex, rawColumnName] of Object.entries(options.columnNameOverrides)) {
                const index = Number(rawIndex);
                if (!this.selectedColumnIndexes.includes(index)) {
                    continue;
                }
                const normalizedColumnName = normalizeImportedHeader(rawColumnName || '', this.kind);
                if (!normalizedColumnName) {
                    continue;
                }
                this.columnNameOverrides.set(index, normalizedColumnName);
            }
        }
    }

    public getImportColumnCount(): number {
        return this.getEffectiveColumnIndexes().length;
    }

    public getEffectiveColumnDescriptors(): ImportColumnDescriptor[] {
        return this.getEffectiveColumnIndexes().map(index => ({
            sourceIndex: index,
            columnName: this.getEffectiveColumnName(index),
            dataType: this.getEffectiveDataType(index),
        }));
    }

    public getColumnMappings(): Array<{ sourceColumn: string; targetColumn: string; dataType: string }> {
        this.ensureAnalyzed();
        const sourceHeaders = this.importer.getSourceHeaders();
        const maxColumns = Math.max(this.normalizedHeaders.length, this.inferredTypes.length, sourceHeaders.length);

        return Array.from({ length: maxColumns }, (_unused, index) => ({
            sourceColumn: sourceHeaders[index] || this.normalizedHeaders[index] || `COLUMN_${index + 1}`,
            targetColumn: this.getEffectiveColumnName(index),
            dataType: this.getEffectiveDataType(index),
        }));
    }

    public getRowsCount(): number {
        return this.importer.getRowsCount();
    }

    public getSqlHeaders(): string[] {
        this.ensureAnalyzed();
        return [...this.normalizedHeaders];
    }

    public getSourceHeaders(): string[] {
        return this.importer.getSourceHeaders();
    }

    public async getAvailableSheetNames(): Promise<string[]> {
        return this.importer.getAvailableSheetNames();
    }

    public setSelectedSheet(sheetName?: string): void {
        this.importer.setSelectedSheet(sheetName);
        this.normalizedHeaders = [];
        this.inferredTypes = [];
        this.selectedColumnIndexes = [];
        this.forcedColumnTypes.clear();
        this.columnNameOverrides.clear();
    }

    public getSelectedSheet(): string | undefined {
        return this.importer.getSelectedSheet();
    }

    public getDecimalDelimiter(): string {
        return this.importer.getDecimalDelimiter();
    }

    public getCsvDelimiter(): string {
        return this.importer.getCsvDelimiter();
    }

    public async getSampleRows(limit: number = 5): Promise<string[][]> {
        return this.importer.getSampleRows(limit);
    }

    public async getAllRows(): Promise<string[][]> {
        return this.importer.getAllRows();
    }

    public getDelegate(): NetezzaImporter {
        return this.importer;
    }

    public updateTargetTable(targetTable: string): void {
        this.targetTable = targetTable;
        this.importer.updateTargetTable(targetTable);
    }

    public generateCreateTableSql(): string {
        if (!this.kind || this.kind === 'netezza') {
            this.importer.applyColumnOptions(this.buildDelegateColumnOptions());
            return this.importer.generateCreateTableSql();
        }

        const columns = this.getEffectiveColumnDescriptors();
        if (columns.length === 0) {
            throw new Error('No columns selected for import.');
        }

        const qualifiedTableName = buildQualifiedTargetTableName(this.targetTable, this.kind);
        const columnDefinitions = columns.map(column =>
            `    ${formatIdentifierForSql(column.columnName, this.kind)} ${column.dataType}`
        );

        return `CREATE TABLE ${qualifiedTableName} (\n${columnDefinitions.join(',\n')}\n)`;
    }
}

export function createTabularDataImporter(
    filePath: string,
    targetTable: string,
    options?: string | TabularDataImporterOptions
): TabularDataImporter {
    return new TabularDataImporter(filePath, targetTable, options);
}
