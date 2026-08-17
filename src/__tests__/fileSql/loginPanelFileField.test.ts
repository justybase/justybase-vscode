/**
 * Regression: the login panel must carry the picked data file through
 * normalization so required-field validation passes for 'file' connections.
 */

import { LoginPanel } from '../../views/loginPanel';
import { fileDialectStub } from '../../dialects/file';
import { netezzaDialect } from '../../dialects/netezza';

type NormalizeMethod = (data: Record<string, unknown>) => {
    database: string;
    filePath?: string;
    dbType: string;
    host: string;
    user: string;
    options?: Record<string, unknown>;
};

function createPanelHarness(): { normalize: NormalizeMethod } {
    const panel = Object.create(LoginPanel.prototype) as unknown as {
        _getDialectDefinition: (dbType?: string) => unknown;
        _normalizeOptions: (options: unknown) => unknown;
        _normalizeIncomingConnection: (data: Record<string, unknown>) => {
            database: string;
            filePath?: string;
            dbType: string;
            host: string;
            user: string;
            options?: Record<string, unknown>;
        };
    };
    panel._getDialectDefinition = (dbType?: string) =>
        dbType === 'file' ? fileDialectStub : netezzaDialect;
    panel._normalizeOptions = (options: unknown) => options ?? undefined;
    return { normalize: panel._normalizeIncomingConnection.bind(panel) };
}

describe('login panel file connection normalization', () => {
    it('maps the picked filePath to the connection database', () => {
        const { normalize } = createPanelHarness();
        const result = normalize({ dbType: 'file', filePath: '/data/sales.csv' });
        expect(result.database).toBe('/data/sales.csv');
        expect(result.filePath).toBe('/data/sales.csv');
        expect(result.dbType).toBe('file');
    });

    it('falls back to the database field when filePath is missing', () => {
        const { normalize } = createPanelHarness();
        const result = normalize({ dbType: 'file', database: '/data/sales.csv' });
        expect(result.database).toBe('/data/sales.csv');
        expect(result.filePath).toBe('/data/sales.csv');
    });

    it('keeps filePath undefined for other dialects', () => {
        const { normalize } = createPanelHarness();
        const result = normalize({ dbType: 'netezza', host: 'h', database: 'db' });
        expect(result.filePath).toBeUndefined();
        expect(result.database).toBe('db');
    });

    it('validates the required file field against the normalized data', () => {
        const { normalize } = createPanelHarness();
        const normalized = normalize({ dbType: 'file', filePath: '/data/sales.csv' });

        const field = fileDialectStub.connectionForm?.fields[0];
        expect(field?.key).toBe('filePath');
        expect(field?.required).toBe(true);
        const value = (normalized as Record<string, unknown>)[field?.key ?? ''];
        expect(value).toBe('/data/sales.csv');
        expect(typeof value).toBe('string');
        expect(String(value).trim().length).toBeGreaterThan(0);
    });

    it('clears editable copy for Access files', () => {
        const { normalize } = createPanelHarness();
        const normalized = normalize({
            dbType: 'file',
            filePath: '/data/sample.accdb',
            options: { editable: true },
        });

        expect(normalized.options?.editable).toBeUndefined();
    });
});
