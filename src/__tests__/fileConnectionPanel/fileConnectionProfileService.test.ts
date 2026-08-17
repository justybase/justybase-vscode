/**
 * Unit tests for the file connection profile service.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
    applyFilePathsToConnection,
    buildFileConnectionDetails,
    detectFileDataFormat,
    formatFileSize,
    getFilePaths,
    isFileWorkspaceProfile,
    listXlsxSheetNames,
    parseFileWorkspace,
    serializeFileWorkspace,
    toFileInfo,
} from '../../services/fileConnectionProfileService';

jest.mock('@justybase/spreadsheet-tasks', () => ({
    ReaderFactory: {
        create: jest.fn(() => mockReader),
    },
}));

let mockReader: {
    open: jest.Mock;
    getSheetNames: () => string[];
    close: jest.Mock;
};

beforeEach(() => {
    mockReader = {
        open: jest.fn().mockResolvedValue(undefined),
        getSheetNames: () => ['Sheet1', 'Sales Data'],
        close: jest.fn().mockResolvedValue(undefined),
    };
});

describe('detectFileDataFormat', () => {
    it('detects supported formats case-insensitively', () => {
        expect(detectFileDataFormat('/a/b/SALES.XLSX')).toBe('xlsx');
        expect(detectFileDataFormat('file.xlsb')).toBe('xlsb');
        expect(detectFileDataFormat('file.csv')).toBe('csv');
        expect(detectFileDataFormat('file.tsv')).toBe('tsv');
        expect(detectFileDataFormat('file.parquet')).toBe('parquet');
        expect(detectFileDataFormat('file.avro')).toBe('avro');
        expect(detectFileDataFormat('file.mdb')).toBe('access');
        expect(detectFileDataFormat('file.accdb')).toBe('access');
    });

    it('returns undefined for unsupported formats', () => {
        expect(detectFileDataFormat('file.txt')).toBeUndefined();
        expect(detectFileDataFormat('noext')).toBeUndefined();
    });
});

describe('workspace serialization', () => {
    it('round-trips workspace files', () => {
        const files = ['/a/x.csv', '/b/y.tsv'];
        const serialized = serializeFileWorkspace(files);
        expect(JSON.parse(serialized)).toEqual({ version: 1, files: ['/a/x.csv', '/b/y.tsv'] });
        expect(parseFileWorkspace(serialized)).toEqual(['/a/x.csv', '/b/y.tsv']);
    });

    it('deduplicates and normalizes paths', () => {
        const serialized = serializeFileWorkspace(['/a/./x.csv', '/a/x.csv', '']);
        expect(parseFileWorkspace(serialized)).toEqual(['/a/x.csv']);
    });

    it('returns undefined for invalid workspace values', () => {
        expect(parseFileWorkspace(undefined)).toBeUndefined();
        expect(parseFileWorkspace('')).toBeUndefined();
        expect(parseFileWorkspace('not json')).toBeUndefined();
        expect(parseFileWorkspace(JSON.stringify({ version: 99, files: [] }))).toBeUndefined();
        expect(parseFileWorkspace(JSON.stringify({ version: 1, files: 'nope' }))).toBeUndefined();
    });
});

describe('getFilePaths / isFileWorkspaceProfile', () => {
    it('reads workspace paths first', () => {
        const details = {
            host: 'local',
            database: '/first.csv',
            user: 'file',
            dbType: 'file' as const,
            options: { fileWorkspace: serializeFileWorkspace(['/first.csv', '/second.csv']) },
        };
        expect(getFilePaths(details)).toEqual(['/first.csv', '/second.csv']);
        expect(isFileWorkspaceProfile(details)).toBe(true);
    });

    it('falls back to the single-file database path', () => {
        const details = { host: 'local', database: '/only.csv', user: 'file', dbType: 'file' as const };
        expect(getFilePaths(details)).toEqual(['/only.csv']);
        expect(isFileWorkspaceProfile(details)).toBe(false);
    });

    it('returns empty list when nothing is configured', () => {
        expect(getFilePaths({ host: '', database: '', user: '' })).toEqual([]);
        expect(isFileWorkspaceProfile(undefined)).toBe(false);
    });
});

describe('toFileInfo', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jbl-file-info-'));

    it('reports existing files with size', () => {
        const filePath = path.join(tempDir, 'data.csv');
        fs.writeFileSync(filePath, 'a,b\n1,2\n');
        const info = toFileInfo(filePath);
        expect(info.exists).toBe(true);
        expect(info.name).toBe('data.csv');
        expect(info.format).toBe('csv');
        expect(info.sizeBytes).toBe(8);
    });

    it('reports missing files', () => {
        const info = toFileInfo(path.join(tempDir, 'nope.parquet'));
        expect(info.exists).toBe(false);
        expect(info.sizeBytes).toBeUndefined();
    });
});

describe('buildFileConnectionDetails', () => {
    const single = { host: 'local', database: '/a.csv', user: 'file', dbType: 'file' as const, options: { editable: true, sheet: 'Sheet1' } };

    it('keeps single-file mode for one file and preserves editable and sheet', () => {
        const { details, modeChanged, editableCleared } = buildFileConnectionDetails('C', ['/a.csv'], single);
        expect(details.database).toBe('/a.csv');
        expect(details.options?.fileWorkspace).toBeUndefined();
        expect(details.options?.editable).toBe(true);
        expect(details.options?.sheet).toBe('Sheet1');
        expect(modeChanged).toBe(false);
        expect(editableCleared).toBe(false);
    });

    it('clears editable copy when the single file is an Access database', () => {
        const access = { ...single, database: '/a.accdb' };
        const { details, editableCleared } = buildFileConnectionDetails('C', ['/a.accdb'], access);
        expect(details.options?.editable).toBeUndefined();
        expect(details.options?.sheet).toBeUndefined();
        expect(editableCleared).toBe(true);
    });

    it('converts to a read-only workspace for multiple files and clears the editable copy', () => {
        const { details, modeChanged, editableCleared } = buildFileConnectionDetails('C', ['/a.csv', '/b.csv'], single);
        expect(details.database).toBe('/a.csv');
        expect(isFileWorkspaceProfile(details)).toBe(true);
        expect(parseFileWorkspace(details.options?.fileWorkspace)).toEqual(['/a.csv', '/b.csv']);
        expect(details.options?.editable).toBeUndefined();
        expect(details.options?.sheet).toBeUndefined();
        expect(modeChanged).toBe(true);
        expect(editableCleared).toBe(true);
    });

    it('converts back to single-file mode and clears workspace when one file remains', () => {
        const workspace = {
            host: 'local',
            database: '/a.csv',
            user: 'file',
            dbType: 'file' as const,
            options: { fileWorkspace: serializeFileWorkspace(['/a.csv', '/b.csv']) },
        };
        const { details, modeChanged, editableCleared } = buildFileConnectionDetails('C', ['/a.csv'], workspace);
        expect(details.options?.fileWorkspace).toBeUndefined();
        expect(details.options?.editable).toBe(false);
        expect(modeChanged).toBe(true);
        expect(editableCleared).toBe(false);
    });

    it('deduplicates files and drops empty paths', () => {
        const { details } = buildFileConnectionDetails('C', ['/a.csv', '/a.csv', ''], undefined);
        expect(getFilePaths(details)).toEqual(['/a.csv']);
    });
});

describe('applyFilePathsToConnection', () => {
    it('saves the merged profile', async () => {
        const saveConnection = jest.fn().mockResolvedValue(undefined);
        const getConnection = jest.fn().mockResolvedValue({ host: 'local', database: '/a.csv', user: 'file', dbType: 'file', options: {} });
        const refreshFileConnection = jest.fn().mockResolvedValue(undefined);
        const manager = { getConnection, saveConnection, refreshFileConnection };

        const details = await applyFilePathsToConnection(manager as unknown as never, 'C', ['/a.csv', '/b.csv']);
        expect(saveConnection).toHaveBeenCalledWith(expect.objectContaining({
            name: 'C',
            database: '/a.csv',
            dbType: 'file',
        }));
        expect(refreshFileConnection).toHaveBeenCalledWith('C');
        expect(getFilePaths(details as never)).toEqual(['/a.csv', '/b.csv']);
    });

    it('returns undefined when the connection does not exist', async () => {
        const saveConnection = jest.fn();
        const manager = { getConnection: jest.fn().mockResolvedValue(undefined), saveConnection };
        const details = await applyFilePathsToConnection(manager as unknown as never, 'C', ['/a.csv']);
        expect(details).toBeUndefined();
        expect(saveConnection).not.toHaveBeenCalled();
    });
});

describe('listXlsxSheetNames', () => {
    it('returns worksheet names for xlsx files', async () => {
        const names = await listXlsxSheetNames('/tmp/book.xlsx');
        expect(names).toEqual(['Sheet1', 'Sales Data']);
        expect(mockReader.open).toHaveBeenCalledWith('/tmp/book.xlsx');
        expect(mockReader.close).toHaveBeenCalled();
    });

    it('returns an empty list for non-xlsx files without opening the reader', async () => {
        const names = await listXlsxSheetNames('/tmp/data.csv');
        expect(names).toEqual([]);
        expect(mockReader.open).not.toHaveBeenCalled();
    });
});

describe('formatFileSize', () => {
    it('formats bytes, KB and MB', () => {
        expect(formatFileSize(undefined)).toBe('');
        expect(formatFileSize(512)).toBe('512 B');
        expect(formatFileSize(2048)).toBe('2.0 KB');
        expect(formatFileSize(3 * 1024 * 1024)).toBe('3.0 MB');
    });
});
