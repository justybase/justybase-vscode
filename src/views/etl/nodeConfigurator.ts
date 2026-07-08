/**
 * ETL Designer - Node Configurator
 * Handles dialog-based configuration for ETL nodes
 */

import * as vscode from 'vscode';
import { EtlNode, EtlNodeType } from '../../etl/etlTypes';
import { EtlProjectManager } from '../../etl/etlProjectManager';

/**
 * Callback function to notify when project is updated
 */
export type OnProjectUpdateCallback = () => void;

/**
 * Handles the configuration of ETL nodes through VS Code dialogs
 */
export class NodeConfigurator {
    constructor(
        private projectManager: EtlProjectManager,
        private onUpdate: OnProjectUpdateCallback
    ) { }

    /**
     * Opens configuration dialog for the specified node
     */
    async configureNode(nodeId: string): Promise<void> {
        const node = this.projectManager.getNode(nodeId);
        if (!node) {
            return;
        }

        switch (node.type) {
            case 'sql':
                await this.configureSqlNode(node, nodeId);
                break;
            case 'python':
                await this.configurePythonNode(node, nodeId);
                break;
            case 'export':
                await this.configureExportNode(node, nodeId);
                break;
            case 'import':
                await this.configureImportNode(node, nodeId);
                break;
            case 'variable':
                await this.configureVariableNode(node, nodeId);
                break;
        }
    }

    /**
     * Gets the default name for a node type
     */
    getDefaultNodeName(type: EtlNodeType): string {
        const names: Record<EtlNodeType, string> = {
            sql: 'SQL Task',
            python: 'Python Script',
            container: 'Container',
            export: 'Export Data',
            import: 'Import Data',
            variable: 'Variable'
        };
        return names[type] || 'New Task';
    }

    private async configureSqlNode(node: EtlNode, nodeId: string): Promise<void> {
        const config = node.config as { type: 'sql'; query: string; connection?: string; timeout?: number };

        // Ask for task name first
        const name = await vscode.window.showInputBox({
            prompt: 'Enter task name',
            value: node.name,
            placeHolder: 'e.g. Load Customer Data'
        });
        if (name === undefined) return;

        const query = await vscode.window.showInputBox({
            prompt: 'Enter SQL query',
            value: config.query,
            placeHolder: 'SELECT * FROM table_name'
        });
        if (query !== undefined) {
            const timeoutStr = await vscode.window.showInputBox({
                prompt: 'Enter execution timeout in seconds (optional)',
                value: config.timeout ? String(config.timeout) : '',
                placeHolder: 'e.g. 60'
            });

            const timeout = timeoutStr && !isNaN(parseInt(timeoutStr)) ? parseInt(timeoutStr) : undefined;

            this.projectManager.updateNode(nodeId, {
                name,
                config: { ...config, query, timeout }
            });
            this.onUpdate();
        }
    }

    private async configurePythonNode(node: EtlNode, nodeId: string): Promise<void> {
        const config = node.config as { type: 'python'; script: string; scriptPath?: string; timeout?: number };

        // Ask for task name first
        const name = await vscode.window.showInputBox({
            prompt: 'Enter task name',
            value: node.name,
            placeHolder: 'e.g. Transform Data'
        });
        if (name === undefined) return;

        const choice = await vscode.window.showQuickPick(
            ['Enter script inline', 'Select script file'],
            { placeHolder: 'How to provide the Python script?' }
        );

        if (choice === 'Enter script inline') {
            const script = await vscode.window.showInputBox({
                prompt: 'Enter Python script',
                value: config.script,
                placeHolder: 'print("Hello ETL")'
            });
            if (script !== undefined) {
                const timeoutStr = await vscode.window.showInputBox({
                    prompt: 'Enter execution timeout in seconds (optional)',
                    value: config.timeout ? String(config.timeout) : '',
                    placeHolder: 'e.g. 60'
                });
                const timeout = timeoutStr && !isNaN(parseInt(timeoutStr)) ? parseInt(timeoutStr) : undefined;

                this.projectManager.updateNode(nodeId, {
                    name,
                    config: { ...config, script, scriptPath: undefined, timeout }
                });
                this.onUpdate();
            }
        } else if (choice === 'Select script file') {
            const files = await vscode.window.showOpenDialog({
                filters: { 'Python': ['py'] },
                canSelectMany: false
            });
            if (files && files[0]) {
                const timeoutStr = await vscode.window.showInputBox({
                    prompt: 'Enter execution timeout in seconds (optional)',
                    value: config.timeout ? String(config.timeout) : '',
                    placeHolder: 'e.g. 60'
                });
                const timeout = timeoutStr && !isNaN(parseInt(timeoutStr)) ? parseInt(timeoutStr) : undefined;

                this.projectManager.updateNode(nodeId, {
                    name,
                    config: { ...config, scriptPath: files[0].fsPath, script: '', timeout }
                });
                this.onUpdate();
            }
        }
    }

    private async configureExportNode(node: EtlNode, nodeId: string): Promise<void> {
        const config = node.config as { type: 'export'; format: 'csv' | 'xlsb'; outputPath: string; query?: string; timeout?: number };

        // Ask for task name first
        const name = await vscode.window.showInputBox({
            prompt: 'Enter task name',
            value: node.name,
            placeHolder: 'e.g. Export to CSV'
        });
        if (name === undefined) return;

        const format = await vscode.window.showQuickPick(
            ['csv', 'xlsb'],
            { placeHolder: 'Select output format' }
        ) as 'csv' | 'xlsb' | undefined;

        if (format) {
            const outputPath = await vscode.window.showSaveDialog({
                filters: format === 'csv' ? { 'CSV': ['csv'] } : { 'Excel Binary': ['xlsb'] }
            });

            if (outputPath) {
                const query = await vscode.window.showInputBox({
                    prompt: 'Enter SQL query for export',
                    value: config.query || '',
                    placeHolder: 'SELECT * FROM table_name'
                });

                if (query !== undefined) {
                    const timeoutStr = await vscode.window.showInputBox({
                        prompt: 'Enter execution timeout in seconds (optional)',
                        value: config.timeout ? String(config.timeout) : '',
                        placeHolder: 'e.g. 300'
                    });
                    const timeout = timeoutStr && !isNaN(parseInt(timeoutStr)) ? parseInt(timeoutStr) : undefined;

                    this.projectManager.updateNode(nodeId, {
                        name,
                        config: { ...config, format, outputPath: outputPath.fsPath, query, timeout }
                    });
                    this.onUpdate();
                }
            }
        }
    }

    private async configureImportNode(node: EtlNode, nodeId: string): Promise<void> {
        const config = node.config as { type: 'import'; format: 'csv' | 'xlsb'; inputPath: string; targetTable: string; timeout?: number };

        // Ask for task name first
        const name = await vscode.window.showInputBox({
            prompt: 'Enter task name',
            value: node.name,
            placeHolder: 'e.g. Import Products'
        });
        if (name === undefined) return;

        const files = await vscode.window.showOpenDialog({
            filters: {
                'Data Files': ['csv', 'xlsb'],
                'CSV': ['csv'],
                'Excel Binary': ['xlsb']
            },
            canSelectMany: false
        });

        if (files && files[0]) {
            const inputPath = files[0].fsPath;
            const format = inputPath.endsWith('.xlsb') ? 'xlsb' : 'csv';

            const targetTable = await vscode.window.showInputBox({
                prompt: 'Enter target table name',
                value: config.targetTable,
                placeHolder: 'SCHEMA.TABLE_NAME'
            });

            if (targetTable) {
                const timeoutStr = await vscode.window.showInputBox({
                    prompt: 'Enter execution timeout in seconds (optional)',
                    value: config.timeout ? String(config.timeout) : '',
                    placeHolder: 'e.g. 300'
                });
                const timeout = timeoutStr && !isNaN(parseInt(timeoutStr)) ? parseInt(timeoutStr) : undefined;

                this.projectManager.updateNode(nodeId, {
                    name,
                    config: { ...config, format, inputPath, targetTable, timeout }
                });
                this.onUpdate();
            }
        }
    }

    private async configureVariableNode(node: EtlNode, nodeId: string): Promise<void> {
        const config = node.config as {
            type: 'variable';
            variableName: string;
            source: 'prompt' | 'static' | 'sql';
            promptMessage?: string;
            defaultValue?: string;
            value?: string;
            query?: string;
            timeout?: number
        };

        // Ask for task name first
        const name = await vscode.window.showInputBox({
            prompt: 'Enter task name',
            value: node.name,
            placeHolder: 'e.g. Get Date Filter'
        });
        if (name === undefined) return;

        // Ask for variable name
        const variableName = await vscode.window.showInputBox({
            prompt: 'Enter variable name (without ${})',
            value: config.variableName,
            placeHolder: 'e.g. date_filter'
        });
        if (!variableName) return;

        // Ask for source type
        const source = await vscode.window.showQuickPick(
            [
                { label: 'Prompt User', value: 'prompt', description: 'Ask user for value at runtime' },
                { label: 'Static Value', value: 'static', description: 'Use fixed value' },
                { label: 'SQL Query', value: 'sql', description: 'Get value from database query' }
            ],
            { placeHolder: 'How should the variable value be set?' }
        );
        if (!source) return;

        let newConfig = { ...config, variableName, source: source.value as 'prompt' | 'static' | 'sql' };

        // Configure based on source type
        switch (source.value) {
            case 'prompt': {
                const promptMessage = await vscode.window.showInputBox({
                    prompt: 'Enter prompt message to show user',
                    value: config.promptMessage || `Enter value for ${variableName}`,
                    placeHolder: 'e.g. Enter date filter (YYYY-MM-DD)'
                });
                const defaultValue = await vscode.window.showInputBox({
                    prompt: 'Enter default value (optional)',
                    value: config.defaultValue || '',
                    placeHolder: 'e.g. 2024-01-01'
                });
                newConfig = { ...newConfig, promptMessage, defaultValue };
                break;
            }
            case 'static': {
                const value = await vscode.window.showInputBox({
                    prompt: 'Enter static value',
                    value: config.value || '',
                    placeHolder: 'e.g. 2024-06-15'
                });
                if (value === undefined) return;
                newConfig = { ...newConfig, value };
                break;
            }
            case 'sql': {
                const query = await vscode.window.showInputBox({
                    prompt: 'Enter SQL query (must return single value)',
                    value: config.query || '',
                    placeHolder: "SELECT MAX(date) FROM sales_data"
                });
                if (!query) return;
                const timeoutStr = await vscode.window.showInputBox({
                    prompt: 'Enter timeout in seconds (optional)',
                    value: config.timeout ? String(config.timeout) : '',
                    placeHolder: 'e.g. 30'
                });
                const timeout = timeoutStr && !isNaN(parseInt(timeoutStr)) ? parseInt(timeoutStr) : undefined;
                newConfig = { ...newConfig, query, timeout };
                break;
            }
        }

        this.projectManager.updateNode(nodeId, {
            name,
            config: newConfig
        });
        this.onUpdate();
    }
}
