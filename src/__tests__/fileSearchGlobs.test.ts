import {
    buildFileSearchGlobs,
    createIgnoreFilter,
    excludeSettingsToGlobs,
    pushPatternHistory,
    splitGlobList,
} from '../services/fileSearchService';
import { FileSearchHtmlGenerator } from '../views/fileSearchHtmlGenerator';

describe('file search include/exclude globs', () => {
    it('splits comma-separated patterns and drops empty entries', () => {
        expect(splitGlobList(' *.sql, ,src/** ,')).toEqual(['*.sql', 'src/**']);
        expect(splitGlobList('   ')).toEqual([]);
    });

    it('searches every file when include is empty and keeps the built-in excludes', () => {
        const { includeGlob, excludeGlob } = buildFileSearchGlobs('', '');
        expect(includeGlob).toBe('**/*');
        expect(excludeGlob).toContain('**/node_modules/**');
        expect(excludeGlob).toContain('**/.git/**');
    });

    it('matches a bare extension at any depth and combines several includes', () => {
        const { includeGlob } = buildFileSearchGlobs('*.sql, *.py', '');
        expect(includeGlob).toBe('{**/*.sql,**/*.py}');
    });

    it('keeps path-based includes anchored and treats a trailing slash as a folder', () => {
        expect(buildFileSearchGlobs('src/**/*.sql', '').includeGlob).toBe('src/**/*.sql');
        expect(buildFileSearchGlobs('migrations/', '').includeGlob).toBe('migrations/**');
    });

    it('excludes a folder name together with its contents', () => {
        const { excludeGlob } = buildFileSearchGlobs('', 'build, *.csv');
        expect(excludeGlob).toContain('**/build,**/build/**');
        expect(excludeGlob).toContain('**/*.csv');
        expect(excludeGlob).toContain('**/*.csv/**');
    });

    it('normalises Windows-style separators in user patterns', () => {
        expect(buildFileSearchGlobs('src\\sub\\*.sql', '').includeGlob).toBe('src/sub/*.sql');
    });
});

describe('exclude settings and gitignore rules', () => {
    it('takes only enabled entries from files.exclude and search.exclude', () => {
        expect(excludeSettingsToGlobs(
            { '**/.git': true, '**/*.log': false, '**/.DS_Store': { when: '$(basename).bak' } },
            { '**/coverage': true },
            undefined,
        )).toEqual(['**/.git', '**/coverage']);
    });

    it('adds settings globs to the exclude glob alongside user excludes', () => {
        const { excludeGlob } = buildFileSearchGlobs('', 'build', ['**/coverage']);
        expect(excludeGlob).toContain('**/build,**/build/**');
        expect(excludeGlob).toContain('**/coverage,**/coverage/**');
    });

    it('applies a .gitignore only below its own directory', () => {
        const ignored = createIgnoreFilter([
            { dir: '', content: '*.log\n!keep.log\n' },
            { dir: 'app/tmp', content: 'scratch.sql\n' },
        ]);
        expect(ignored('debug.log')).toBe(true);
        expect(ignored('keep.log')).toBe(false);
        expect(ignored('app/tmp/scratch.sql')).toBe(true);
        expect(ignored('other/scratch.sql')).toBe(false);
    });

    it('treats a directory rule as ignoring everything inside it', () => {
        const ignored = createIgnoreFilter([{ dir: '', content: 'generated/\n' }]);
        expect(ignored('generated/out/a.sql')).toBe(true);
        expect(ignored('src/generated.sql')).toBe(false);
    });
});

describe('pattern history', () => {
    it('keeps the newest value first, without duplicates or blanks', () => {
        let history: string[] = [];
        history = pushPatternHistory(history, '*.sql');
        history = pushPatternHistory(history, '  *.py ');
        history = pushPatternHistory(history, '*.sql');
        history = pushPatternHistory(history, '   ');
        expect(history).toEqual(['*.sql', '*.py']);
    });

    it('caps the list length', () => {
        let history: string[] = [];
        for (let i = 0; i < 25; i++) history = pushPatternHistory(history, `p${i}`);
        expect(history).toHaveLength(20);
        expect(history[0]).toBe('p24');
    });
});

describe('file search webview markup', () => {
    it('renders include/exclude fields and a script that parses', () => {
        const html = new FileSearchHtmlGenerator('test-session').generateHtml();
        expect(html).toContain('id="includeInput"');
        expect(html).toContain('id="excludeInput"');
        expect(html).not.toContain('chkSql');
        expect(html).toContain('id="btnOpenEditors"');
        expect(html).toContain('id="btnUseExclude"');
        const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? '';
        expect(() => new Function('acquireVsCodeApi', script)).not.toThrow();
    });
});
