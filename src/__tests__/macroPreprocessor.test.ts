import {
    MacroEnvironment,
    MacroPreprocessor,
} from '../core/macroPreprocessor';

describe('core/macroPreprocessor', () => {
    it('processes %let declarations and resolves all supported reference forms', () => {
        const result = new MacroPreprocessor().processScriptSync(`
%LET points_cutoff = 20;
SELECT &points_cutoff, $points_cutoff, ${'${ points_cutoff }'};
`);

        expect(result.sql.trim()).toBe('SELECT 20, 20, 20;');
        expect(result.variables).toEqual({ POINTS_CUTOFF: '20' });
        expect(result.unresolvedVariables).toEqual([]);
    });

    it('evaluates safe arithmetic in %eval declarations', () => {
        const result = new MacroPreprocessor().processScriptSync(`
%let a = 5;
%let b = %eval((&a + 3) * 2);
SELECT &b;
`);

        expect(result.sql.trim()).toBe('SELECT 16;');
        expect(result.variables.B).toBe('16');
    });

    it('leaves unresolved references in place and reports prompt candidates', () => {
        const result = new MacroPreprocessor().processScriptSync(
            '%put id=&id;\nSELECT &id, ${ name };',
        );

        expect(result.sql).toBe('SELECT &id, ${ name };');
        expect(result.putMessages).toEqual(['id=&id']);
        expect(result.unresolvedVariables).toEqual(['ID', 'NAME']);
    });

    it('keeps one environment across multiple statements in source order', () => {
        const environment = new MacroEnvironment();
        const preprocessor = new MacroPreprocessor();

        expect(preprocessor.processScriptSync('%let x=1;', { environment }).sql).toBe('');
        expect(preprocessor.processScriptSync('SELECT &x;', { environment }).sql).toBe('SELECT 1;');
        expect(preprocessor.processScriptSync('%let x=2;', { environment }).sql).toBe('');
        expect(preprocessor.processScriptSync('SELECT &x;', { environment }).sql).toBe('SELECT 2;');
    });

    it('ignores macro markers inside strings and comments', () => {
        const result = new MacroPreprocessor().processScriptSync(`
%let x = 7;
SELECT '&x' AS literal, &x AS value -- &x comment
/* ${'${ x }'} block */
`);

        expect(result.sql).toContain("'&x' AS literal, 7 AS value -- &x comment");
        expect(result.sql).toContain(`/* ${'${ x }'} block */`);
    });

    it('supports the async processing shape with log hooks', async () => {
        const log = jest.fn();
        const result = await new MacroPreprocessor().processScript(
            '%let x=1; %put value=&x;',
            {},
            { log },
        );

        expect(result.sql).toBe('');
        expect(log).toHaveBeenCalledWith('value=1');
    });

    it('expands %sql as first row and first column from the query result', async () => {
        const query = jest.fn().mockResolvedValue({ rows: [[100]] });

        const result = await new MacroPreprocessor().processScript(
            'SELECT %sql(SELECT MAX(DATEKEY) FROM JUST_DATA.ADMIN.DIMDATE) AS max_datekey;',
            {},
            { query },
        );

        expect(result.sql).toBe('SELECT 100 AS max_datekey;');
        expect(query).toHaveBeenCalledWith('SELECT MAX(DATEKEY) FROM JUST_DATA.ADMIN.DIMDATE');
    });

    it('expands %sqllist as a comma-separated SQL literal list', async () => {
        const query = jest.fn().mockResolvedValue({
            rows: [['EAST'], ["O'BRIEN"], [null], [5]],
        });

        const result = await new MacroPreprocessor().processScript(
            'SELECT * FROM t WHERE region IN (%sqllist(SELECT region FROM regions));',
            {},
            { query },
        );

        expect(result.sql).toBe("SELECT * FROM t WHERE region IN ('EAST', 'O''BRIEN', NULL, 5);");
    });

    it('expands empty %sqllist results as NULL to keep IN lists valid', async () => {
        const query = jest.fn().mockResolvedValue({ rows: [] });

        const result = await new MacroPreprocessor().processScript(
            'SELECT * FROM t WHERE region IN (%sqllist(SELECT region FROM regions WHERE 1=0));',
            {},
            { query },
        );

        expect(result.sql).toBe('SELECT * FROM t WHERE region IN (NULL);');
    });

    it('uses the first column for multi-column %SQL and %SQLLIST results', async () => {
        const query = jest.fn()
            .mockResolvedValueOnce({ rows: [[10, 'ignored']] })
            .mockResolvedValueOnce({ rows: [['A', 1], ['B', 2]] });

        const result = await new MacroPreprocessor().processScript(
            'SELECT %sql(SELECT a, b FROM t) AS value WHERE code IN (%sqllist(SELECT code, id FROM codes));',
            {},
            { query },
        );

        expect(result.sql).toBe("SELECT 10 AS value WHERE code IN ('A', 'B');");
    });

    it('wraps query execution failures with the macro function name', async () => {
        const query = jest.fn().mockRejectedValue(new Error('relation does not exist'));

        await expect(
            new MacroPreprocessor().processScript(
                'SELECT %sql(SELECT id FROM missing_table);',
                {},
                { query },
            ),
        ).rejects.toThrow('Failed to execute %SQL macro query: relation does not exist');
    });

    it('fails before executing query macros that still contain unresolved variables', async () => {
        const query = jest.fn();

        await expect(
            new MacroPreprocessor().processScript(
                'SELECT %sql(SELECT MAX(id) FROM &table_name);',
                {},
                { query },
            ),
        ).rejects.toThrow('%SQL macro query has unresolved variables: TABLE_NAME');
        expect(query).not.toHaveBeenCalled();
    });

    it('executes %EXPORT directives through the export context and strips them from SQL', async () => {
        const exporter = jest.fn().mockResolvedValue({
            filePath: '/tmp/report.xlsx',
            format: 'xlsx',
            rowsExported: 2,
            columns: 2,
        });

        const result = await new MacroPreprocessor().processScript(
            `%LET dim_table = JUST_DATA.ADMIN.DIMDATE;
%EXPORT(
  format='xlsx',
  file='/tmp/report.xlsx',
  sheet='Dim Date',
  query=(
    SELECT DATEKEY, CALENDARQUARTER
    FROM &dim_table
  ),
  overwrite=true
);
SELECT 1;`,
            {},
            { exporter },
        );

        expect(result.sql.trim()).toBe('SELECT 1;');
        expect(exporter).toHaveBeenCalledWith({
            format: 'xlsx',
            filePath: '/tmp/report.xlsx',
            sheetName: 'Dim Date',
            query: 'SELECT DATEKEY, CALENDARQUARTER\n    FROM JUST_DATA.ADMIN.DIMDATE',
            overwrite: true,
        });
    });

    it('infers %EXPORT format from the file extension', async () => {
        const exporter = jest.fn().mockResolvedValue({
            filePath: '/tmp/report.xlsb',
            format: 'xlsb',
            rowsExported: 1,
            columns: 1,
        });

        await new MacroPreprocessor().processScript(
            "%EXPORT(file='/tmp/report.xlsb', query=(SELECT 1));",
            {},
            { exporter },
        );

        expect(exporter).toHaveBeenCalledWith(expect.objectContaining({
            format: 'xlsb',
            sheetName: 'Query Results',
            overwrite: false,
        }));
    });

    it('unwraps quoted %LET values used as %EXPORT scalar arguments', async () => {
        const exporter = jest.fn().mockResolvedValue({
            filePath: '/tmp/report.xlsx',
            format: 'xlsx',
            rowsExported: 1,
            columns: 1,
        });

        await new MacroPreprocessor().processScript(
            `%LET export_file = '/tmp/report.xlsx';
%LET export_format = 'xlsx';
%LET overwrite_export = 'true';
%EXPORT(
  format=&export_format,
  file=&export_file,
  sheet='Data',
  query=(SELECT 1),
  overwrite=&overwrite_export
);`,
            {},
            { exporter },
        );

        expect(exporter).toHaveBeenCalledWith(expect.objectContaining({
            format: 'xlsx',
            filePath: '/tmp/report.xlsx',
            overwrite: true,
        }));
    });

    it('reports prompt candidates inside %EXPORT queries during scan mode', () => {
        const result = new MacroPreprocessor().processScriptSync(
            "%EXPORT(file='/tmp/${ report_name }.xlsx', query=(SELECT * FROM &table_name));",
            { replaceVariables: false },
        );

        expect(result.sql).toBe('');
        expect(result.unresolvedVariables).toEqual(['REPORT_NAME', 'TABLE_NAME']);
    });

    it('fails before exporting %EXPORT queries that still contain unresolved variables', async () => {
        const exporter = jest.fn();

        await expect(
            new MacroPreprocessor().processScript(
                "%EXPORT(file='/tmp/report.xlsx', query=(SELECT * FROM &table_name));",
                {},
                { exporter },
            ),
        ).rejects.toThrow('%EXPORT query has unresolved variables: TABLE_NAME');
        expect(exporter).not.toHaveBeenCalled();
    });

    it('resolves variables inside macro query functions before executing them', async () => {
        const query = jest.fn().mockResolvedValue({ rows: [[7]] });

        const result = await new MacroPreprocessor().processScript(
            '%let table_name = JUST_DATA.ADMIN.DIMDATE;\nSELECT %sql(SELECT MAX(DATEKEY) FROM &table_name);',
            {},
            { query },
        );

        expect(result.sql).toBe('SELECT 7;');
        expect(query).toHaveBeenCalledWith('SELECT MAX(DATEKEY) FROM JUST_DATA.ADMIN.DIMDATE');
    });

    it('supports multiline %SQL inside %LET declarations', async () => {
        const query = jest.fn().mockResolvedValue({ rows: [[20240731]] });

        const result = await new MacroPreprocessor().processScript(
            `%LET dim_table = JUST_DATA.ADMIN.DIMDATE;
%LET as_of_key = %SQL(
  SELECT MAX(DATEKEY)
  FROM &dim_table
);
SELECT &as_of_key AS as_of_key;`,
            {},
            { query },
        );

        expect(query).toHaveBeenCalledWith(
            'SELECT MAX(DATEKEY)\n  FROM JUST_DATA.ADMIN.DIMDATE',
        );
        expect(result.variables).toMatchObject({
            DIM_TABLE: 'JUST_DATA.ADMIN.DIMDATE',
            AS_OF_KEY: '20240731',
        });
        expect(result.sql).toBe('SELECT 20240731 AS as_of_key;');
    });

    it('resolves embedded %EVAL inside SQLLIST query macros', async () => {
        const query = jest.fn()
            .mockResolvedValueOnce({ rows: [[20240731]] })
            .mockResolvedValueOnce({ rows: [[1], [2]] });

        const result = await new MacroPreprocessor().processScript(
            `%LET dim_table = JUST_DATA.ADMIN.DIMDATE;
%LET as_of_key = %SQL(
  SELECT MAX(DATEKEY)
  FROM &dim_table
);

%PUT As-of DATEKEY resolved from database: &as_of_key;

SELECT
  d.DATEKEY,
  d.CALENDARQUARTER,
  &as_of_key AS as_of_key
FROM &dim_table d
WHERE d.DATEKEY = &as_of_key
  AND d.CALENDARQUARTER IN (
    %SQLLIST(
      SELECT DISTINCT CALENDARQUARTER
      FROM &dim_table
      WHERE DATEKEY >= %EVAL(&as_of_key - 30)
    )
  )
ORDER BY d.DATEKEY;`,
            {},
            { query },
        );

        expect(query).toHaveBeenNthCalledWith(
            1,
            'SELECT MAX(DATEKEY)\n  FROM JUST_DATA.ADMIN.DIMDATE',
        );
        expect(query).toHaveBeenNthCalledWith(
            2,
            'SELECT DISTINCT CALENDARQUARTER\n      FROM JUST_DATA.ADMIN.DIMDATE\n      WHERE DATEKEY >= 20240701',
        );
        expect(result.putMessages).toEqual([
            'As-of DATEKEY resolved from database: 20240731',
        ]);
        expect(result.sql).toContain('20240731 AS as_of_key');
        expect(result.sql).toContain('d.CALENDARQUARTER IN (\n    1, 2\n  )');
        expect(result.sql).not.toContain('%EVAL');
        expect(result.sql).not.toContain('EVAL(');
    });

    it('reports unresolved prompt variables inside macro query functions during scan mode', () => {
        const result = new MacroPreprocessor().processScriptSync(
            'SELECT %sql(SELECT MAX(DATEKEY) FROM &table_name WHERE REGION = ${ region });',
            { replaceVariables: false },
        );

        expect(result.unresolvedVariables).toEqual(['REGION', 'TABLE_NAME']);
    });

    it('does not execute %SQL inside %LET declarations during scan mode', () => {
        const result = new MacroPreprocessor().processScriptSync(
            `%LET dim_table = JUST_DATA.ADMIN.DIMDATE;
%LET as_of_key = %SQL(
  SELECT MAX(DATEKEY)
  FROM &dim_table
);`,
            { replaceVariables: false },
        );

        expect(result.sql).toBe('');
        expect(result.variables.DIM_TABLE).toBe('JUST_DATA.ADMIN.DIMDATE');
        expect(result.variables.AS_OF_KEY).toContain('%SQL(');
        expect(result.unresolvedVariables).toEqual([]);
    });

    it('evaluates %EVAL in %LET declarations during scan mode', () => {
        const result = new MacroPreprocessor().processScriptSync(
            `%LET a = 5;
%LET b = 3;
%LET sum = %EVAL(&a + &b);`,
            { replaceVariables: false },
        );

        expect(result.sql).toBe('');
        expect(result.variables).toEqual({ A: '5', B: '3', SUM: '8' });
        expect(result.unresolvedVariables).toEqual([]);
    });

    it('evaluates OR conditions without short-circuiting the parser', async () => {
        const result = await new MacroPreprocessor().processScript(
            `%IF 1 = 1 OR 0 = 1 %THEN %DO;
  SELECT 'both-true';
%END;`,
        );

        expect(result.sql.trim()).toBe("SELECT 'both-true';");
    });

    it('evaluates AND conditions without short-circuiting the parser', async () => {
        const result = await new MacroPreprocessor().processScript(
            `%IF 1 = 0 AND 1 = 1 %THEN %DO;
  SELECT 'skipped';
%ELSE %DO;
  SELECT 'fallback';
%END;`,
        );

        expect(result.sql.trim()).toBe("SELECT 'fallback';");
    });

    it('executes %IF true and false branches with numeric, text, and logical conditions', async () => {
        const result = await new MacroPreprocessor().processScript(
            `%LET score = 12;
%LET region = 'EAST';
%IF &score >= 10 AND NOT (&region = 'WEST') %THEN %DO;
  SELECT 'qualified' AS status;
%END;
%IF &region = 'WEST' OR &score < 10 %THEN %DO;
  SELECT &missing_from_skipped;
%ELSE %DO;
  SELECT 'fallback' AS status;
%END;`,
        );

        expect(result.sql).toContain("SELECT 'qualified' AS status;");
        expect(result.sql).toContain("SELECT 'fallback' AS status;");
        expect(result.sql).not.toContain('missing_from_skipped');
        expect(result.unresolvedVariables).toEqual([]);
        expect(result.scriptEvents?.filter(event => event.type === 'branch')).toHaveLength(2);
    });

    it('does not execute %SQL or %EXPORT directives in skipped branches', async () => {
        const query = jest.fn();
        const exporter = jest.fn();

        const result = await new MacroPreprocessor().processScript(
            `%LET run = 0;
%IF &run = 1 %THEN %DO;
  %LET value = %SQL(SELECT 1);
  %EXPORT(file='/tmp/skipped.xlsx', query=(SELECT * FROM &missing_table));
%ELSE %DO;
  SELECT 1;
%END;`,
            {},
            { query, exporter },
        );

        expect(result.sql.trim()).toBe('SELECT 1;');
        expect(query).not.toHaveBeenCalled();
        expect(exporter).not.toHaveBeenCalled();
        expect(result.unresolvedVariables).toEqual([]);
    });

    it('supports nested %IF blocks', async () => {
        const result = await new MacroPreprocessor().processScript(
            `%LET outer = 1;
%LET inner = 'Y';
%IF &outer = 1 %THEN %DO;
  %IF &inner = 'Y' %THEN %DO;
    SELECT 'nested';
  %END;
%END;`,
        );

        expect(result.sql.trim()).toBe("SELECT 'nested';");
    });

    it('scans both branches when an unresolved prompt variable controls %IF', () => {
        const result = new MacroPreprocessor().processScriptSync(
            `%IF &run = 1 %THEN %DO;
  SELECT &customer_id;
  %LET branch_only = 1;
%ELSE %DO;
  SELECT &fallback_id;
%END;
SELECT &branch_only;`,
            { replaceVariables: false },
        );

        expect(result.unresolvedVariables).toEqual([
            'BRANCH_ONLY',
            'CUSTOMER_ID',
            'FALLBACK_ID',
            'RUN',
        ]);
        expect(result.variables.BRANCH_ONLY).toBeUndefined();
    });

    it('reports source and line for malformed macro blocks', async () => {
        await expect(
            new MacroPreprocessor().processScript(
                `%IF 1 = 1 %THEN %DO;
SELECT 1;`,
                {},
                { sourceName: 'main.sql' },
            ),
        ).rejects.toThrow('Missing %END for %IF block at depth 1 at main.sql:1');
    });

    it('processes %INCLUDE files with the same macro environment', async () => {
        const readFile = jest.fn().mockResolvedValue({
            path: '/workspace/inc.sql',
            content: `%LET x = 2;
SELECT &x AS from_include;`,
        });

        const result = await new MacroPreprocessor().processScript(
            `%LET x = 1;
%INCLUDE 'inc.sql';
SELECT &x AS after_include;`,
            {},
            { readFile, sourceName: '/workspace/main.sql' },
        );

        expect(readFile).toHaveBeenCalledWith('inc.sql', '/workspace/main.sql');
        expect(result.sql).toContain('SELECT 2 AS from_include;');
        expect(result.sql).toContain('SELECT 2 AS after_include;');
        expect(result.scriptEvents).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'include',
                message: '>>> %INCLUDE: /workspace/inc.sql',
                sourceName: '/workspace/main.sql',
                line: 2,
            }),
        ]));
    });

    it('detects %INCLUDE cycles', async () => {
        const readFile = jest.fn()
            .mockResolvedValueOnce({
                path: '/workspace/inc.sql',
                content: "%INCLUDE 'main.sql';",
            })
            .mockResolvedValueOnce({
                path: '/workspace/main.sql',
                content: 'SELECT 1;',
            });

        await expect(
            new MacroPreprocessor().processScript(
                "%INCLUDE 'inc.sql';",
                {},
                { readFile, sourceName: '/workspace/main.sql' },
            ),
        ).rejects.toThrow('Macro include cycle detected');
    });

    it('fails when %IF condition still has unresolved variables in sync execution mode', () => {
        expect(() => new MacroPreprocessor().processScriptSync(
            `%IF &run = 1 %THEN %DO;
  SELECT 1;
%END;`,
            { replaceVariables: true },
        )).toThrow('%IF condition has unresolved variables: RUN');
    });
});
