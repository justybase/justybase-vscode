import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureClidriverOnPath, isValidClidriverHome } from '../../extensions/db2/src/db2Connection';

function createTempClidriver(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'db2-clidriver-test-'));
}

function writeEmptyFile(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '');
}

describe('db2Connection platform helpers', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('validates clidriver home on Windows using db2cli64.dll', () => {
        const clidriverHome = createTempClidriver();
        writeEmptyFile(path.join(clidriverHome, 'bin', 'db2cli64.dll'));

        expect(isValidClidriverHome(clidriverHome, 'win32')).toBe(true);

        fs.rmSync(clidriverHome, { recursive: true, force: true });
    });

    it('validates clidriver home on Linux using libdb2.so', () => {
        const clidriverHome = createTempClidriver();
        writeEmptyFile(path.join(clidriverHome, 'lib', 'libdb2.so'));

        expect(isValidClidriverHome(clidriverHome, 'linux')).toBe(true);

        fs.rmSync(clidriverHome, { recursive: true, force: true });
    });

    it('validates packaged Linux clidriver home using libdb2.so.1', () => {
        const clidriverHome = createTempClidriver();
        writeEmptyFile(path.join(clidriverHome, 'lib', 'libdb2.so.1'));

        expect(isValidClidriverHome(clidriverHome, 'linux')).toBe(true);

        fs.rmSync(clidriverHome, { recursive: true, force: true });
    });

    it('validates clidriver home on macOS using db2cli binary', () => {
        const clidriverHome = createTempClidriver();
        writeEmptyFile(path.join(clidriverHome, 'bin', 'db2cli'));

        expect(isValidClidriverHome(clidriverHome, 'darwin')).toBe(true);

        fs.rmSync(clidriverHome, { recursive: true, force: true });
    });

    it('rejects clidriver home when platform runtime files are missing', () => {
        const clidriverHome = createTempClidriver();
        fs.mkdirSync(path.join(clidriverHome, 'bin'), { recursive: true });

        expect(isValidClidriverHome(clidriverHome, 'linux')).toBe(false);

        fs.rmSync(clidriverHome, { recursive: true, force: true });
    });

    it('adds PATH and LD_LIBRARY_PATH entries for Linux without duplicates', () => {
        const clidriverHome = createTempClidriver();
        const binDir = path.join(clidriverHome, 'bin');
        const libDir = path.join(clidriverHome, 'lib');
        fs.mkdirSync(binDir, { recursive: true });
        fs.mkdirSync(libDir, { recursive: true });

        const originalPath = process.env.PATH;
        const originalLd = process.env.LD_LIBRARY_PATH;
        const sep = path.delimiter;

        try {
            process.env.PATH = '';
            process.env.LD_LIBRARY_PATH = '';
            ensureClidriverOnPath(clidriverHome, 'linux');
            ensureClidriverOnPath(clidriverHome, 'linux');

            const pathEntries = (process.env.PATH || '').split(sep).filter(Boolean);
            const ldEntries = (process.env.LD_LIBRARY_PATH || '').split(sep).filter(Boolean);

            expect(pathEntries.filter(entry => entry === binDir)).toHaveLength(1);
            expect(pathEntries.filter(entry => entry === libDir)).toHaveLength(1);
            expect(pathEntries[0]).toBe(binDir);
            expect(pathEntries[1]).toBe(libDir);
            expect(ldEntries.filter(entry => entry === libDir)).toHaveLength(1);
        } finally {
            if (originalPath === undefined) {
                delete process.env.PATH;
            } else {
                process.env.PATH = originalPath;
            }

            if (originalLd === undefined) {
                delete process.env.LD_LIBRARY_PATH;
            } else {
                process.env.LD_LIBRARY_PATH = originalLd;
            }
            fs.rmSync(clidriverHome, { recursive: true, force: true });
        }
    });

    it('adds DYLD_LIBRARY_PATH entries for macOS', () => {
        const clidriverHome = createTempClidriver();
        const binDir = path.join(clidriverHome, 'bin');
        const libDir = path.join(clidriverHome, 'lib');
        fs.mkdirSync(binDir, { recursive: true });
        fs.mkdirSync(libDir, { recursive: true });

        const originalPath = process.env.PATH;
        const originalDyld = process.env.DYLD_LIBRARY_PATH;
        const sep = path.delimiter;

        try {
            process.env.PATH = '';
            process.env.DYLD_LIBRARY_PATH = '';
            ensureClidriverOnPath(clidriverHome, 'darwin');

            const pathEntries = (process.env.PATH || '').split(sep).filter(Boolean);
            const dyldEntries = (process.env.DYLD_LIBRARY_PATH || '').split(sep).filter(Boolean);

            expect(pathEntries).toContain(binDir);
            expect(pathEntries).toContain(libDir);
            expect(dyldEntries[0]).toBe(libDir);
        } finally {
            if (originalPath === undefined) {
                delete process.env.PATH;
            } else {
                process.env.PATH = originalPath;
            }

            if (originalDyld === undefined) {
                delete process.env.DYLD_LIBRARY_PATH;
            } else {
                process.env.DYLD_LIBRARY_PATH = originalDyld;
            }
            fs.rmSync(clidriverHome, { recursive: true, force: true });
        }
    });
});
