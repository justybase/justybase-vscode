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
});
