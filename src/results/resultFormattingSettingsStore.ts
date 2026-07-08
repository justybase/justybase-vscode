import * as vscode from 'vscode';
import { getExtensionConfiguration } from '../compatibility/configuration';
import type { ConnectionManager } from '../core/connectionManager';
import {
    ColumnFormattingOverride,
    DEFAULT_RESULT_FORMATTING_SETTINGS,
    ResultFormattingPayload,
    ResultFormattingSettings,
    ResultFormattingUpdateRequest
} from './resultFormattingTypes';

const CONNECTION_OVERRIDES_KEY = 'results.formatting.connectionOverrides';
const COLUMN_OVERRIDES_KEY = 'results.formatting.columnOverrides';

type ConnectionOverrides = Record<string, Partial<ResultFormattingSettings>>;
type ColumnOverrideMap = Record<string, Record<string, ColumnFormattingOverride>>;

function cloneDefaults(): ResultFormattingSettings {
    return JSON.parse(JSON.stringify(DEFAULT_RESULT_FORMATTING_SETTINGS)) as ResultFormattingSettings;
}

function mergeResultFormattingSettings(
    base: ResultFormattingSettings,
    override?: Partial<ResultFormattingSettings>
): ResultFormattingSettings {
    if (!override) {
        return cloneResultFormattingSettings(base);
    }

    return {
        integer: {
            ...base.integer,
            ...override.integer
        },
        decimal: {
            ...base.decimal,
            ...override.decimal
        },
        useFormattedValuesForExport: override.useFormattedValuesForExport ?? base.useFormattedValuesForExport
    };
}

function cloneResultFormattingSettings(settings: ResultFormattingSettings): ResultFormattingSettings {
    return {
        integer: { ...settings.integer },
        decimal: { ...settings.decimal },
        useFormattedValuesForExport: settings.useFormattedValuesForExport
    };
}

function sanitizeScale(scale: number | undefined, fallback: number): number {
    if (typeof scale !== 'number' || !Number.isFinite(scale)) {
        return fallback;
    }

    return Math.min(12, Math.max(0, Math.trunc(scale)));
}

function sanitizeGroupSeparator(separator: string | undefined, fallback: string): string {
    if (typeof separator !== 'string' || separator.length === 0) {
        return fallback;
    }

    return separator === 'space' ? ' ' : separator;
}

function sanitizeDecimalSeparator(separator: string | undefined, fallback: string): string {
    if (separator === ',' || separator === '.') {
        return separator;
    }

    return fallback;
}

function sanitizeResultFormattingSettings(settings: Partial<ResultFormattingSettings>): Partial<ResultFormattingSettings> {
    const sanitized: Partial<ResultFormattingSettings> = {};

    if (settings.integer) {
        sanitized.integer = {
            useGrouping: settings.integer.useGrouping ?? undefined,
            groupSeparator: sanitizeGroupSeparator(
                settings.integer.groupSeparator,
                DEFAULT_RESULT_FORMATTING_SETTINGS.integer.groupSeparator
            )
        };
    }

    if (settings.decimal) {
        sanitized.decimal = {
            useGrouping: settings.decimal.useGrouping ?? undefined,
            groupSeparator: sanitizeGroupSeparator(
                settings.decimal.groupSeparator,
                DEFAULT_RESULT_FORMATTING_SETTINGS.decimal.groupSeparator
            ),
            decimalSeparator: sanitizeDecimalSeparator(
                settings.decimal.decimalSeparator,
                DEFAULT_RESULT_FORMATTING_SETTINGS.decimal.decimalSeparator
            ),
            scale: sanitizeScale(settings.decimal.scale, DEFAULT_RESULT_FORMATTING_SETTINGS.decimal.scale),
            preserveTrailingZeros: settings.decimal.preserveTrailingZeros ?? undefined,
            roundingMode: settings.decimal.roundingMode ?? undefined
        };
    }

    if (typeof settings.useFormattedValuesForExport === 'boolean') {
        sanitized.useFormattedValuesForExport = settings.useFormattedValuesForExport;
    }

    return sanitized;
}

function sanitizeColumnOverride(override: ColumnFormattingOverride): ColumnFormattingOverride {
    return {
        kind: override.kind,
        integer: override.integer
            ? {
                useGrouping: override.integer.useGrouping,
                groupSeparator: sanitizeGroupSeparator(
                    override.integer.groupSeparator,
                    DEFAULT_RESULT_FORMATTING_SETTINGS.integer.groupSeparator
                )
            }
            : undefined,
        decimal: override.decimal
            ? {
                useGrouping: override.decimal.useGrouping,
                groupSeparator: sanitizeGroupSeparator(
                    override.decimal.groupSeparator,
                    DEFAULT_RESULT_FORMATTING_SETTINGS.decimal.groupSeparator
                ),
                decimalSeparator: sanitizeDecimalSeparator(
                    override.decimal.decimalSeparator,
                    DEFAULT_RESULT_FORMATTING_SETTINGS.decimal.decimalSeparator
                ),
                scale: sanitizeScale(override.decimal.scale, DEFAULT_RESULT_FORMATTING_SETTINGS.decimal.scale),
                preserveTrailingZeros: override.decimal.preserveTrailingZeros,
                roundingMode: override.decimal.roundingMode
            }
            : undefined
    };
}

export class ResultFormattingSettingsStore {
    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _connectionManager: ConnectionManager
    ) {}

    public getResolvedGlobalSettings(): ResultFormattingSettings {
        const config = getExtensionConfiguration('results');
        const defaults = cloneDefaults();

        return mergeResultFormattingSettings(defaults, {
            integer: {
                useGrouping: config.get<boolean>('integerGrouping', defaults.integer.useGrouping) ?? defaults.integer.useGrouping,
                groupSeparator: sanitizeGroupSeparator(
                    config.get<string>('groupSeparator', defaults.integer.groupSeparator),
                    defaults.integer.groupSeparator
                )
            },
            decimal: {
                useGrouping: config.get<boolean>('decimalGrouping', defaults.decimal.useGrouping) ?? defaults.decimal.useGrouping,
                groupSeparator: sanitizeGroupSeparator(
                    config.get<string>('groupSeparator', defaults.decimal.groupSeparator),
                    defaults.decimal.groupSeparator
                ),
                decimalSeparator: sanitizeDecimalSeparator(
                    config.get<string>('decimalSeparator', defaults.decimal.decimalSeparator),
                    defaults.decimal.decimalSeparator
                ),
                scale: sanitizeScale(config.get<number>('decimalScale', defaults.decimal.scale), defaults.decimal.scale),
                preserveTrailingZeros: config.get<boolean>('preserveTrailingZeros', defaults.decimal.preserveTrailingZeros)
                    ?? defaults.decimal.preserveTrailingZeros,
                roundingMode: config.get<ResultFormattingSettings['decimal']['roundingMode']>(
                    'roundingMode',
                    defaults.decimal.roundingMode
                ) ?? defaults.decimal.roundingMode
            },
            useFormattedValuesForExport: config.get<boolean>(
                'useFormattedValuesForExport',
                defaults.useFormattedValuesForExport
            )
        });
    }

    public getPayloadForSource(sourceUri: string): ResultFormattingPayload {
        const connectionName = this._connectionManager.getConnectionForExecution(sourceUri);
        const global = this.getResolvedGlobalSettings();
        const connection = connectionName ? this._getConnectionOverrides()[connectionName] : undefined;
        const columnOverrides = this._getColumnOverrideMap()[this._buildColumnBucketKey(sourceUri, connectionName)] || {};

        return {
            connectionName,
            global,
            connection,
            columnOverrides
        };
    }

    public async update(request: ResultFormattingUpdateRequest): Promise<ResultFormattingPayload> {
        if (request.scope === 'global') {
            await this._updateGlobalConfiguration(request.settings as Partial<ResultFormattingSettings>);
            return this.getPayloadForSource(request.sourceUri);
        }

        const connectionName = this._connectionManager.getConnectionForExecution(request.sourceUri);
        if (request.scope === 'connection' && connectionName) {
            const overrides = this._getConnectionOverrides();
            overrides[connectionName] = sanitizeResultFormattingSettings(
                request.settings as Partial<ResultFormattingSettings>
            );
            await this._context.globalState.update(CONNECTION_OVERRIDES_KEY, overrides);
            return this.getPayloadForSource(request.sourceUri);
        }

        if (request.scope === 'column' && request.columnId) {
            const map = this._getColumnOverrideMap();
            const bucketKey = this._buildColumnBucketKey(request.sourceUri, connectionName);
            if (!map[bucketKey]) {
                map[bucketKey] = {};
            }
            map[bucketKey][request.columnId] = sanitizeColumnOverride(request.settings as ColumnFormattingOverride);
            await this._context.globalState.update(COLUMN_OVERRIDES_KEY, map);
            return this.getPayloadForSource(request.sourceUri);
        }

        return this.getPayloadForSource(request.sourceUri);
    }

    private async _updateGlobalConfiguration(settings: Partial<ResultFormattingSettings>): Promise<void> {
        const config = getExtensionConfiguration('results');
        const sanitized = sanitizeResultFormattingSettings(settings);

        if (sanitized.integer) {
            await config.update('integerGrouping', sanitized.integer.useGrouping, vscode.ConfigurationTarget.Global);
            await config.update('groupSeparator', sanitized.integer.groupSeparator, vscode.ConfigurationTarget.Global);
        }

        if (sanitized.decimal) {
            await config.update('decimalGrouping', sanitized.decimal.useGrouping, vscode.ConfigurationTarget.Global);
            await config.update('groupSeparator', sanitized.decimal.groupSeparator, vscode.ConfigurationTarget.Global);
            await config.update('decimalSeparator', sanitized.decimal.decimalSeparator, vscode.ConfigurationTarget.Global);
            await config.update('decimalScale', sanitized.decimal.scale, vscode.ConfigurationTarget.Global);
            await config.update('preserveTrailingZeros', sanitized.decimal.preserveTrailingZeros, vscode.ConfigurationTarget.Global);
            await config.update('roundingMode', sanitized.decimal.roundingMode, vscode.ConfigurationTarget.Global);
        }

        if (typeof sanitized.useFormattedValuesForExport === 'boolean') {
            await config.update(
                'useFormattedValuesForExport',
                sanitized.useFormattedValuesForExport,
                vscode.ConfigurationTarget.Global
            );
        }
    }

    private _getConnectionOverrides(): ConnectionOverrides {
        return this._context.globalState.get<ConnectionOverrides>(CONNECTION_OVERRIDES_KEY, {});
    }

    private _getColumnOverrideMap(): ColumnOverrideMap {
        return this._context.globalState.get<ColumnOverrideMap>(COLUMN_OVERRIDES_KEY, {});
    }

    private _buildColumnBucketKey(sourceUri: string, connectionName?: string): string {
        return `${connectionName || 'no-connection'}::${sourceUri}`;
    }
}