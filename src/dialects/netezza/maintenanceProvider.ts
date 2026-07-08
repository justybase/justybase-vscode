import * as vscode from 'vscode';
import type { DatabaseMaintenanceProvider } from '../../contracts/database';

export const netezzaMaintenanceProvider: DatabaseMaintenanceProvider = {
    async groomTable(target, services): Promise<void> {
        const mode = await vscode.window.showQuickPick(
            [
                { label: 'RECORDS ALL', description: 'Groom all records (reclaim space from deleted rows)' },
                { label: 'RECORDS READY', description: 'Groom only ready records' },
                { label: 'PAGES ALL', description: 'Groom all pages (reorganize data pages)' },
                { label: 'PAGES START', description: 'Groom pages from start' },
                { label: 'VERSIONS', description: 'Groom versions (clean up old row versions)' },
            ],
            {
                placeHolder: 'Select GROOM mode',
            }
        );

        if (!mode) {
            return;
        }

        const backupsetOption = await vscode.window.showQuickPick(
            [
                { label: 'DEFAULT', description: 'Use default backupset', value: 'DEFAULT' },
                { label: 'NONE', description: 'No backupset', value: 'NONE' },
                { label: 'Custom', description: 'Specify custom backupset ID', value: 'CUSTOM' },
            ],
            {
                placeHolder: 'Select RECLAIM BACKUPSET option',
            }
        );

        if (!backupsetOption) {
            return;
        }

        let backupsetValue = backupsetOption.value;
        if (backupsetOption.value === 'CUSTOM') {
            const customId = await vscode.window.showInputBox({
                prompt: 'Enter backupset ID',
                placeHolder: 'e.g. 12345',
                validateInput: (value) => {
                    if (!value || value.trim().length === 0) {
                        return 'Backupset ID cannot be empty';
                    }
                    if (!/^\d+$/.test(value.trim())) {
                        return 'Backupset ID must be a number';
                    }
                    return null;
                },
            });

            if (!customId) {
                return;
            }

            backupsetValue = customId.trim();
        }

        const sql = `GROOM TABLE ${target.qualifiedName} ${mode.label} RECLAIM BACKUPSET ${backupsetValue};`;
        const confirmation = await vscode.window.showWarningMessage(
            `Execute GROOM on table "${target.qualifiedName}"?\n\n${sql}\n\nWarning: This operation may be time-consuming for large tables.`,
            { modal: true },
            'Yes, execute',
            'Cancel'
        );

        if (confirmation !== 'Yes, execute') {
            return;
        }

        await services.executeAndReport(
            target,
            sql,
            `GROOM TABLE ${target.qualifiedName} (${mode.label})...`,
            'GROOM completed successfully',
            'Error during GROOM'
        );
    },

    async generateStatistics(target, services): Promise<void> {
        const mode = await vscode.window.showQuickPick(
            [
                {
                    label: 'EXPRESS',
                    description: 'Fast sample statistics (recommended for routine refresh)',
                    value: 'express',
                },
                {
                    label: 'FULL',
                    description: 'Full statistics scan (higher cost, better precision)',
                    value: 'full',
                },
            ],
            {
                placeHolder: 'Select statistics mode',
            }
        );

        if (!mode) {
            return;
        }

        let sql: string;
        if (mode.value === 'express') {
            sql = `GENERATE EXPRESS STATISTICS ON ${target.qualifiedName};`;
        } else {
            const columnList = await vscode.window.showInputBox({
                prompt: 'Optional column list for FULL statistics',
                placeHolder: 'e.g. col1, col2 (leave empty for all columns)',
                validateInput: (value) => {
                    if (!value || value.trim().length === 0) {
                        return null;
                    }
                    const trimmed = value.trim();
                    if (!/^[A-Za-z_][A-Za-z0-9_]*(\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*$/.test(trimmed)) {
                        return 'Use comma-separated column names (letters, numbers, underscores).';
                    }
                    return null;
                },
            });

            if (columnList === undefined) {
                return;
            }

            const normalizedColumns = columnList.trim();
            sql =
                normalizedColumns.length > 0
                    ? `GENERATE STATISTICS ON ${target.qualifiedName} (${normalizedColumns});`
                    : `GENERATE STATISTICS ON ${target.qualifiedName};`;
        }

        const confirmation = await vscode.window.showInformationMessage(
            `Generate statistics for table "${target.qualifiedName}"?\n\n${sql}`,
            { modal: true },
            'Yes, generate',
            'Cancel'
        );

        if (confirmation !== 'Yes, generate') {
            return;
        }

        await services.executeAndReport(
            target,
            sql,
            `Generating ${mode.label} statistics for ${target.qualifiedName}...`,
            'Statistics generated successfully',
            'Error generating statistics'
        );
    },

    async checkSkew(target, services): Promise<void> {
        const sql = `SELECT datasliceid, count(*) as row_count FROM ${target.qualifiedName} GROUP BY 1 ORDER BY 1;`;
        const confirmation = await vscode.window.showInformationMessage(
            `Check skew for "${target.qualifiedName}"?\n\nThis will run: ${sql}\n\nNote: This may be slow on very large tables.`,
            { modal: true },
            'Yes, check skew',
            'Cancel'
        );

        if (confirmation !== 'Yes, check skew') {
            return;
        }

        await services.openSqlDocument(`-- Check Skew for ${target.qualifiedName}\n${sql}`, 'sql');
        void vscode.commands.executeCommand('netezza.runQuery').then(undefined, (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to execute query: ${message}`);
        });
    },

    async recreateTable(target, services): Promise<void> {
        const connectionDetails = await services.getConnectionDetails(target.connectionName);
        if (!connectionDetails) {
            vscode.window.showErrorMessage('Connection not configured. Please connect via Netezza: Connect...');
            return;
        }

        const newNameInput = await vscode.window.showInputBox({
            prompt: 'Enter temporary table name (Optional)',
            placeHolder: 'Leave empty to auto-generate timestamped name',
            value: '',
        });

        if (newNameInput === undefined) {
            return;
        }

        try {
            const result = await services.executeWithProgress(
                `Generating Recreate Script for ${target.tableName}...`,
                async () => {
                    const { generateRecreateTableScript } = await import('../../schema/tableRecreator');
                    return generateRecreateTableScript(
                        connectionDetails,
                        target.databaseName,
                        target.schemaName,
                        target.tableName,
                        newNameInput || undefined
                    );
                }
            );

            if (!result.success || !result.sqlScript) {
                throw new Error(result.error || 'Script generation failed');
            }

            await services.openSqlDocument(result.sqlScript, 'sql');
            vscode.window.showInformationMessage(`Recreate script generated for ${target.tableName}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Error generating recreate script: ${message}`);
        }
    },
};
