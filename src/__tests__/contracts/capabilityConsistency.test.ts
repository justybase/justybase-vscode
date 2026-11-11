import * as fs from 'fs';
import * as path from 'path';

/**
 * Capability/provider consistency guard.
 *
 * `DatabaseCapabilities` flags can only be true when the dialect ships the
 * matching `DatabaseAdvancedFeatures` provider; otherwise menus open and fail.
 * Companion extensions have no test runner of their own, so this test scans
 * their sources instead of importing them (importing would pull driver
 * dependencies such as native database clients).
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');

interface DialectSource {
    name: string;
    /** File that declares `capabilities`. */
    dialectFile: string;
    /** Concatenated text of every file that declares advanced features. */
    providerText: string;
}

function walkTypeScriptFiles(directory: string, out: string[]): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') {
            continue;
        }
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            walkTypeScriptFiles(fullPath, out);
        } else if (fullPath.endsWith('.ts') && !fullPath.endsWith('.d.ts')) {
            out.push(fullPath);
        }
    }
}

function readDialectSources(): DialectSource[] {
    const dialectDirectories = [
        path.join(REPO_ROOT, 'src', 'dialects', 'netezza'),
        path.join(REPO_ROOT, 'src', 'dialects', 'sqlite'),
    ];
    const extensionsDirectory = path.join(REPO_ROOT, 'extensions');
    for (const entry of fs.readdirSync(extensionsDirectory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            dialectDirectories.push(path.join(extensionsDirectory, entry.name));
        }
    }

    const sources: DialectSource[] = [];
    for (const directory of dialectDirectories) {
        const sourceDirectory = directory.endsWith(path.join('dialects', 'netezza'))
            || directory.endsWith(path.join('dialects', 'sqlite'))
            ? directory
            : path.join(directory, 'src');
        if (!fs.existsSync(sourceDirectory)) {
            continue;
        }
        const files: string[] = [];
        walkTypeScriptFiles(sourceDirectory, files);
        const topLevelIndex = path.join(sourceDirectory, 'index.ts');
        const dialectFile = files.find(file => /Dialect\.ts$/.test(file))
            ?? (fs.existsSync(topLevelIndex) ? topLevelIndex : undefined)
            ?? files.find(file => /[\\/]index\.ts$/.test(file));
        if (!dialectFile) {
            continue;
        }
        const providerText = files
            .map(file => fs.readFileSync(file, 'utf8'))
            .filter(text => /advancedfeatures/i.test(text))
            .join('\n');
        sources.push({
            name: path.relative(REPO_ROOT, directory),
            dialectFile: fs.readFileSync(dialectFile, 'utf8'),
            providerText,
        });
    }
    return sources;
}

function hasProvider(source: DialectSource, key: string): boolean {
    return new RegExp(`^\\s*${key}\\s*:`, 'm').test(source.providerText);
}

function declaredFlag(source: DialectSource, flag: string): boolean {
    const match = new RegExp(`${flag}\\s*:\\s*(true|false)`).exec(source.dialectFile);
    return match?.[1] === 'true';
}

describe('dialect capability/provider consistency', () => {
    const sources = readDialectSources();

    it('finds every dialect source', () => {
        expect(sources.length).toBeGreaterThanOrEqual(12);
        expect(sources.map(source => source.name)).toEqual(
            expect.arrayContaining([
                path.join('src', 'dialects', 'netezza'),
                path.join('src', 'dialects', 'sqlite'),
                path.join('extensions', 'mssql'),
            ]),
        );
    });

    it('declares EXPLAIN only with an explain provider', () => {
        const offenders = sources
            .filter(source => declaredFlag(source, 'supportsExplainPlan') !== hasProvider(source, 'explain'))
            .map(source => `${source.name}: supportsExplainPlan=${declaredFlag(source, 'supportsExplainPlan')}, provider=${hasProvider(source, 'explain')}`);

        expect(offenders).toEqual([]);
    });

    it('declares the EXPLAIN graph only when EXPLAIN is available', () => {
        const offenders = sources
            .filter(source => declaredFlag(source, 'supportsExplainGraph') && !hasProvider(source, 'explain'))
            .map(source => source.name);

        expect(offenders).toEqual([]);
    });

    it('declares the tuning advisor only with a tuning provider', () => {
        const offenders = sources
            .filter(source => declaredFlag(source, 'supportsTuningAdvisor') !== hasProvider(source, 'tuningAdvisor'))
            .map(source => `${source.name}: supportsTuningAdvisor=${declaredFlag(source, 'supportsTuningAdvisor')}, provider=${hasProvider(source, 'tuningAdvisor')}`);

        expect(offenders).toEqual([]);
    });

    it('declares table maintenance only with a maintenance provider', () => {
        const offenders = sources
            .filter(source => declaredFlag(source, 'supportsTableMaintenance') !== hasProvider(source, 'maintenance'))
            .map(source => `${source.name}: supportsTableMaintenance=${declaredFlag(source, 'supportsTableMaintenance')}, provider=${hasProvider(source, 'maintenance')}`);

        expect(offenders).toEqual([]);
    });

    it('declares the session monitor only with a monitor provider', () => {
        const offenders = sources
            .filter(source => declaredFlag(source, 'supportsSessionMonitor') !== hasProvider(source, 'sessionMonitor'))
            .map(source => `${source.name}: supportsSessionMonitor=${declaredFlag(source, 'supportsSessionMonitor')}, provider=${hasProvider(source, 'sessionMonitor')}`);

        expect(offenders).toEqual([]);
    });
});
