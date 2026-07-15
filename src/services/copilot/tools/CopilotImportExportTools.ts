import * as fs from 'fs';
import * as path from 'path';
import { createTabularDataImporter } from '../../../import/tabularDataImporter';

interface StructuredToolPayload {
    summary: string;
    data?: Record<string, unknown>;
    errors?: string[];
    nextActions?: string[];
}

interface CopilotImportExportToolsDeps {
    formatStructuredToolResponse: (payload: StructuredToolPayload) => string;
}

/** Local file inspection and mapping only; AI never imports or exports data. */
export class CopilotImportExportTools {
    constructor(private readonly deps: CopilotImportExportToolsDeps) { }

    async inspectImportFile(filePath: string, sampleRows: number = 5): Promise<string> {
        const resolvedPath = filePath.trim();
        if (!fs.existsSync(resolvedPath)) {
            return this.deps.formatStructuredToolResponse({
                summary: 'Import inspection failed.',
                errors: [`File not found: ${resolvedPath}`],
                nextActions: ['Check the path and inspect the file again.']
            });
        }

        const importer = createTabularDataImporter(resolvedPath, 'COPILOT_IMPORT_PREVIEW');
        await importer.analyzeDataTypes();
        const previewLimit = Math.max(1, Math.min(sampleRows || 5, 20));
        const mappings = importer.getColumnMappings();
        const stats = fs.statSync(resolvedPath);

        return this.deps.formatStructuredToolResponse({
            summary: `Inspected import file "${path.basename(resolvedPath)}" (${mappings.length} columns detected).`,
            data: {
                filePath: resolvedPath,
                fileSizeBytes: stats.size,
                fileFormat: path.extname(resolvedPath).toLowerCase(),
                detectedDelimiter: importer.getCsvDelimiter(),
                detectedDecimalDelimiter: importer.getDecimalDelimiter(),
                rowCountEstimate: importer.getRowsCount(),
                columns: mappings,
                sampleRows: await importer.getSampleRows(previewLimit)
            },
            nextActions: [
                'Use propose_import_mapping with the target table name.',
                'Run the import yourself from the extension Import command after reviewing the mapping.'
            ]
        });
    }

    async proposeImportMapping(filePath: string, targetTable: string): Promise<string> {
        const resolvedPath = filePath.trim();
        const normalizedTargetTable = targetTable.trim();
        if (!fs.existsSync(resolvedPath)) {
            return this.deps.formatStructuredToolResponse({
                summary: 'Mapping proposal failed.',
                errors: [`File not found: ${resolvedPath}`],
                nextActions: ['Check the file path and retry.']
            });
        }

        const importer = createTabularDataImporter(resolvedPath, normalizedTargetTable);
        await importer.analyzeDataTypes();
        return this.deps.formatStructuredToolResponse({
            summary: `Proposed import mapping for ${importer.getColumnMappings().length} column(s) into ${normalizedTargetTable}.`,
            data: {
                filePath: resolvedPath,
                targetTable: normalizedTargetTable,
                detectedDelimiter: importer.getCsvDelimiter(),
                detectedDecimalDelimiter: importer.getDecimalDelimiter(),
                rowCountEstimate: importer.getRowsCount(),
                mapping: importer.getColumnMappings(),
                proposedCreateTableSql: importer.generateCreateTableSql()
            },
            nextActions: [
                'Review the proposed DDL and mapping.',
                'Run the import manually from the extension Import command; AI will not execute it.'
            ]
        });
    }
}
