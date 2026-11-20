import { compactSqlErrorMessage, summarizeSqlErrorMessage } from '../src/sqlErrorMessage';

const COLUMNS = [
  'd.DATEKEY',
  'd.FULLDATEALTERNATEKEY',
  'd.DAYNUMBEROFWEEK',
  'd.ENGLISHDAYNAMEOFWEEK',
  'd.SPANISHDAYNAMEOFWEEK',
  'd.FRENCHDAYNAMEOFWEEK',
  'd.DAYNUMBEROFMONTH',
  'd.DAYNUMBEROFYEAR',
  'd.WEEKNUMBEROFYEAR',
  'd.ENGLISHMONTHNAME',
  'd.SPANISHMONTHNAME',
  'd.FRENCHMONTHNAME',
  'd.MONTHNUMBEROFYEAR',
  'd.CALENDARQUARTER',
  'd.CALENDARYEAR',
  'd.CALENDARSEMESTER',
  'd.FISCALQUARTER',
  'd.FISCALYEAR',
  'd.FISCALSEMESTER',
].join(', ');

function cte(name: string, select = COLUMNS): string {
  return `, ${name} as (\n\nSELECT ${select} FROM just_data..DIMDATE d\n)`;
}

const LONG_SQL = [
  `WITH abc as (\n\nSELECT ${COLUMNS} FROM just_data..DIMDATE d\n)`,
  cte('abc2'),
  cte('abc3'),
  cte('abc4'),
  cte('abc5'),
  cte('abc6'),
  cte('abc7', `,,${COLUMNS}`),
  '\n\nSELECT 1,2 FROM abc',
].join('');

function driverMessage(sql: string, detail: string): string {
  return `Error: Netezza Error: ERROR:  '${sql}'\nerror ^ ${detail}`;
}

describe('compactSqlErrorMessage', () => {
  it('puts the parser diagnostic first and shortens the echoed statement', () => {
    const firstComma = LONG_SQL.indexOf('SELECT ,,') + 'SELECT '.length;
    const char = firstComma + 2;
    const message = driverMessage(
      LONG_SQL,
      `found "," (at char ${char}) expecting an identifier found a keyword`,
    );

    const compacted = compactSqlErrorMessage(message);
    const [summary, excerpt, caretLine] = compacted.split('\n');

    expect(summary).toBe(`ERROR: found "," (at char ${char}) expecting an identifier found a keyword`);
    expect(excerpt?.startsWith('…')).toBe(true);
    expect(excerpt?.endsWith('…')).toBe(true);
    expect(excerpt?.length).toBeLessThanOrEqual(98);
    expect(compacted.length).toBeLessThan(300);

    // The caret still points at the offending comma inside the excerpt.
    expect(excerpt?.[caretLine!.indexOf('^')]).toBe(',');
    expect(excerpt?.[caretLine!.indexOf('^') - 1]).toBe(',');
  });

  it('keeps short statements in the driver layout', () => {
    const message = driverMessage('SELECT 1,,2', 'found "," (at char 10) expecting an identifier');
    expect(compactSqlErrorMessage(message)).toBe(message);
  });

  it('leaves messages without an echoed statement untouched', () => {
    const message = 'ERROR:  relation does not exist JUST_DATA.ADMIN.NO_SUCH_TABLE';
    expect(compactSqlErrorMessage(message)).toBe(message);
    expect(compactSqlErrorMessage('connect ECONNREFUSED 127.0.0.1:5480')).toBe('connect ECONNREFUSED 127.0.0.1:5480');
  });

  it('is idempotent so hosts and webviews can both apply it', () => {
    const message = driverMessage(LONG_SQL, 'found "," (at char 100) expecting an identifier');
    const compacted = compactSqlErrorMessage(message);
    expect(compactSqlErrorMessage(compacted)).toBe(compacted);
  });

  it('handles a caret appended to the closing quote of a single-line echo', () => {
    const sql = LONG_SQL.replace(/\s+/gu, ' ');
    const char = sql.indexOf('SELECT ,,') + 'SELECT '.length + 2;
    const message = `ERROR: '${sql}' error ^ found "," (at char ${char}) expecting an identifier`;
    const compacted = compactSqlErrorMessage(message);
    const [, excerpt, caretLine] = compacted.split('\n');
    expect(compacted.split('\n')[0]).toBe(`ERROR: found "," (at char ${char}) expecting an identifier`);
    expect(excerpt?.[caretLine!.indexOf('^')]).toBe(',');
  });

  it('maps CRLF statements even when the echoed statement normalized line breaks', () => {
    const crlf = LONG_SQL.replace(/\n/gu, '\r\n');
    const echo = crlf.replace(/\r\n/gu, '\n');
    const secondComma = crlf.indexOf('SELECT ,,') + 'SELECT '.length + 1;
    const message = `ERROR: '${echo}'\nerror ^ found "," (at char ${secondComma + 1}) expecting an identifier`;
    const compacted = compactSqlErrorMessage(message);
    const [, excerpt, caretLine] = compacted.split('\n');
    const caret = caretLine!.indexOf('^');
    expect(excerpt?.[caret]).toBe(',');
    expect(excerpt?.[caret - 1]).toBe(',');
  });

  it('keeps single quotes in the diagnostic out of the statement range', () => {
    const message = driverMessage(LONG_SQL, "found \"\" (at char 57) expecting ','");
    const compacted = compactSqlErrorMessage(message);
    expect(compacted.split('\n')[0]).toBe("ERROR: found \"\" (at char 57) expecting ','");
    expect(compacted).toContain('^');
  });

  it('maps character offsets across line breaks', () => {
    const sql = `SELECT ${'a, '.repeat(80)}\n,,tail`;
    const offset = sql.indexOf(',,tail') + 1;
    const message = driverMessage(sql, `found "," (at char ${offset + 1}) expecting an identifier`);
    const compacted = compactSqlErrorMessage(message);
    const caretLine = compacted.split('\n')[2] ?? '';
    const excerpt = compacted.split('\n')[1] ?? '';
    expect(excerpt[caretLine.indexOf('^')]).toBe(',');
  });

  it('falls back to the caret column when the position is missing', () => {
    const message = `ERROR: '${LONG_SQL}'\nerror${' '.repeat(20)}^ found "," expecting an identifier`;
    const compacted = compactSqlErrorMessage(message);
    expect(compacted.split('\n')[0]).toBe('ERROR: found "," expecting an identifier');
    expect(compacted).toContain('^');
  });

  it('summarizes only the diagnostic for inline hints', () => {
    const message = driverMessage(LONG_SQL, 'found "," (at char 10) expecting an identifier');
    expect(summarizeSqlErrorMessage(message)).toBe('found "," (at char 10) expecting an identifier');
    expect(summarizeSqlErrorMessage(message, 20)).toBe('found "," (at char…');
    expect(summarizeSqlErrorMessage('Connection lost')).toBe('Connection lost');
  });
});
