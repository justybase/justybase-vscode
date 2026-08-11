/**
 * Export/import of file connection profiles (JSON round trip).
 */

import {
    importFileConnections,
    parseFileConnectionsExport,
    serializeFileConnectionExport,
    serializeFileConnectionsExport,
} from '../../services/fileConnectionProfileService';

describe('serializeFileConnectionExport / parseFileConnectionsExport', () => {
    it('round-trips a single-file profile', () => {
        const entry = serializeFileConnectionExport('My Excel', {
            host: 'local',
            database: '/data/sales.xlsx',
            user: 'file',
            dbType: 'file',
            options: { editable: true, sheet: 'Arkusz1' },
        });
        expect(entry).toEqual({
            name: 'My Excel',
            files: ['/data/sales.xlsx'],
            editable: true,
            sheet: 'Arkusz1',
        });

        const json = serializeFileConnectionsExport([entry]);
        const parsed = parseFileConnectionsExport(json);
        expect(parsed).toEqual([entry]);
    });

    it('round-trips a workspace profile without options', () => {
        const entry = serializeFileConnectionExport('Files', {
            host: 'local',
            database: '/a.csv',
            user: 'file',
            dbType: 'file',
            options: { fileWorkspace: JSON.stringify({ version: 1, files: ['/a.csv', '/b.tsv'] }) },
        });
        expect(entry).toEqual({ name: 'Files', files: ['/a.csv', '/b.tsv'] });

        const parsed = parseFileConnectionsExport(serializeFileConnectionsExport([entry]));
        expect(parsed[0]).toEqual({ name: 'Files', files: ['/a.csv', '/b.tsv'], editable: false, sheet: undefined });
    });

    it('rejects invalid payloads with user-facing messages', () => {
        expect(() => parseFileConnectionsExport('not json')).toThrow('not valid JSON');
        expect(() => parseFileConnectionsExport('{}')).toThrow('not a JustyBase File Connections export');
        expect(() => parseFileConnectionsExport(JSON.stringify({ format: 'justybase.file-connections', version: 2, connections: [] })))
            .toThrow('Unsupported File Connections export version');
        expect(() => parseFileConnectionsExport(JSON.stringify({ format: 'justybase.file-connections', version: 1 })))
            .toThrow('does not contain any connections');
    });

    it('normalizes names, paths and deduplicates files', () => {
        const json = serializeFileConnectionsExport([{
            name: '  A  ',
            files: ['/x/./a.csv', '/x/a.csv', '/b.parquet'],
        }]);
        const parsed = parseFileConnectionsExport(json);
        expect(parsed[0].name).toBe('A');
        expect(parsed[0].files).toEqual(['/x/a.csv', '/b.parquet']);
    });
});

describe('importFileConnections', () => {
    const saved: Record<string, unknown> = {};

    function createManager(existing: string[] = []) {
        const connections = existing.map(name => ({ name, host: 'h', database: 'd', user: 'u', dbType: 'netezza' }));
        return {
            getConnections: jest.fn().mockResolvedValue(connections),
            saveConnection: jest.fn(async (details: { name: string }) => {
                saved[details.name] = details;
                connections.push({ name: details.name, host: 'h', database: 'd', user: 'u', dbType: 'file' });
            }),
        };
    }

    beforeEach(() => {
        Object.keys(saved).forEach(key => delete saved[key]);
    });

    it('creates single-file and workspace profiles', async () => {
        const manager = createManager();
        const result = await importFileConnections(manager as never, [
            { name: 'Excel', files: ['/data/a.xlsx'], editable: true },
            { name: 'Files', files: ['/data/a.csv', '/data/b.csv'] },
        ]);

        expect(result.created).toEqual(['Excel', 'Files']);
        expect(result.skipped).toEqual([]);
        expect(saved['Excel']).toMatchObject({
            name: 'Excel',
            database: '/data/a.xlsx',
            options: { editable: true },
        });
        expect((saved['Files'] as { options: Record<string, string> }).options.fileWorkspace).toBe(
            JSON.stringify({ version: 1, files: ['/data/a.csv', '/data/b.csv'] }),
        );
    });

    it('skips entries without files and reports them', async () => {
        const manager = createManager();
        const result = await importFileConnections(manager as never, [
            { name: 'Empty', files: [] },
        ]);
        expect(result.skipped).toEqual(['Empty']);
        expect(result.created).toEqual([]);
        expect(result.warnings.some(warning => warning.includes('skipped'))).toBe(true);
    });

    it('renames conflicting profiles with a suffix', async () => {
        const manager = createManager(['Excel']);
        const result = await importFileConnections(manager as never, [
            { name: 'Excel', files: ['/data/a.xlsx'] },
        ]);
        expect(result.created).toEqual(['Excel (2)']);
    });

    it('warns about files missing on this machine', async () => {
        const manager = createManager();
        const result = await importFileConnections(manager as never, [
            { name: 'Gone', files: ['/definitely/not/here.csv'] },
        ]);
        expect(result.warnings.some(warning => warning.includes('not found'))).toBe(true);
    });
});
