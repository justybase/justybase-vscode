import {
  buildSqlScanIndex,
  buildSqlSourceScanIndex,
  findNestedBlockCommentEnd,
  isInsideStringOrComment,
  isOffsetInSqlComment,
  SqlSourceRegion,
  stripComments,
  stripCommentsAndLiterals,
} from '../sql/sqlSourceScan';

describe('sql/sqlSourceScan', () => {
  function offsetOf(text: string, needle: string, occurrence = 0): number {
    let index = -1;
    for (let i = 0; i <= occurrence; i++) {
      index = text.indexOf(needle, index + 1);
      expect(index).toBeGreaterThanOrEqual(0);
    }
    return index;
  }

  describe('isOffsetInSqlComment', () => {
    it('treats line-start -- as comment', () => {
      const sql = '-- CALL JUST_DATA..DIMACCOUNT';
      expect(isOffsetInSqlComment(sql, offsetOf(sql, 'CALL'))).toBe(true);
    });

    it('treats mid-line -- as comment', () => {
      const sql = 'SELECT 1 -- CALL';
      expect(isOffsetInSqlComment(sql, offsetOf(sql, 'CALL'))).toBe(true);
    });

    it('does not treat -- inside single-quoted string as comment', () => {
      const sql = "SELECT '--', * FROM JUST_DATA..DIMACCOUNT";
      expect(isOffsetInSqlComment(sql, offsetOf(sql, 'JUST_DATA'))).toBe(false);
      expect(isOffsetInSqlComment(sql, offsetOf(sql, 'DIMACCOUNT'))).toBe(false);
    });

    it('does not treat -- inside block comment body as line comment for later code', () => {
      const sql = 'SELECT * FROM /*--*/ JUST_DATA..DIMACCOUNT';
      expect(isOffsetInSqlComment(sql, offsetOf(sql, '--'))).toBe(true);
      expect(isOffsetInSqlComment(sql, offsetOf(sql, 'JUST_DATA'))).toBe(false);
      expect(isOffsetInSqlComment(sql, offsetOf(sql, 'DIMACCOUNT'))).toBe(false);
    });

    it('treats block comment contents as comment', () => {
      const sql = 'SELECT /* CALL */ 1';
      expect(isOffsetInSqlComment(sql, offsetOf(sql, 'CALL'))).toBe(true);
    });

    it('treats nested block comments as one comment region', () => {
      const sql = [
        '/* outer start',
        '   /* inner still comment */',
        'outer end */',
        'SELECT 1',
      ].join('\n');
      expect(isOffsetInSqlComment(sql, offsetOf(sql, 'outer'))).toBe(true);
      expect(isOffsetInSqlComment(sql, offsetOf(sql, 'inner'))).toBe(true);
      expect(isOffsetInSqlComment(sql, offsetOf(sql, 'SELECT'))).toBe(false);
    });

    it('treats multi-level nested block comments as one comment region', () => {
      const sql = [
        '/* level 1',
        '   /* level 2',
        '      /* level 3 */',
        '   level 2 end */',
        'level 1 end */',
        'SELECT * FROM JUST_DATA..DIMACCOUNT',
      ].join('\n');

      expect(isOffsetInSqlComment(sql, offsetOf(sql, 'level 3'))).toBe(true);
      expect(isOffsetInSqlComment(sql, offsetOf(sql, 'level 2 end'))).toBe(true);
      expect(isOffsetInSqlComment(sql, offsetOf(sql, 'JUST_DATA'))).toBe(false);
    });

    it('does not treat block comment markers inside quoted strings as comments', () => {
      const sql = 'SELECT \'/* not comment */\', "*/not comment/*" FROM JUST_DATA..DIMACCOUNT';
      const singleMarker = offsetOf(sql, '/*');
      const doubleMarker = offsetOf(sql, '*/', 1);

      expect(isOffsetInSqlComment(sql, singleMarker)).toBe(false);
      expect(isInsideStringOrComment(sql, singleMarker)).toBe(true);
      expect(isOffsetInSqlComment(sql, doubleMarker)).toBe(false);
      expect(isInsideStringOrComment(sql, doubleMarker)).toBe(true);
      expect(isOffsetInSqlComment(sql, offsetOf(sql, 'JUST_DATA'))).toBe(false);
    });
  });

  describe('findNestedBlockCommentEnd', () => {
    it('returns the outer closing offset for nested block comments', () => {
      const sql = '/* a /* b */ c */ SELECT 1';
      const end = findNestedBlockCommentEnd(sql, 0);
      expect(end).toBe(sql.indexOf(' SELECT'));
      expect(sql.slice(end)).toBe(' SELECT 1');
    });

    it('returns undefined for non-comment starts and unclosed block comments', () => {
      expect(findNestedBlockCommentEnd('SELECT 1', 0)).toBeUndefined();
      expect(findNestedBlockCommentEnd('/* unclosed /* nested */', 0)).toBeUndefined();
    });
  });

  describe('isInsideStringOrComment with double quotes', () => {
    it('treats "--" as double-quoted literal, not comment', () => {
      const sql = 'SELECT "--" FROM t';
      const dashIndex = sql.indexOf('--');
      expect(isOffsetInSqlComment(sql, dashIndex)).toBe(false);
      expect(isInsideStringOrComment(sql, dashIndex)).toBe(true);
      expect(buildSqlSourceScanIndex(sql).isInString(dashIndex)).toBe(true);
    });

    it('treats escaped double quotes inside identifiers', () => {
      const sql = 'SELECT "a""b" FROM t';
      const bIndex = sql.indexOf('b"');
      expect(buildSqlSourceScanIndex(sql).region[bIndex]).toBe(
        SqlSourceRegion.DoubleQuoted,
      );
      expect(isInsideStringOrComment(sql, bIndex)).toBe(true);
      expect(isOffsetInSqlComment(sql, bIndex)).toBe(false);
    });
  });

  describe('stripComments', () => {
    it('removes comments but keeps single-quoted literals', () => {
      const sql = "SELECT 'hello' FROM t -- comment";
      const result = stripComments(sql);
      expect(result).toContain("'hello'");
      expect(result).not.toContain('comment');
    });

    it('does not strip past single-quoted --', () => {
      const sql = "SELECT '--', * FROM t";
      const result = stripComments(sql);
      expect(result).toContain("'--'");
      expect(result).toContain('FROM');
    });

    it('preserves SQL after single-quoted -- for completion prep', () => {
      const sql = "SELECT '--', * FROM JUST_DATA..DIMACCOUNT";
      const result = stripComments(sql);
      expect(result).toContain("'--'");
      expect(result).toContain('* FROM JUST_DATA..DIMACCOUNT');
    });

    it('removes block comments but keeps double-quoted literals', () => {
      const sql = 'SELECT /* x */ "--" FROM t';
      const result = stripComments(sql);
      expect(result).toContain('"--"');
      expect(result).not.toContain('/*');
    });

    it('removes nested block comments as a single region', () => {
      const sql = 'SELECT /* outer /* inner */ still comment */ 1';
      const result = stripComments(sql);
      expect(result).toContain('SELECT');
      expect(result).toContain('1');
      expect(result).not.toContain('outer');
      expect(result).not.toContain('still comment');
    });
  });

  describe('stripCommentsAndLiterals', () => {
    it('removes comments and quoted literals', () => {
      const sql = "SELECT 'users' FROM orders -- users table";
      const result = stripCommentsAndLiterals(sql);
      expect(result.toUpperCase()).toContain('SELECT');
      expect(result.toUpperCase()).toContain('FROM ORDERS');
      expect(result).not.toContain('users');
    });
  });

  describe('buildSqlScanIndex shim', () => {
    it('classifies opening quote and string body as inside string or comment', () => {
      const sql = "SELECT 'x' FROM t";
      const openIndex = sql.indexOf("'");
      const innerIndex = openIndex + 1;
      const index = buildSqlScanIndex(sql);

      expect(index.isInsideStringOrComment(openIndex)).toBe(true);
      expect(index.isInsideStringOrComment(innerIndex)).toBe(true);
      expect(index.isInsideStringOrComment(sql.indexOf('SELECT'))).toBe(false);
      expect(index.masked[openIndex]).toBe(1);
      expect(index.masked[innerIndex]).toBe(1);
    });
  });
});
