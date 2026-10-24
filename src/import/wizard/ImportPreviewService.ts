import * as path from 'node:path';
import type { DatabaseImportWizardAdapter } from './adapters/DatabaseImportWizardAdapter';
import { createTabularDataImporter, type TabularDataImporter } from '../tabularDataImporter';
import type { ImportWizardColumn, ImportWizardFileFormat, ImportWizardSessionOptions } from './ImportWizardState';

export interface ImportPreviewSnapshot {
    importer: TabularDataImporter;
    fileFormat: ImportWizardFileFormat;
    sourceHeaders: string[];
    availableSheets: string[];
    sheetName?: string;
    detectedDelimiter?: string;
    decimalDelimiter: '.' | ',';
    columns: ImportWizardColumn[];
    rawPreviewRows: string[][];
}

function getFileFormat(filePath: string): ImportWizardFileFormat {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.xlsx') {
        return 'xlsx';
    }
    if (ext === '.xlsb') {
        return 'xlsb';
    }
    if (ext === '.txt') {
        return 'txt';
    }
    return 'csv';
}

function buildColumns(importer: TabularDataImporter, adapter: DatabaseImportWizardAdapter): ImportWizardColumn[] {
    return importer.getColumnMappings().map((mapping, index) => {
        const inferredType = adapter.mapInferredType(mapping.dataType);
        return {
            sourceIndex: index,
            sourceName: mapping.sourceColumn,
            targetName: mapping.targetColumn,
            defaultTargetName: mapping.targetColumn,
            included: true,
            order: index,
            inferredType,
            selectedType: inferredType,
            overrideMode: 'inferred',
        };
    });
}

export class ImportPreviewService {
    public async initialize(
        options: ImportWizardSessionOptions,
        adapter: DatabaseImportWizardAdapter,
    ): Promise<ImportPreviewSnapshot> {
        const importer = createTabularDataImporter(options.filePath, options.targetTable, {
            kind: options.connectionDetails.dbType,
            hasHeaders: options.hasHeaders,
        });
        // Type inference over a sample keeps the wizard responsive for large XLSX/XLSB/CSV files.
        importer.setAnalysisRowLimit(options.analysisRowLimit ?? 5000);

        const availableSheets = await importer.getAvailableSheetNames();
        const requestedSheet = options.sheetName?.trim();
        const matchedSheet = requestedSheet
            ? availableSheets.find(name => name === requestedSheet)
                ?? availableSheets.find(name => name.toLowerCase() === requestedSheet.toLowerCase())
            : undefined;
        if (matchedSheet) {
            importer.setSelectedSheet(matchedSheet);
        } else if (availableSheets.length > 0 && !importer.getSelectedSheet()) {
            importer.setSelectedSheet(availableSheets[0]);
        }

        return this.refresh(importer, adapter, options.previewRowCount, options.filePath);
    }

    public async refresh(
        importer: TabularDataImporter,
        adapter: DatabaseImportWizardAdapter,
        previewRowCount: number,
        filePath: string,
    ): Promise<ImportPreviewSnapshot> {
        await importer.analyzeDataTypes();
        const availableSheets = await importer.getAvailableSheetNames();
        const rawPreviewRows = await importer.getSampleRows(previewRowCount);
        return {
            importer,
            fileFormat: getFileFormat(filePath),
            sourceHeaders: importer.getSourceHeaders(),
            availableSheets,
            sheetName: importer.getSelectedSheet() || availableSheets[0],
            detectedDelimiter: importer.getCsvDelimiter(),
            decimalDelimiter: importer.getDecimalDelimiter() as '.' | ',',
            columns: buildColumns(importer, adapter),
            rawPreviewRows,
        };
    }
}
