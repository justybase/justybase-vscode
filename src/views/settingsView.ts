/**
 * JustyBase Settings View
 * Beautiful Cursor-like settings webview panel with sidebar navigation.
 * Opens as an editor tab, not a sidebar view.
 */

import * as vscode from 'vscode';
import { getExtensionConfiguration } from '../compatibility/configuration';
import { FavoritesManager } from '../core/favoritesManager';
import {
    isSettingsWebviewMessage,
    type SettingsHostMessage
} from './settingsProtocol';
import * as fs from 'fs';
import * as path from 'path';

type SettingType = 'toggle' | 'select' | 'number' | 'text' | 'button' | 'textarea';

interface SettingItem {
    id: string;
    label: string;
    description: string;
    type: SettingType;
    configKey?: string;
    options?: { label: string; value: string | number }[];
    defaultValue?: boolean | string | number;
    action?: string;
    actionLabel?: string;
    icon?: string;
}

interface SettingsSection {
    id: string;
    title: string;
    description?: string;
    settings: SettingItem[];
}

/** Mirrors numeric limits registered in package.json. Keep this close to the webview registry. */
const NUMERIC_LIMITS: Record<string, { min?: number; max?: number }> = {
    cacheTTL: { min: 1, max: 168 },
    'metadataCache.memoryWarningBytes': { min: 0 },
    'sqlParser.fastPathThreshold': { min: 102400, max: 52428800 },
    streamingChunkSize: { min: 1000, max: 50000 },
    'query.rowLimit': { min: 1, max: 10000000 },
    'query.executionTimeout': { min: 1, max: 7200 },
    'ddl.maxTablesForContext': { min: 1, max: 100 },
    'ddl.cacheTTL': { min: 60000, max: 86400000 },
    'results.maxDataResults': { min: 10, max: 500 },
    'results.maxPinnedDataResults': { min: 1, max: 50 },
    'results.diskBackedResults.rowThreshold': { min: 10000, max: 5000000 },
    'results.diskBackedResults.memoryRowThreshold': { min: 1000, max: 5000000 },
    'results.diskBackedResults.insertBatchSize': { min: 1000, max: 200000 },
    'results.diskBackedResults.idleSpillMinutes': { min: 0, max: 1440 },
    'results.diskBackedResults.idleSpillRowThreshold': { min: 1000, max: 5000000 },
    'results.gridFontSize': { min: 9, max: 24 },
    'results.decimalScale': { min: 0, max: 12 },
    'filePreview.maxRows': { min: 100, max: 1000000 },
    'importWizard.validationSampleSize': { min: 5, max: 200 },
    'importWizard.backgroundValidationSampleSize': { min: 100, max: 50000 },
    'copilot.requestTimeout': { min: 5000, max: 300000 },
    'copilot.maxWorkspaceProfilesInContext': { min: 1, max: 20 }
};

const SETTINGS_SECTIONS: SettingsSection[] = [
    {
        id: 'general',
        title: 'General',
        description: 'Core extension settings, cache, and system configuration',
        settings: [
            {
                id: 'open-vscode-settings',
                label: 'VS Code Settings',
                description: 'Open the native VS Code settings for JustyBase',
                type: 'button',
                action: 'openVSCodeSettings',
                actionLabel: 'Open'
            },
            {
                id: 'clear-cache',
                label: 'Clear Autocomplete Cache',
                description: 'Remove all cached databases, schemas, tables, and columns. Cache will rebuild on next use.',
                type: 'button',
                action: 'clearAutocompleteCache',
                actionLabel: 'Clear'
            },
            {
                id: 'logging-level',
                label: 'Logging Level',
                description: 'Verbosity level for JustyBase output channel logging',
                type: 'select',
                configKey: 'logging.level',
                defaultValue: 'INFO',
                options: [
                    { label: 'DEBUG', value: 'DEBUG' },
                    { label: 'INFO', value: 'INFO' },
                    { label: 'WARN', value: 'WARN' },
                    { label: 'ERROR', value: 'ERROR' }
                ]
            },
            {
                id: 'safe-execute',
                label: 'Safe Execute',
                description: 'Confirm before executing potentially risky or destructive SQL',
                type: 'toggle',
                configKey: 'safeExecute.enabled',
                defaultValue: true
            },
            {
                id: 'show-conflict-warnings',
                label: 'Show Extension Conflict Warnings',
                description: 'Show warning when other SQL extensions may conflict with JustyBase',
                type: 'toggle',
                configKey: 'showConflictWarnings',
                defaultValue: true
            },
            {
                id: 'python-path',
                label: 'Python Path',
                description: 'Path to the Python executable used for scripts and automation',
                type: 'text',
                configKey: 'pythonPath',
                defaultValue: 'python'
            },
            {
                id: 'metadata-cache-disk',
                label: 'Disk Persistence',
                description: 'Persist metadata cache to disk for faster startup across sessions',
                type: 'toggle',
                configKey: 'metadataCache.diskPersistence',
                defaultValue: true
            },
            {
                id: 'metadata-cache-crosswindow',
                label: 'Cross-Window Sync',
                description: 'Sync metadata cache updates across multiple VS Code windows',
                type: 'toggle',
                configKey: 'metadataCache.crossWindowSync',
                defaultValue: true
            },
            {
                id: 'cache-ttl',
                label: 'Cache TTL (hours)',
                description: 'Time-to-live for cached metadata entries before automatic refresh (1–168h)',
                type: 'number',
                configKey: 'cacheTTL',
                defaultValue: 12
            },
            {
                id: 'memory-warning-bytes',
                label: 'Memory Warning Size (bytes)',
                description: 'Memory cache warning threshold in bytes (default: 256 MB)',
                type: 'number',
                configKey: 'metadataCache.memoryWarningBytes',
                defaultValue: 268435456
            }
        ]
    },
    {
        id: 'editor',
        title: 'Editor',
        description: 'SQL editor behavior, tooltips, hints, and visual feedback',
        settings: [
            {
                id: 'highlight-statement',
                label: 'Highlight Active Statement',
                description: 'Visually highlight the SQL statement at cursor position',
                type: 'toggle',
                configKey: 'highlightActiveStatement',
                defaultValue: true
            },
            {
                id: 'hover-tooltips',
                label: 'Show Hover Tooltips',
                description: 'Show column type and table info on hover over identifiers',
                type: 'toggle',
                configKey: 'sql.showHoverTooltips',
                defaultValue: true
            },
            {
                id: 'selection-actions',
                label: 'Show Selection Action Hover',
                description: 'Show quick Run/Export actions when text is selected in SQL editor',
                type: 'toggle',
                configKey: 'sql.showSelectionActionHover',
                defaultValue: true
            },
            {
                id: 'selection-execution',
                label: 'Show Execution Code Actions',
                description: 'Show "Run Selection" code actions on selected SQL in lightbulb menu',
                type: 'toggle',
                configKey: 'sql.showSelectionExecutionCodeActions',
                defaultValue: true
            },
            {
                id: 'inline-hints',
                label: 'Inline Type Hints',
                description: 'Show inline type hints for columns in SQL queries',
                type: 'toggle',
                configKey: 'sql.showInlineTypeHints',
                defaultValue: false
            },
            {
                id: 'long-query-threshold',
                label: 'Long Query Alert Threshold (minutes)',
                description: 'Show a warning notification when a query exceeds this duration',
                type: 'number',
                configKey: 'longQueryAlertThreshold',
                defaultValue: 10
            }
        ]
    },
    {
        id: 'sql',
        title: 'SQL Formatting, Linting & Parsing',
        description: 'Control how SQL is formatted, linted, and parsed',
        settings: [
            {
                id: 'format-tab-width',
                label: 'Tab Width',
                description: 'Number of spaces for indentation in formatted SQL',
                type: 'number',
                configKey: 'formatSQL.tabWidth',
                defaultValue: 4
            },
            {
                id: 'format-keyword-case',
                label: 'Keyword Case',
                description: 'Case style for SQL keywords in formatted output',
                type: 'select',
                configKey: 'formatSQL.keywordCase',
                defaultValue: 'upper',
                options: [
                    { label: 'UPPERCASE', value: 'upper' },
                    { label: 'lowercase', value: 'lower' },
                    { label: 'Preserve', value: 'preserve' }
                ]
            },
            {
                id: 'linter-enabled',
                label: 'SQL Linter',
                description: 'Enable real-time SQL linting and diagnostics in editor',
                type: 'toggle',
                configKey: 'linter.enabled',
                defaultValue: true
            },
            {
                id: 'linter-mode',
                label: 'Linter Mode',
                description: 'Parser-based SQL linting mode',
                type: 'select',
                configKey: 'linter.mode',
                defaultValue: 'advanced',
                options: [
                    { label: 'Advanced', value: 'advanced' }
                ]
            },
            {
                id: 'linter-rules',
                label: 'Linter Rules',
                description: 'Configure individual SQL linter rule severity (edit in settings.json)',
                type: 'button',
                action: 'openVSCodeSettings',
                actionLabel: 'Edit Rules'
            },
            {
                id: 'sqlparser-fastpath',
                label: 'Parser Fast Path Threshold (bytes)',
                description: 'Large SQL threshold for fast-path parsing (default: ~1.5 MB)',
                type: 'number',
                configKey: 'sqlParser.fastPathThreshold',
                defaultValue: 1572864
            }
        ]
    },
    {
        id: 'codelens',
        title: 'CodeLens Toolbar',
        description: 'Configure which action buttons appear above SQL statements',
        settings: [
            {
                id: 'codelens-enabled',
                label: 'Enable CodeLens',
                description: 'Show CodeLens action toolbar above SQL statements',
                type: 'toggle',
                configKey: 'codeLens.enabled',
                defaultValue: false
            },
            {
                id: 'codelens-run',
                label: 'Run Button',
                description: 'Show Run Statement button in CodeLens',
                type: 'toggle',
                configKey: 'codeLens.run',
                defaultValue: false
            },
            {
                id: 'codelens-runbatch',
                label: 'Run Batch Button',
                description: 'Show Run Batch button in CodeLens',
                type: 'toggle',
                configKey: 'codeLens.runBatch',
                defaultValue: false
            },
            {
                id: 'codelens-xlsx',
                label: 'Open as XLSX Button',
                description: 'Show Open as XLSX button in CodeLens',
                type: 'toggle',
                configKey: 'codeLens.openAsXlsx',
                defaultValue: false
            },
            {
                id: 'codelens-xlsb',
                label: 'Open as XLSB Button',
                description: 'Show Open as XLSB button in CodeLens',
                type: 'toggle',
                configKey: 'codeLens.openAsXlsb',
                defaultValue: false
            },
            {
                id: 'codelens-export',
                label: 'Export Button',
                description: 'Show Export button in CodeLens',
                type: 'toggle',
                configKey: 'codeLens.export',
                defaultValue: false
            },
            {
                id: 'codelens-markdown',
                label: 'Markdown Button',
                description: 'Show MD export button in CodeLens',
                type: 'toggle',
                configKey: 'codeLens.markdown',
                defaultValue: false
            },
            {
                id: 'codelens-explain',
                label: 'Explain Button',
                description: 'Show Explain button in CodeLens',
                type: 'toggle',
                configKey: 'codeLens.explain',
                defaultValue: false
            },
            {
                id: 'codelens-import',
                label: 'Import Button',
                description: 'Show Import button in CodeLens',
                type: 'toggle',
                configKey: 'codeLens.import',
                defaultValue: false
            }
        ]
    },
    {
        id: 'query',
        title: 'Query Execution',
        description: 'Streaming, row limits, timeouts, and safe execution settings',
        settings: [
            {
                id: 'enable-streaming',
                label: 'Enable Streaming Results',
                description: 'Stream large result sets in chunks for faster initial display',
                type: 'toggle',
                configKey: 'enableStreaming',
                defaultValue: true
            },
            {
                id: 'streaming-chunk-size',
                label: 'Streaming Chunk Size',
                description: 'Number of rows per streaming chunk (1000–50000)',
                type: 'number',
                configKey: 'streamingChunkSize',
                defaultValue: 5000
            },
            {
                id: 'query-row-limit',
                label: 'Query Row Limit',
                description: 'Max rows per query (1–10M). SQLite disk-backing activates at ~25K rows (memory) and 500K+ rows (full disk). Larger limits use more memory.',
                type: 'number',
                configKey: 'query.rowLimit',
                defaultValue: 200000
            },
            {
                id: 'query-execution-timeout',
                label: 'Query Execution Timeout (seconds)',
                description: 'Maximum time a query can run before being cancelled (1–7200s)',
                type: 'number',
                configKey: 'query.executionTimeout',
                defaultValue: 3600
            }
        ]
    },
    {
        id: 'ddl',
        title: 'DDL Context',
        description: 'Settings for DDL generation and Copilot context inclusion',
        settings: [
            {
                id: 'ddl-max-tables',
                label: 'Max Tables in DDL Context',
                description: 'Maximum number of tables to include in Copilot DDL context (1–100)',
                type: 'number',
                configKey: 'ddl.maxTablesForContext',
                defaultValue: 10
            },
            {
                id: 'ddl-cache-ttl',
                label: 'DDL Cache TTL (ms)',
                description: 'How long DDL results are cached before refresh (60000–86400000 ms)',
                type: 'number',
                configKey: 'ddl.cacheTTL',
                defaultValue: 3600000
            }
        ]
    },
    {
        id: 'schema',
        title: 'Schema Explorer',
        description: 'Control schema tree behavior and search scope',
        settings: [
            {
                id: 'schema-search-all',
                label: 'Search All Databases',
                description: 'Search across all accessible databases in schema object search',
                type: 'toggle',
                configKey: 'schemaSearch.searchAllDatabases',
                defaultValue: false
            }
        ]
    },
    {
        id: 'results',
        title: 'Results Panel',
        description: 'Control how query results are displayed, stored, and formatted',
        settings: [
            {
                id: 'results-max-data',
                label: 'Max Result Sets',
                description: 'Maximum number of result sets kept in memory (10–500)',
                type: 'number',
                configKey: 'results.maxDataResults',
                defaultValue: 50
            },
            {
                id: 'results-max-pinned',
                label: 'Max Pinned Results',
                description: 'Maximum number of pinned result sets (1–50)',
                type: 'number',
                configKey: 'results.maxPinnedDataResults',
                defaultValue: 10
            },
            {
                id: 'results-disk-enabled',
                label: 'Disk-Backed Results',
                description: 'Use disk-backed storage for large result sets to save memory',
                type: 'toggle',
                configKey: 'results.diskBackedResults.enabled',
                defaultValue: true
            },
            {
                id: 'results-disk-threshold',
                label: 'Disk Row Threshold',
                description: 'Max rows before results switch to disk-backed mode (10000–5000000)',
                type: 'number',
                configKey: 'results.diskBackedResults.rowThreshold',
                defaultValue: 500000
            },
            {
                id: 'results-disk-mem-threshold',
                label: 'Memory Row Threshold',
                description: 'Rows threshold before memory-to-disk spill starts (1000–5000000)',
                type: 'number',
                configKey: 'results.diskBackedResults.memoryRowThreshold',
                defaultValue: 25000
            },
            {
                id: 'results-disk-batch',
                label: 'Insert Batch Size',
                description: 'SQLite insert batch size for disk-backed results (1000–200000)',
                type: 'number',
                configKey: 'results.diskBackedResults.insertBatchSize',
                defaultValue: 50000
            },
            {
                id: 'results-idle-spill-minutes',
                label: 'Idle Spill Timeout (minutes)',
                description: 'Idle time before results are spilled to disk (0 = disabled, max 1440)',
                type: 'number',
                configKey: 'results.diskBackedResults.idleSpillMinutes',
                defaultValue: 0
            },
            {
                id: 'results-idle-spill-rows',
                label: 'Idle Spill Row Threshold',
                description: 'Minimum rows required before idle spill triggers (1000–5000000)',
                type: 'number',
                configKey: 'results.diskBackedResults.idleSpillRowThreshold',
                defaultValue: 10000
            },
            {
                id: 'results-grid-font',
                label: 'Grid Font Family',
                description: 'Font family used in the results data grid',
                type: 'text',
                configKey: 'results.gridFontFamily',
                defaultValue: "Menlo, Monaco, Consolas, 'Courier New', monospace"
            },
            {
                id: 'results-grid-font-size',
                label: 'Grid Font Size',
                description: 'Font size for the results data grid (9–24px)',
                type: 'number',
                configKey: 'results.gridFontSize',
                defaultValue: 12
            },
            {
                id: 'results-integer-grouping',
                label: 'Thousand Separator (Integers)',
                description: 'Show thousand separator for integer columns',
                type: 'toggle',
                configKey: 'results.integerGrouping',
                defaultValue: true
            },
            {
                id: 'results-decimal-grouping',
                label: 'Thousand Separator (Decimals)',
                description: 'Show thousand separator for decimal/numeric columns',
                type: 'toggle',
                configKey: 'results.decimalGrouping',
                defaultValue: true
            },
            {
                id: 'results-group-separator',
                label: 'Group Separator',
                description: 'Character used as the thousand group separator',
                type: 'select',
                configKey: 'results.groupSeparator',
                defaultValue: ' ',
                options: [
                    { label: 'Space', value: ' ' },
                    { label: 'Comma (,)', value: ',' },
                    { label: 'Underscore (_)', value: '_' }
                ]
            },
            {
                id: 'results-decimal-separator',
                label: 'Decimal Separator',
                description: 'Character used as the decimal point',
                type: 'select',
                configKey: 'results.decimalSeparator',
                defaultValue: '.',
                options: [
                    { label: 'Dot (.)', value: '.' },
                    { label: 'Comma (,)', value: ',' }
                ]
            },
            {
                id: 'results-decimal-scale',
                label: 'Decimal Scale',
                description: 'Default number of decimal places to display (0–12)',
                type: 'number',
                configKey: 'results.decimalScale',
                defaultValue: 4
            },
            {
                id: 'results-preserve-zeros',
                label: 'Preserve Trailing Zeros',
                description: 'Keep trailing zeros in numeric rendering',
                type: 'toggle',
                configKey: 'results.preserveTrailingZeros',
                defaultValue: true
            },
            {
                id: 'results-rounding-mode',
                label: 'Rounding Mode',
                description: 'Rounding mode for decimal values',
                type: 'select',
                configKey: 'results.roundingMode',
                defaultValue: 'half-up',
                options: [
                    { label: 'Half Up', value: 'half-up' },
                    { label: 'Half Even', value: 'half-even' },
                    { label: 'Floor', value: 'floor' },
                    { label: 'Ceil', value: 'ceil' },
                    { label: 'Truncate', value: 'truncate' }
                ]
            },
            {
                id: 'results-formatted-export',
                label: 'Use Formatted Values for Export',
                description: 'Export formatted display values instead of raw database values',
                type: 'toggle',
                configKey: 'results.useFormattedValuesForExport',
                defaultValue: false
            },
            {
                id: 'results-copy-format',
                label: 'Default Copy Format',
                description: 'Default format when copying result cells to clipboard',
                type: 'select',
                configKey: 'results.copyFormat',
                defaultValue: 'markdown',
                options: [
                    { label: 'Tabbed', value: 'tabbed' },
                    { label: 'Markdown', value: 'markdown' },
                    { label: 'CSV', value: 'csv' },
                    { label: 'CSV (Semicolon)', value: 'csv-semicolon' }
                ]
            }
        ]
    },
    {
        id: 'filepreview',
        title: 'File Preview',
        description: 'Settings for CSV and data file preview',
        settings: [
            {
                id: 'filepreview-max-rows',
                label: 'Max Preview Rows',
                description: 'Maximum rows to show in file preview (100–1,000,000)',
                type: 'number',
                configKey: 'filePreview.maxRows',
                defaultValue: 20000
            },
            {
                id: 'filepreview-csv-mode',
                label: 'CSV Preview Mode',
                description: 'Which CSV preview engine to use',
                type: 'select',
                configKey: 'filePreview.csvPreviewMode',
                defaultValue: 'custom',
                options: [
                    { label: 'Custom (JustyBase)', value: 'custom' },
                    { label: 'Native (VS Code)', value: 'native' }
                ]
            }
        ]
    },
    {
        id: 'importwizard',
        title: 'Import Wizard',
        description: 'Configure default import behavior and validation',
        settings: [
            {
                id: 'import-default-mode',
                label: 'Default Import Mode',
                description: 'Default mode when opening the Import Data command',
                type: 'select',
                configKey: 'importWizard.defaultMode',
                defaultValue: 'prompt',
                options: [
                    { label: 'Prompt (ask each time)', value: 'prompt' },
                    { label: 'Simple', value: 'simple' },
                    { label: 'Advanced Wizard', value: 'advanced' }
                ]
            },
            {
                id: 'import-preview-rows',
                label: 'Preview Row Count',
                description: 'Number of rows shown in import preview dialog',
                type: 'select',
                configKey: 'importWizard.previewRowCount',
                defaultValue: 10,
                options: [
                    { label: '5', value: 5 },
                    { label: '10', value: 10 },
                    { label: '20', value: 20 }
                ]
            },
            {
                id: 'import-validation-size',
                label: 'Validation Sample Size',
                description: 'Number of rows sampled for import synchronization validation (5–200)',
                type: 'number',
                configKey: 'importWizard.validationSampleSize',
                defaultValue: 25
            },
            {
                id: 'import-bg-validation',
                label: 'Background Validation',
                description: 'Enable async background validation during import',
                type: 'toggle',
                configKey: 'importWizard.backgroundValidationEnabled',
                defaultValue: true
            },
            {
                id: 'import-bg-validation-size',
                label: 'Background Validation Sample Size',
                description: 'Number of rows to validate in background (100–50000)',
                type: 'number',
                configKey: 'importWizard.backgroundValidationSampleSize',
                defaultValue: 5000
            }
        ]
    },
    {
        id: 'copilot',
        title: 'AI Copilot',
        description: 'Control AI-powered SQL assistance, tools, and privacy',
        settings: [
            {
                id: 'copilot-enabled',
                label: 'Enable AI Copilot',
                description: 'Enable AI-powered SQL assistance and chat features',
                type: 'toggle',
                configKey: 'copilot.enabled',
                defaultValue: true
            },
            {
                id: 'copilot-prompt-optimize',
                label: 'Optimize Prompt',
                description: 'Custom prompt template for SQL optimization. Edit inline below.',
                type: 'textarea',
                configKey: 'copilot.prompts.optimize',
                defaultValue: 'Optimize the following Netezza SQL query for performance and readability:'
            },
            {
                id: 'copilot-prompt-fix',
                label: 'Fix Prompt',
                description: 'Custom prompt template for SQL fixing. Edit inline below.',
                type: 'textarea',
                configKey: 'copilot.prompts.fix',
                defaultValue: 'Fix the syntax errors in the following Netezza SQL query:'
            },
            {
                id: 'copilot-prompt-explain',
                label: 'Explain Prompt',
                description: 'Custom prompt template for SQL explanation. Edit inline below.',
                type: 'textarea',
                configKey: 'copilot.prompts.explain',
                defaultValue: 'Explain what this Netezza SQL query does:'
            },
            {
                id: 'copilot-request-timeout',
                label: 'Request Timeout (ms)',
                description: 'Timeout for Copilot API requests (5000–300000 ms)',
                type: 'number',
                configKey: 'copilot.requestTimeout',
                defaultValue: 60000
            },
            {
                id: 'copilot-max-profiles',
                label: 'Max Workspace Profiles in Context',
                description: 'Maximum number of workspace profiles included in Copilot context (1–20)',
                type: 'number',
                configKey: 'copilot.maxWorkspaceProfilesInContext',
                defaultValue: 5
            },
            {
                id: 'copilot-skip-privacy',
                label: 'Skip Privacy Confirmation',
                description: 'Skip the privacy confirmation prompt for AI data sharing',
                type: 'toggle',
                configKey: 'copilot.skipPrivacyConfirmation',
                defaultValue: false
            }
        ]
    },
    {
        id: 'snippets',
        title: 'SQL Snippets',
        description: 'Browse predefined Netezza snippets and manage your custom SQL snippets',
        settings: [
            {
                id: 'open-snippets-file',
                label: 'Workspace Snippets File',
                description: 'Open or create .vscode/justybase.code-snippets for persistent workspace snippets.',
                type: 'button',
                action: 'openSnippetsFile',
                actionLabel: 'Open File'
            },
            {
                id: 'new-snippet',
                label: 'New Custom Snippet',
                description: 'Create a new SQL snippet for quick reuse',
                type: 'button',
                action: 'newSnippet',
                actionLabel: 'New'
            }
        ]
    }
];

export class SettingsView {
    public static readonly viewType = 'netezza.settings';
    private static currentPanel: SettingsView | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _context: vscode.ExtensionContext;
    private _disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        context: vscode.ExtensionContext
    ) {
        this._context = context;
        this._panel = panel;

        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message: unknown) => {
                if (!isSettingsWebviewMessage(message)) return;
                switch (message.command) {
                    case 'updateSetting':
                        if (message.key) {
                            try {
                                await this._updateSetting(message.key, message.value);
                                this._postMessage({
                                    command: 'settingUpdated',
                                    key: message.key,
                                    value: message.value,
                                    success: true
                                });
                            } catch (error) {
                                this._postMessage({
                                    command: 'settingUpdated',
                                    key: message.key,
                                    success: false,
                                    error: error instanceof Error ? error.message : String(error)
                                });
                            }
                        }
                        return;
                    case 'resetSetting':
                        if (message.key) {
                            try {
                                await this._resetSetting(message.key);
                                // Notify frontend that reset succeeded, then re-send all settings
                                this._postMessage({ command: 'settingReset', key: message.key });
                                await this._sendCurrentSettings();
                            } catch (error) {
                                this._postMessage({
                                    command: 'operationFailed',
                                    error: error instanceof Error ? error.message : String(error)
                                });
                            }
                        }
                        return;
                    case 'resetSection':
                        if (message.key) {
                            try {
                                const count = await this._resetSection(message.key);
                                this._postMessage({
                                    command: 'sectionReset',
                                    sectionId: message.key,
                                    count: count
                                });
                                await this._sendCurrentSettings();
                            } catch (error) {
                                this._postMessage({
                                    command: 'operationFailed',
                                    error: error instanceof Error ? error.message : String(error)
                                });
                            }
                        }
                        return;
                    case 'getSettings':
                        await this._sendCurrentSettings();
                        return;
                    case 'testPrompt':
                        if (message.key && message.value && typeof message.key === 'string' && typeof message.value === 'string') {
                            await this._testPrompt(message.key, message.value);
                        }
                        return;
                    case 'openVSCodeSettings':
                        await vscode.commands.executeCommand('workbench.action.openSettings', 'justybase');
                        return;
                    case 'clearAutocompleteCache':
                        await vscode.commands.executeCommand('netezza.clearAutocompleteCache');
                        return;
                    case 'openConnection':
                        await vscode.commands.executeCommand('netezza.openLogin');
                        return;
                    case 'refreshSchema':
                        await vscode.commands.executeCommand('netezza.refreshSchema');
                        return;
                    case 'openSettings':
                        await vscode.commands.executeCommand('netezza.openSettings');
                        return;
                    case 'showMetadataStats':
                        await vscode.commands.executeCommand('netezza.showMetadataCacheStats');
                        return;
                    case 'openSnippetsFile':
                        await this._openSnippetsFile();
                        return;
                    case 'getSnippets':
                        await this._sendSnippets();
                        return;
                    case 'createSnippet':
                        if (typeof message.value === 'object' && message.value &&
                            'label' in message.value && 'sql' in message.value) {
                            await this._createSnippet(String(message.value.label), String(message.value.sql));
                        }
                        return;
                    case 'updateSnippet':
                        if (typeof message.value === 'object' && message.value &&
                            'id' in message.value && 'label' in message.value && 'sql' in message.value) {
                            await this._updateSnippet(
                                String(message.value.id),
                                String(message.value.label),
                                String(message.value.sql)
                            );
                        }
                        return;
                    case 'deleteSnippet':
                        if (typeof message.value === 'string') {
                            await this._deleteSnippet(message.value);
                        }
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    public static createOrShow(
        extensionUri: vscode.Uri,
        context: vscode.ExtensionContext
    ): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (SettingsView.currentPanel) {
            SettingsView.currentPanel._panel.reveal(column);
            void SettingsView.currentPanel._sendCurrentSettings();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            SettingsView.viewType,
            'JustyBase Settings',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'media'),
                    vscode.Uri.joinPath(extensionUri, 'dist')
                ],
                retainContextWhenHidden: true
            }
        );

        SettingsView.currentPanel = new SettingsView(panel, context);
    }

    public dispose(): void {
        SettingsView.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) { x.dispose(); }
        }
    }

    private _getSetting(key: string): SettingItem {
        for (const section of SETTINGS_SECTIONS) {
            const setting = section.settings.find(candidate => candidate.configKey === key);
            if (setting) return setting;
        }
        throw new Error(`Unsupported setting: ${key}`);
    }

    private _getConfigurationTarget(key: string): vscode.ConfigurationTarget {
        const inspected = vscode.workspace.getConfiguration('justybase').inspect(key);
        if (inspected?.workspaceFolderValue !== undefined || inspected?.workspaceValue !== undefined) {
            return vscode.ConfigurationTarget.Workspace;
        }
        return vscode.ConfigurationTarget.Global;
    }

    private _validateSettingValue(setting: SettingItem, value: unknown): void {
        switch (setting.type) {
            case 'toggle':
                if (typeof value !== 'boolean') throw new Error(`${setting.label} must be enabled or disabled.`);
                return;
            case 'select':
                if (!setting.options?.some(option => option.value === value)) {
                    throw new Error(`Invalid value for ${setting.label}.`);
                }
                return;
            case 'number':
                if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
                    throw new Error(`${setting.label} must be an integer.`);
                }
                const limits = setting.configKey ? NUMERIC_LIMITS[setting.configKey] : undefined;
                if (limits?.min !== undefined && value < limits.min ||
                    limits?.max !== undefined && value > limits.max) {
                    throw new Error(`${setting.label} must be within its supported range.`);
                }
                return;
            case 'text':
            case 'textarea':
                if (typeof value !== 'string') throw new Error(`${setting.label} must be text.`);
                return;
            default:
                throw new Error(`${setting.label} cannot be changed here.`);
        }
    }

    private async _updateSetting(key: string, value: unknown): Promise<void> {
        const setting = this._getSetting(key);
        this._validateSettingValue(setting, value);
        const config = getExtensionConfiguration();
        await config.update(key, value, this._getConfigurationTarget(key));
    }

    private _postMessage(message: SettingsHostMessage): void {
        void this._panel.webview.postMessage(message);
    }

    private async _resetSetting(key: string): Promise<void> {
        this._getSetting(key);
        // Remove the value from the active scope so VS Code can use the next applicable value.
        const config = getExtensionConfiguration();
        await config.update(key, undefined, this._getConfigurationTarget(key));
    }

    private async _resetSection(sectionId: string): Promise<number> {
        const section = SETTINGS_SECTIONS.find(s => s.id === sectionId);
        if (!section) return 0;
        let count = 0;
        for (const setting of section.settings) {
            if (setting.configKey) {
                await this._resetSetting(setting.configKey);
                count++;
            }
        }
        return count;
    }

    private async _testPrompt(promptType: string, promptText: string): Promise<void> {
        // Loading state is already shown on the frontend before sending.
        try {
            const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            if (!models || models.length === 0) {
                this._postMessage({
                    command: 'testPromptResult',
                    promptType,
                    status: 'error',
                    error: 'No AI model available. Please sign in to GitHub Copilot and try again.'
                });
                return;
            }

            const model = models[0];

            const testSql =
`SELECT u.name, o.total
FROM users u
JOIN orders o ON u.id = o.user_id
WHERE u.status = 'active'
ORDER BY o.total DESC;`;

            const fullPrompt = `You are a SQL assistant. Test the following custom prompt instruction:

---
${promptText}
---

Apply it to this SQL:

\`\`\`sql
${testSql}
\`\`\`

Respond as the AI assistant would with this prompt. Show the full response.`;

            const messages = [vscode.LanguageModelChatMessage.User(fullPrompt)];
            const tokenSource = new vscode.CancellationTokenSource();
            try {
                const response = await model.sendRequest(messages, {}, tokenSource.token);

                let fullResult = '';
                for await (const chunk of response.text) {
                    fullResult += chunk;
                }

                this._postMessage({
                    command: 'testPromptResult',
                    promptType,
                    status: 'success',
                    result: fullResult
                });
            } finally {
                tokenSource.dispose();
            }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            this._postMessage({
                command: 'testPromptResult',
                promptType,
                status: 'error',
                error: msg
            });
        }
    }

    private async _getCurrentValue(key: string | undefined, defaultValue: unknown): Promise<unknown> {
        if (!key) return defaultValue;
        const config = getExtensionConfiguration();
        return config.get<unknown>(key) ?? defaultValue;
    }

    private async _openSnippetsFile(): Promise<void> {
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showWarningMessage('Open a workspace folder first to use workspace snippets.');
                return;
            }

            const snippetsDirectory = path.join(workspaceFolder.uri.fsPath, '.vscode');
            const snippetsPath = path.join(snippetsDirectory, 'justybase.code-snippets');
            if (!fs.existsSync(snippetsPath)) {
                const predefinedPath = path.join(
                    this._context.extensionPath,
                    'dialects',
                    'netezza',
                    'snippets',
                    'netezza.code-snippets'
                );
                await fs.promises.mkdir(snippetsDirectory, { recursive: true });
                await fs.promises.copyFile(predefinedPath, snippetsPath);
            }
            const doc = await vscode.workspace.openTextDocument(snippetsPath);
            await vscode.window.showTextDocument(doc, { preview: false });
            vscode.window.showInformationMessage('Editing workspace snippets. Changes are stored in .vscode/justybase.code-snippets.');
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`Failed to open snippets file: ${msg}`);
        }
    }

    private async _getPredefinedSnippets(): Promise<{ name: string; prefix: string[]; description: string }[]> {
        try {
            const snippetsPath = path.join(
                this._context.extensionPath,
                'dialects',
                'netezza',
                'snippets',
                'netezza.code-snippets'
            );
            const content = fs.readFileSync(snippetsPath, 'utf-8');
            const parsed = JSON.parse(content) as Record<
                string,
                { prefix?: string | string[]; description?: string; body?: string[] }
            >;
            return Object.entries(parsed).map(([name, data]) => ({
                name,
                prefix: Array.isArray(data.prefix) ? data.prefix : data.prefix ? [data.prefix] : [],
                description: data.description || ''
            }));
        } catch {
            return [];
        }
    }

    private async _sendSnippets(): Promise<void> {
        const manager = FavoritesManager.getInstance(this._context);
        const all = await manager.getFavorites();
        const userSnippets = all
            .filter(f => f.type === 'sql')
            .map(f => ({
                id: f.id,
                label: f.label,
                sqlContent: f.sqlContent || ''
            }));
        const predefined = await this._getPredefinedSnippets();
        this._postMessage({
            command: 'snippetsData',
            userSnippets,
            predefined
        });
    }

    private async _createSnippet(label: string, sql: string): Promise<void> {
        if (!label.trim() || !sql.trim()) return;
        try {
            const manager = FavoritesManager.getInstance(this._context);
            await manager.addSqlSnippet(label.trim(), sql.trim());
            this._postMessage({ command: 'snippetCreated', success: true });
            await this._sendSnippets();
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            this._postMessage({ command: 'snippetCreated', success: false, error: msg });
        }
    }

    private async _updateSnippet(id: string, label: string, sql: string): Promise<void> {
        if (!id || !label.trim()) return;
        try {
            const manager = FavoritesManager.getInstance(this._context);
            const ok = await manager.updateSnippet(id, label.trim(), sql);
            this._postMessage({ command: 'snippetUpdated', success: ok, id });
            if (ok) await this._sendSnippets();
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            this._postMessage({ command: 'snippetUpdated', success: false, id, error: msg });
        }
    }

    private async _deleteSnippet(id: string): Promise<void> {
        if (!id) return;
        try {
            const manager = FavoritesManager.getInstance(this._context);
            await manager.removeFavoriteById(id);
            this._postMessage({ command: 'snippetDeleted', success: true, id });
            await this._sendSnippets();
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            this._postMessage({ command: 'snippetDeleted', success: false, id, error: msg });
        }
    }

    private async _sendCurrentSettings(): Promise<void> {
        const settingsData: Record<string, unknown> = {};
        for (const section of SETTINGS_SECTIONS) {
            for (const setting of section.settings) {
                if (setting.configKey) {
                    settingsData[setting.id] = await this._getCurrentValue(setting.configKey, setting.defaultValue);
                }
            }
        }
        this._postMessage({ command: 'settingsData', data: settingsData });
    }

    private _update(): void {
        this._panel.title = 'JustyBase Settings';
        this._panel.webview.html = this._getHtmlForWebview();
    }

    private _getHtmlForWebview(): string {
        const nonce = getNonce();
        const extensionVersion = require('../../package.json').version as string;

        const settingsConfigJson = JSON.stringify({
            sections: SETTINGS_SECTIONS,
            numericLimits: NUMERIC_LIMITS
        }).replace(/</g, '\\u003c');
        const styleUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'media', 'settingsView.css')
        );
        const scriptUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'media', 'settingsView.js')
        );

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this._panel.webview.cspSource}; script-src ${this._panel.webview.cspSource} 'nonce-${nonce}';">
    <title>JustyBase Settings</title>
    <link rel="stylesheet" href="${styleUri}">

</head>
<body>
    <!-- Sidebar -->
    <div class="sidebar">
        <div class="sidebar-header">
            <div class="sidebar-brand">
                <div class="sidebar-brand-icon">JB</div>
                JustyBase Settings
            </div>
        </div>
        <div class="sidebar-search">
            <div class="sidebar-search-wrapper">
                <input type="text" id="searchInput" placeholder="Search settings..." />
            </div>
        </div>
        <div class="sidebar-nav" id="sidebarNav"></div>            <div class="sidebar-footer">
            <span>v${extensionVersion}</span>
            <span>·</span>
            <span>JustyBase</span>
        </div>
    </div>

    <!-- Main Content -->
    <div class="main" id="mainContent">
        <div class="content-wrapper" id="contentWrapper"></div>
    </div>

    <!-- Toast -->
    <div class="toast" id="toast"></div>

    <!-- New Snippet Overlay -->
    <div id="newSnippetOverlay">
        <div class="new-snippet-modal">
            <h3>New Custom Snippet</h3>
            <label for="newSnippetName">Name</label>
            <input type="text" id="newSnippetName" placeholder="e.g. My Weekly Report Query" />
            <label for="newSnippetSql">SQL</label>
            <textarea id="newSnippetSql" placeholder="SELECT ..." spellcheck="false"></textarea>
            <div class="modal-actions">
                <button class="btn" id="newSnippetCancel">Cancel</button>
                <button class="btn btn-primary" id="newSnippetCreate">Create</button>
            </div>
        </div>
    </div>

    <script id="settingsConfig" type="application/json">${settingsConfigJson}</script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
