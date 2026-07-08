/**
 * Unit tests for core/variableUtils.ts
 */

import {
    extractVariables,
    parseSetVariables,
    replaceVariablesInSql,
    processVariables,
    extractVariablesFromQueries
} from '../core/variableUtils';

describe('core/variableUtils', () => {
    describe('extractVariables', () => {
        it('should return empty set for empty string', () => {
            expect(extractVariables('')).toEqual(new Set());
        });

        it('should return empty set for null-like input', () => {
            expect(extractVariables('')).toEqual(new Set());
        });

        it('should return empty set for SQL without variables', () => {
            expect(extractVariables('SELECT * FROM users')).toEqual(new Set());
        });

        it('should extract single variable with braces', () => {
            const result = extractVariables('SELECT * FROM ${TABLE}');
            expect(result).toEqual(new Set(['TABLE']));
        });

        it('should extract single variable without braces', () => {
            const result = extractVariables('SELECT * FROM $TABLE');
            expect(result).toEqual(new Set(['TABLE']));
        });

        it('should extract multiple variables with braces', () => {
            const result = extractVariables('SELECT * FROM ${TABLE} WHERE id = ${ID}');
            expect(result).toEqual(new Set(['TABLE', 'ID']));
        });

        it('should extract multiple variables without braces', () => {
            const result = extractVariables('SELECT * FROM $TABLE WHERE id = $ID');
            expect(result).toEqual(new Set(['TABLE', 'ID']));
        });

        it('should extract mixed format variables', () => {
            const result = extractVariables('SELECT * FROM ${TABLE} WHERE id = $ID');
            expect(result).toEqual(new Set(['TABLE', 'ID']));
        });

        it('should deduplicate repeated variables', () => {
            const result = extractVariables('SELECT ${COL}, ${COL} FROM ${TABLE}');
            expect(result).toEqual(new Set(['COL', 'TABLE']));
        });

        it('should deduplicate same variable in different formats', () => {
            const result = extractVariables('SELECT ${TABLE}, $TABLE FROM db');
            expect(result).toEqual(new Set(['TABLE']));
        });

        it('should treat variable names as case-insensitive', () => {
            const result = extractVariables('SELECT $VAR, $vAr, ${VaR}, {var}');
            expect(result).toEqual(new Set(['VAR']));
        });

        it('should handle variables with underscores', () => {
            const result = extractVariables('SELECT * FROM ${MY_TABLE_NAME}');
            expect(result).toEqual(new Set(['MY_TABLE_NAME']));
        });

        it('should handle $VAR with underscores', () => {
            const result = extractVariables('SELECT * FROM $MY_TABLE_NAME');
            expect(result).toEqual(new Set(['MY_TABLE_NAME']));
        });

        it('should extract single variable with braces only (no dollar sign)', () => {
            const result = extractVariables('SELECT * FROM {TABLE}');
            expect(result).toEqual(new Set(['TABLE']));
        });

        it('should extract multiple variables with braces only', () => {
            const result = extractVariables('SELECT * FROM {TABLE} WHERE id = {ID}');
            expect(result).toEqual(new Set(['TABLE', 'ID']));
        });

        it('should deduplicate same variable in braces-only and dollar formats', () => {
            const result = extractVariables('SELECT {TABLE}, ${TABLE} FROM db');
            expect(result).toEqual(new Set(['TABLE']));
        });

        it('should handle all three variable formats together', () => {
            const result = extractVariables('SELECT * FROM {TABLE} WHERE id = $ID AND name = ${NAME}');
            expect(result).toEqual(new Set(['TABLE', 'ID', 'NAME']));
        });

        it('should not extract braces-only variable starting with number', () => {
            const result = extractVariables('SELECT {123VAR} FROM {VALID}');
            expect(result).toEqual(new Set(['VALID']));
        });

        it('should handle variables starting with underscore', () => {
            const result = extractVariables('SELECT * FROM $_PRIVATE_TABLE');
            expect(result).toEqual(new Set(['_PRIVATE_TABLE']));
        });

        it('should handle variables with numbers (not at start)', () => {
            const result = extractVariables('SELECT * FROM ${TABLE1} JOIN ${TABLE2}');
            expect(result).toEqual(new Set(['TABLE1', 'TABLE2']));
        });

        it('should handle $VAR with numbers (not at start)', () => {
            const result = extractVariables('SELECT * FROM $TABLE1 JOIN $TABLE2');
            expect(result).toEqual(new Set(['TABLE1', 'TABLE2']));
        });

        it('should not extract $VAR starting with number', () => {
            // $123TABLE should not be extracted as variable
            const result = extractVariables('SELECT $123 FROM ${VALID}');
            expect(result).toEqual(new Set(['VALID']));
        });

        it('should handle multiline SQL', () => {
            const sql = `SELECT * 
FROM \${TABLE}
WHERE id = $ID`;
            expect(extractVariables(sql)).toEqual(new Set(['TABLE', 'ID']));
        });

        it('should stop $VAR at word boundary', () => {
            // $TABLE.column - should only extract TABLE
            const result = extractVariables('SELECT $TABLE.column FROM db');
            expect(result).toEqual(new Set(['TABLE']));
        });

        it('should handle $VAR at end of line', () => {
            const result = extractVariables('SELECT * FROM $TABLE');
            expect(result).toEqual(new Set(['TABLE']));
        });

        it('should extract SAS-style ampersand variables', () => {
            const result = extractVariables('SELECT * FROM &TABLE WHERE score > &points_cutoff');
            expect(result).toEqual(new Set(['TABLE', 'POINTS_CUTOFF']));
        });

        it('should extract braced dollar variables with inner whitespace', () => {
            const result = extractVariables('SELECT * FROM ${ TABLE } WHERE score > ${ points_cutoff }');
            expect(result).toEqual(new Set(['TABLE', 'POINTS_CUTOFF']));
        });
    });

    describe('parseSetVariables', () => {
        it('should return empty result for empty string', () => {
            const result = parseSetVariables('');
            expect(result).toEqual({ sql: '', setValues: {} });
        });

        it('should return unchanged SQL when no @SET present', () => {
            const sql = 'SELECT * FROM users';
            const result = parseSetVariables(sql);
            expect(result.sql).toBe(sql);
            expect(result.setValues).toEqual({});
        });

        it('should parse single @SET definition', () => {
            const sql = '@SET TABLE = users\nSELECT * FROM ${TABLE}';
            const result = parseSetVariables(sql);
            expect(result.sql).toBe('SELECT * FROM ${TABLE}');
            expect(result.setValues).toEqual({ TABLE: 'users' });
        });

        it('should parse multiple @SET definitions', () => {
            const sql = '@SET DB = mydb\n@SET TABLE = users\nSELECT * FROM ${DB}.${TABLE}';
            const result = parseSetVariables(sql);
            expect(result.sql).toBe('SELECT * FROM ${DB}.${TABLE}');
            expect(result.setValues).toEqual({ DB: 'mydb', TABLE: 'users' });
        });

        it('should be case-insensitive for @SET keyword', () => {
            const sql = '@set TABLE = users\n@SET DB = mydb\n@Set SCHEMA = admin';
            const result = parseSetVariables(sql);
            expect(result.setValues).toEqual({ TABLE: 'users', DB: 'mydb', SCHEMA: 'admin' });
        });

        it('should handle @SET with trailing semicolon', () => {
            const result = parseSetVariables('@SET TABLE = users;');
            expect(result.setValues).toEqual({ TABLE: 'users' });
        });

        it('should normalize variable names from @SET case-insensitively', () => {
            const result = parseSetVariables('@SET var = users');
            expect(result.setValues).toEqual({ VAR: 'users' });
        });

        it('should handle @SET with quoted values (single quotes)', () => {
            const result = parseSetVariables("@SET NAME = 'John Doe'");
            expect(result.setValues).toEqual({ NAME: 'John Doe' });
        });

        it('should handle @SET with quoted values (double quotes)', () => {
            const result = parseSetVariables('@SET NAME = "John Doe"');
            expect(result.setValues).toEqual({ NAME: 'John Doe' });
        });

        it('should handle @SET with spaces around equals', () => {
            const result = parseSetVariables('@SET  TABLE  =  users');
            expect(result.setValues).toEqual({ TABLE: 'users' });
        });

        it('should handle @SET at any position in SQL', () => {
            const sql = 'SELECT * FROM foo\n@SET BAR = baz\nWHERE x = 1';
            const result = parseSetVariables(sql);
            expect(result.sql).toBe('SELECT * FROM foo\nWHERE x = 1');
            expect(result.setValues).toEqual({ BAR: 'baz' });
        });

        it('should handle Windows-style line endings', () => {
            const sql = '@SET TABLE = users\r\nSELECT * FROM ${TABLE}';
            const result = parseSetVariables(sql);
            expect(result.sql).toBe('SELECT * FROM ${TABLE}');
            expect(result.setValues).toEqual({ TABLE: 'users' });
        });

        it('should handle leading whitespace before @SET', () => {
            const result = parseSetVariables('   @SET TABLE = users');
            expect(result.setValues).toEqual({ TABLE: 'users' });
        });

        it('should parse single %let definition and strip it from SQL', () => {
            const sql = '%let points_cutoff = 20;\nSELECT * FROM scores WHERE points > &points_cutoff';
            const result = parseSetVariables(sql);
            expect(result.sql).toBe('SELECT * FROM scores WHERE points > &points_cutoff');
            expect(result.setValues).toEqual({ POINTS_CUTOFF: '20' });
        });

        it('should parse %let quoted values', () => {
            const result = parseSetVariables("%let name = 'John Doe';");
            expect(result.sql).toBe('');
            expect(result.setValues).toEqual({ NAME: "'John Doe'" });
        });

        it('should preserve quoted %let values for SQL string literals', () => {
            const sql = "%let status = 'ACTIVE';\nSELECT * FROM t WHERE status = &status";
            const result = processVariables(sql);
            expect(result.processedSql).toBe("SELECT * FROM t WHERE status = 'ACTIVE'");
            expect(result.unresolvedVars).toEqual([]);
        });

        it('should parse %let with whitespace variations and same-line SQL', () => {
            const result = parseSetVariables('  %let   status_code   =   ACTIVE  ; SELECT * FROM t WHERE status = &status_code');
            expect(result.sql).toBe('SELECT * FROM t WHERE status = &status_code');
            expect(result.setValues).toEqual({ STATUS_CODE: 'ACTIVE' });
        });

        it('should use the last %let value when a variable is redefined', () => {
            const sql = '%let cutoff = 10;\n%let cutoff = 20;\nSELECT &cutoff';
            const result = parseSetVariables(sql);
            expect(result.sql).toBe('SELECT &cutoff');
            expect(result.setValues).toEqual({ CUTOFF: '20' });
        });

        it('should not parse %let names that start with a digit', () => {
            const sql = '%let 1cutoff = 20;\nSELECT 1';
            const result = parseSetVariables(sql);
            expect(result.sql).toBe(sql);
            expect(result.setValues).toEqual({});
        });
    });

    describe('replaceVariablesInSql', () => {
        it('should return unchanged SQL when no variables', () => {
            const sql = 'SELECT * FROM users';
            expect(replaceVariablesInSql(sql, {})).toBe(sql);
        });

        it('should replace single variable', () => {
            const sql = 'SELECT * FROM ${TABLE}';
            const result = replaceVariablesInSql(sql, { TABLE: 'users' });
            expect(result).toBe('SELECT * FROM users');
        });

        it('should replace multiple variables', () => {
            const sql = 'SELECT * FROM ${DB}.${SCHEMA}.${TABLE}';
            const result = replaceVariablesInSql(sql, {
                DB: 'mydb',
                SCHEMA: 'admin',
                TABLE: 'users'
            });
            expect(result).toBe('SELECT * FROM mydb.admin.users');
        });

        it('should replace same variable multiple times', () => {
            const sql = 'SELECT ${COL}, ${COL} FROM ${TABLE}';
            const result = replaceVariablesInSql(sql, { COL: 'name', TABLE: 'users' });
            expect(result).toBe('SELECT name, name FROM users');
        });

        it('should replace missing variable with empty string', () => {
            const sql = 'SELECT * FROM ${TABLE} WHERE ${MISSING}';
            const result = replaceVariablesInSql(sql, { TABLE: 'users' });
            expect(result).toBe('SELECT * FROM users WHERE ');
        });

        it('should handle value with special characters', () => {
            const sql = 'SELECT * FROM ${TABLE}';
            const result = replaceVariablesInSql(sql, { TABLE: 'my-special_table$name' });
            expect(result).toBe('SELECT * FROM my-special_table$name');
        });

        it('should handle value with SQL keywords', () => {
            const sql = 'SELECT * FROM ${TABLE}';
            const result = replaceVariablesInSql(sql, { TABLE: 'SELECT FROM WHERE' });
            expect(result).toBe('SELECT * FROM SELECT FROM WHERE');
        });

        it('should handle numeric values as strings', () => {
            const sql = 'SELECT * FROM users WHERE id = ${ID}';
            const result = replaceVariablesInSql(sql, { ID: '42' });
            expect(result).toBe('SELECT * FROM users WHERE id = 42');
        });

        // $VAR syntax tests
        it('should replace $VAR without braces', () => {
            const sql = 'SELECT * FROM $TABLE';
            const result = replaceVariablesInSql(sql, { TABLE: 'users' });
            expect(result).toBe('SELECT * FROM users');
        });

        it('should replace multiple $VAR without braces', () => {
            const sql = 'SELECT * FROM $DB.$SCHEMA.$TABLE';
            const result = replaceVariablesInSql(sql, {
                DB: 'mydb',
                SCHEMA: 'admin',
                TABLE: 'users'
            });
            expect(result).toBe('SELECT * FROM mydb.admin.users');
        });

        it('should replace mixed ${VAR} and $VAR', () => {
            const sql = 'SELECT * FROM ${TABLE} WHERE id = $ID';
            const result = replaceVariablesInSql(sql, { TABLE: 'users', ID: '42' });
            expect(result).toBe('SELECT * FROM users WHERE id = 42');
        });

        it('should replace variables case-insensitively across all placeholder forms', () => {
            const sql = 'SELECT $VAR, $vAr, ${VaR}, {var}';
            const result = replaceVariablesInSql(sql, { var: 'value' });
            expect(result).toBe('SELECT value, value, value, value');
        });

        it('should replace single variable with braces only', () => {
            const sql = 'SELECT * FROM {TABLE}';
            const result = replaceVariablesInSql(sql, { TABLE: 'users' });
            expect(result).toBe('SELECT * FROM users');
        });

        it('should replace multiple variables with braces only', () => {
            const sql = 'SELECT * FROM {DB}.{SCHEMA}.{TABLE}';
            const result = replaceVariablesInSql(sql, { DB: 'mydb', SCHEMA: 'public', TABLE: 'users' });
            expect(result).toBe('SELECT * FROM mydb.public.users');
        });

        it('should replace mixed all three formats', () => {
            const sql = 'SELECT * FROM {TABLE} WHERE id = $ID AND name = ${NAME}';
            const result = replaceVariablesInSql(sql, { TABLE: 'users', ID: '42', NAME: 'John' });
            expect(result).toBe('SELECT * FROM users WHERE id = 42 AND name = John');
        });

        it('should prefer ${VAR} over {VAR} when both present', () => {
            const sql = 'SELECT ${VAR}, {VAR} FROM db';
            const result = replaceVariablesInSql(sql, { VAR: 'value' });
            expect(result).toBe('SELECT value, value FROM db');
        });

        it('should not replace $VAR if not in values', () => {
            const sql = 'SELECT * FROM $UNKNOWN';
            const result = replaceVariablesInSql(sql, { TABLE: 'users' });
            expect(result).toBe('SELECT * FROM $UNKNOWN');
        });

        it('should replace longer variable name first', () => {
            // $TABLE_NAME should be replaced before $TABLE to avoid partial match
            const sql = 'SELECT * FROM $TABLE_NAME WHERE $TABLE = 1';
            const result = replaceVariablesInSql(sql, {
                TABLE: 'tab',
                TABLE_NAME: 'my_table'
            });
            expect(result).toBe('SELECT * FROM my_table WHERE tab = 1');
        });

        it('should handle $VAR starting with underscore', () => {
            const sql = 'SELECT * FROM $_PRIVATE';
            const result = replaceVariablesInSql(sql, { _PRIVATE: 'secret_table' });
            expect(result).toBe('SELECT * FROM secret_table');
        });

        it('should stop $VAR replacement at word boundary', () => {
            const sql = 'SELECT $COL.subfield FROM $TABLE';
            const result = replaceVariablesInSql(sql, { COL: 'data', TABLE: 'users' });
            expect(result).toBe('SELECT data.subfield FROM users');
        });

        it('should replace SAS-style ampersand variables', () => {
            const sql = 'SELECT * FROM &TABLE WHERE points > &points_cutoff';
            const result = replaceVariablesInSql(sql, { TABLE: 'scores', POINTS_CUTOFF: '20' });
            expect(result).toBe('SELECT * FROM scores WHERE points > 20');
        });

        it('should replace all SAS-compatible forms for the same variable', () => {
            const sql = 'SELECT $points_cutoff, ${points_cutoff}, ${ points_cutoff }, &points_cutoff';
            const result = replaceVariablesInSql(sql, { points_cutoff: '20' });
            expect(result).toBe('SELECT 20, 20, 20, 20');
        });
    });

    describe('processVariables', () => {
        it('should handle SQL without any variables', () => {
            const result = processVariables('SELECT * FROM users');
            expect(result.processedSql).toBe('SELECT * FROM users');
            expect(result.unresolvedVars).toEqual([]);
        });

        it('should resolve variables from @SET definitions', () => {
            const sql = '@SET TABLE = users\nSELECT * FROM ${TABLE}';
            const result = processVariables(sql);
            expect(result.processedSql).toBe('SELECT * FROM users');
            expect(result.unresolvedVars).toEqual([]);
        });

        it('should report unresolved variables', () => {
            const sql = 'SELECT * FROM ${TABLE} WHERE id = ${ID}';
            const result = processVariables(sql);
            expect(result.unresolvedVars).toContain('TABLE');
            expect(result.unresolvedVars).toContain('ID');
        });

        it('should allow overrides to replace @SET defaults', () => {
            const sql = '@SET TABLE = default_table\nSELECT * FROM ${TABLE}';
            const result = processVariables(sql, { TABLE: 'override_table' });
            expect(result.processedSql).toBe('SELECT * FROM override_table');
        });

        it('should merge @SET defaults with overrides', () => {
            const sql = '@SET DB = mydb\nSELECT * FROM ${DB}.${TABLE}';
            const result = processVariables(sql, { TABLE: 'users' });
            expect(result.processedSql).toBe('SELECT * FROM mydb.users');
            expect(result.unresolvedVars).toEqual([]);
        });

        it('should partially resolve when some variables missing', () => {
            const sql = '@SET DB = mydb\nSELECT * FROM ${DB}.${SCHEMA}.${TABLE}';
            const result = processVariables(sql, { TABLE: 'users' });
            expect(result.processedSql).toBe('SELECT * FROM mydb..users');
            expect(result.unresolvedVars).toEqual(['SCHEMA']);
        });
    });

    describe('extractVariablesFromQueries', () => {
        it('should return empty set for empty array', () => {
            expect(extractVariablesFromQueries([])).toEqual(new Set());
        });

        it('should extract variables from single query', () => {
            const queries = ['SELECT * FROM ${TABLE} WHERE id = $ID'];
            const result = extractVariablesFromQueries(queries);
            expect(result).toEqual(new Set(['TABLE', 'ID']));
        });

        it('should extract and deduplicate variables from multiple queries', () => {
            const queries = [
                'SELECT $VAR1',
                'SELECT ${VAR2}',
                'SELECT $VAR1' // duplicate
            ];
            const result = extractVariablesFromQueries(queries);
            expect(result).toEqual(new Set(['VAR1', 'VAR2']));
        });

        it('should handle @SET definitions and extract remaining variables', () => {
            const queries = [
                '@SET VAR1 = value1\nSELECT ${VAR2}',
                'SELECT ${VAR1}'
            ];
            const result = extractVariablesFromQueries(queries);
            // VAR1 is defined in first query via @SET, but used in second query
            // VAR2 is not defined anywhere
            expect(result).toEqual(new Set(['VAR1', 'VAR2']));
        });

        it('should extract variables from mixed format queries', () => {
            const queries = [
                'SELECT ${TABLE1}, $COL1 FROM db',
                'SELECT ${TABLE2}, $COL2 FROM db',
                'SELECT $TABLE1' // duplicate in different format
            ];
            const result = extractVariablesFromQueries(queries);
            expect(result).toEqual(new Set(['TABLE1', 'COL1', 'TABLE2', 'COL2']));
        });

        it('should handle queries without variables', () => {
            const queries = [
                'SELECT * FROM users',
                'SELECT ${VAR1}',
                'SELECT * FROM orders'
            ];
            const result = extractVariablesFromQueries(queries);
            expect(result).toEqual(new Set(['VAR1']));
        });
    });

    describe('comment and string literal stripping', () => {
        it('should ignore variables inside single-line comments', () => {
            const sql = '-- SELECT $COMMENTED\nSELECT ${REAL}';
            const result = extractVariables(sql);
            expect(result).toEqual(new Set(['REAL']));
            expect(result.has('COMMENTED')).toBe(false);
        });

        it('should ignore variables inside multi-line comments', () => {
            const sql = '/* SELECT $COMMENTED */ SELECT ${REAL}';
            const result = extractVariables(sql);
            expect(result).toEqual(new Set(['REAL']));
        });

        it('should ignore variables inside single-quoted strings', () => {
            const sql = "SELECT '$QUOTED' as col, ${REAL}";
            const result = extractVariables(sql);
            expect(result).toEqual(new Set(['REAL']));
            expect(result.has('QUOTED')).toBe(false);
        });

        it('should ignore variables inside double-quoted strings', () => {
            const sql = 'SELECT "$QUOTED" as col, ${REAL}';
            const result = extractVariables(sql);
            expect(result).toEqual(new Set(['REAL']));
        });

        it('should handle escaped single-quoted strings', () => {
            const sql = "SELECT '''$ESCAPED''' as col, ${REAL}";
            const result = extractVariables(sql);
            expect(result).toEqual(new Set(['REAL']));
        });

        it('should handle escaped double-quoted strings', () => {
            const sql = 'SELECT """$ESCAPED""" as col, ${REAL}';
            const result = extractVariables(sql);
            expect(result).toEqual(new Set(['REAL']));
        });

        it('should handle mixed comments and strings', () => {
            const sql = "-- comment $A\n/* block $B */\nSELECT '$C', $REAL";
            const result = extractVariables(sql);
            expect(result).toEqual(new Set(['REAL']));
        });
    });

    describe('parseSetVariables advanced', () => {
        it('should handle @SET with semicolon followed by SQL on same line', () => {
            const sql = '@SET A = 1; SELECT ${A}';
            const result = parseSetVariables(sql);
            expect(result.setValues).toEqual({ A: '1' });
            expect(result.sql).toBe('SELECT ${A}');
        });

        it('should handle @SET with value in single quotes and semicolon', () => {
            const sql = "@SET NAME = 'hello world'";
            const result = parseSetVariables(sql);
            expect(result.setValues).toEqual({ NAME: 'hello world' });
        });

        it('should handle @SET with value in double quotes', () => {
            const sql = '@SET NAME = "hello world"';
            const result = parseSetVariables(sql);
            expect(result.setValues).toEqual({ NAME: 'hello world' });
        });
    });

    describe('processVariables advanced', () => {
        it('should handle processVariables with no overrides and no @SET', () => {
            const result = processVariables('SELECT ${MISSING}');
            expect(result.unresolvedVars).toEqual(['MISSING']);
            expect(result.processedSql).toBe('SELECT ');
        });

        it('should handle processVariables with empty overrides', () => {
            const result = processVariables('@SET X = val\nSELECT ${X}', {});
            expect(result.processedSql).toBe('SELECT val');
            expect(result.unresolvedVars).toEqual([]);
        });

        it('should handle processVariables with $VAR format', () => {
            const result = processVariables('@SET TABLE = users\nSELECT * FROM $TABLE');
            expect(result.processedSql).toBe('SELECT * FROM users');
        });

        it('should resolve variables from %let definitions using all supported SAS forms', () => {
            const sql = '%let points_cutoff = 20;\nSELECT $points_cutoff, ${points_cutoff}, ${ points_cutoff }, &points_cutoff';
            const result = processVariables(sql);
            expect(result.processedSql).toBe('SELECT 20, 20, 20, 20');
            expect(result.unresolvedVars).toEqual([]);
        });

        it('should evaluate %EVAL expressions in %let declarations', () => {
            const sql = `%LET a = 5;
%LET b = 3;
%LET sum = %EVAL(&a + &b);
SELECT &sum;`;
            const result = processVariables(sql);
            expect(result.processedSql).toBe('SELECT 8;');
            expect(result.unresolvedVars).toEqual([]);
        });
    });

    describe('%PUT directives', () => {
        it('should strip %PUT and expose resolved messages', () => {
            const sql = `%LET a = 5;
%LET b = 3;
%LET sum = %EVAL(&a + &b);
%PUT Sum is &sum;`;
            const result = parseSetVariables(sql);

            expect(result.sql).toBe('');
            expect(result.setValues).toEqual({ A: '5', B: '3', SUM: '8' });
            expect(result.putMessages).toEqual(['Sum is 8']);
        });
    });
});
