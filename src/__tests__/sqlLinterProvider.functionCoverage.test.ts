const validateMock = jest.fn();
const getInitializedSqlValidatorMock = jest.fn();
const getSqlValidationContextMock = jest.fn();

jest.mock('../sqlParser', () => ({
  SqlValidator: jest.fn().mockImplementation(() => ({
    validate: validateMock,
  })),
}));

jest.mock('../commands/validationCommands', () => ({
  getInitializedSqlValidator: getInitializedSqlValidatorMock,
  getSqlValidationContext: getSqlValidationContextMock,
}));

jest.mock('../activation/lspRegistration', () => ({
  isSqlLanguageClientRunning: jest.fn(() => true),
}));

import { SqlLinterProvider } from '../providers/sqlLinterProvider';

const binaryMathQueries: Array<[string, string]> = [
  ['INT1AND', 'SELECT INT1AND(3, 6);'],
  ['INT1OR', 'SELECT INT1OR(3, 6);'],
  ['INT1XOR', 'SELECT INT1XOR(3, 6);'],
  ['INT1NOT', 'SELECT INT1NOT(3);'],
  ['INT1SHL', 'SELECT INT1SHL(3, 1, 6);'],
  ['INT1SHR', 'SELECT INT1SHR(3, 1, 6);'],
  ['INT2AND', 'SELECT INT2AND(3, 6);'],
  ['INT2OR', 'SELECT INT2OR(3, 6);'],
  ['INT2XOR', 'SELECT INT2XOR(3, 6);'],
  ['INT2NOT', 'SELECT INT2NOT(3);'],
  ['INT2SHL', 'SELECT INT2SHL(3, 1, 6);'],
  ['INT2SHR', 'SELECT INT2SHR(3, 1, 6);'],
  ['INT4AND', 'SELECT INT4AND(3, 6);'],
  ['INT4OR', 'SELECT INT4OR(3, 6);'],
  ['INT4XOR', 'SELECT INT4XOR(3, 6);'],
  ['INT4NOT', 'SELECT INT4NOT(3);'],
  ['INT4SHL', 'SELECT INT4SHL(3, 1, 6);'],
  ['INT4SHR', 'SELECT INT4SHR(3, 1, 6);'],
  ['INT8AND', 'SELECT INT8AND(3, 6);'],
  ['INT8OR', 'SELECT INT8OR(3, 6);'],
  ['INT8XOR', 'SELECT INT8XOR(3, 6);'],
  ['INT8NOT', 'SELECT INT8NOT(3);'],
  ['INT8SHL', 'SELECT INT8SHL(3, 1, 6);'],
  ['INT8SHR', 'SELECT INT8SHR(3, 1, 6);'],
];

const characterQueries: Array<[string, string]> = [
  ['ASCII', "SELECT ASCII('A');"],
  ['BTRIM', "SELECT BTRIM('  hi  ');"],
  ['CHR', 'SELECT CHR(65);'],
  ['INITCAP', "SELECT INITCAP('hello world');"],
  ['INSTR', "SELECT INSTR('Hello World', 'o');"],
  ['LENGTH', "SELECT LENGTH('abc');"],
  ['LOWER', "SELECT LOWER('HELLO');"],
  ['LPAD', "SELECT LPAD('5', 3, '0');"],
  ['LTRIM', "SELECT LTRIM('  hi');"],
  ['REPEAT', "SELECT REPEAT('ab', 3);"],
  ['RPAD', "SELECT RPAD('5', 3, '0');"],
  ['RTRIM', "SELECT RTRIM('hi  ');"],
  ['STRPOS', "SELECT STRPOS('Hello World', 'o');"],
  ['SUBSTR', "SELECT SUBSTR('abcdefg', 1, 4);"],
  ['TRANSLATE', "SELECT TRANSLATE('12345', '14', 'ax');"],
  ['UPPER', "SELECT UPPER('hello');"],
  ['UNICHR', 'SELECT UNICHR(65);'],
  ['UNICODE', "SELECT UNICODE('A');"],
  ['UNICODES', "SELECT UNICODES('AZ');"],
];

const dateTimeQueries: Array<[string, string]> = [
  ['ADD_MONTHS', "SELECT ADD_MONTHS(DATE '2015-03-03', 2);"],
  ['AGE', "SELECT AGE(TIMESTAMP '2003-10-22 09:46:07.325', TIMESTAMP '2002-07-06 00:00:00');"],
  ['AGE_SINGLE', "SELECT AGE(TIMESTAMP '2003-10-22 09:46:07.325');"],
  ['DATE_PART', "SELECT DATE_PART('year', DATE '2015-05-23');"],
  ['DATE_TRUNC', "SELECT DATE_TRUNC('month', TIMESTAMP '2015-05-23 12:00:00');"],
  ['EXTRACT', "SELECT EXTRACT(MONTH FROM DATE '2020-06-15');"],
  ['LAST_DAY', "SELECT LAST_DAY(DATE '2015-05-23');"],
  ['MONTHS_BETWEEN', "SELECT MONTHS_BETWEEN(DATE '2015-05-23', DATE '2015-04-23');"],
  ['NEXT_DAY', "SELECT NEXT_DAY(DATE '2013-12-25', 'Saturday');"],
  ['NOW', 'SELECT NOW();'],
  ['OVERLAPS', "SELECT OVERLAPS(TIMESTAMP '2000-01-01 10:00:00', INTERVAL '1 hour', TIMESTAMP '2000-01-01 10:30:00', INTERVAL '1 hour');"],
  ['DURATION_ADD', 'SELECT DURATION_ADD(1, 2);'],
  ['DURATION_SUBTRACT', 'SELECT DURATION_SUBTRACT(2, 1);'],
  ['TIMEOFDAY', 'SELECT TIMEOFDAY();'],
  ['TIMEZONE', "SELECT TIMEZONE(TIMESTAMP '2000-07-04 17:00:00', 'America/New_York', 'America/Los_Angeles');"],
];

const conversionQueries: Array<[string, string]> = [
  ['HEX_TO_BINARY', "SELECT HEX_TO_BINARY('DEADBEEF');"],
  ['HEX_TO_GEOMETRY', "SELECT HEX_TO_GEOMETRY('00');"],
  ['INT_TO_STRING', 'SELECT INT_TO_STRING(42, 16);'],
  ['STRING_TO_INT', "SELECT STRING_TO_INT('2A', 16);"],
  ['TO_CHAR', "SELECT TO_CHAR(DATE '2015-02-14', 'YYYY Month');"],
  ['TO_NUMBER', "SELECT TO_NUMBER('12,454.8-', '99G999D9S');"],
  ['TO_DATE', "SELECT TO_DATE('31 Dec 2015', 'DD Mon YYYY');"],
  ['TO_TIMESTAMP', "SELECT TO_TIMESTAMP('31 Dec 2015 08:38:40 pm', 'DD Mon YYYY HH:MI:SS am');"],
];

const miscellaneousQueries: Array<[string, string]> = [
  ['ISFALSE', 'SELECT ISFALSE(1 = 0);'],
  ['ISNOTFALSE', 'SELECT ISNOTFALSE(1 = 1);'],
  ['ISTRUE', 'SELECT ISTRUE(1 = 1);'],
  ['ISNOTTRUE', 'SELECT ISNOTTRUE(1 = 0);'],
  ['VERSION', 'SELECT VERSION();'],
  ['GET_VIEWDEF', "SELECT GET_VIEWDEF('EMP_VIEW');"],
  ['WIDTH_BUCKET', 'SELECT WIDTH_BUCKET(5, 0, 10, 5);'],
];

const regexpQueries: Array<[string, string]> = [
  ['REGEXP_REPLACE', "SELECT REGEXP_REPLACE('abc123', '[0-9]+', 'X');"],
  ['REGEXP_CAPTURE', "SELECT REGEXP_CAPTURE('foobar', '(f..)(b..)');"],
  ['REGEXP_COUNT', "SELECT REGEXP_COUNT('the quick brown fox', '[aeiou]');"],
  ['REGEXP_EXTRACT', "SELECT REGEXP_EXTRACT('How much food does a barbarian eat?', 'foo|bar');"],
  ['REGEXP_FIND', "SELECT REGEXP_FIND('abc123', '[0-9]+');"],
  ['REGEXP_GMATCH', "SELECT REGEXP_GMATCH('abc123def456', '[0-9]+');"],
  ['REGEXP_GSPLIT', "SELECT REGEXP_GSPLIT('a,b,c', ',');"],
  ['REGEXP_LIKE', "SELECT REGEXP_LIKE('abc123', '[0-9]+');"],
  ['REGEXP_SPLIT', "SELECT REGEXP_SPLIT('a,b,c', ',');"],
];

const stringUtilityQueries: Array<[string, string]> = [
  ['BASENAME', "SELECT BASENAME('/path/to/file.txt');"],
  ['DIRNAME', "SELECT DIRNAME('/path/to/file.txt');"],
  ['STRLEN', "SELECT STRLEN('hello');"],
  ['SPLIT', "SELECT SPLIT('a,b,c', ',');"],
  ['JOIN', "SELECT JOIN('a,b,c', ',');"],
  ['URLDECODE', "SELECT URLDECODE('hello%20world');"],
  ['URLENCODE', "SELECT URLENCODE('hello world');"],
  ['URLPARSEQUERY', "SELECT URLPARSEQUERY('key1=value1&key2=value2');"],
];

const fuzzyPhoneticQueries: Array<[string, string]> = [
  ['LE_DST', "SELECT LE_DST('two', 'tow');"],
  ['DLE_DST', "SELECT DLE_DST('two', 'tow');"],
  ['NYSIIS', "SELECT NYSIIS('Washington');"],
  ['DBL_MP', "SELECT DBL_MP('washington');"],
  ['PRI_MP', 'SELECT PRI_MP(781598358);'],
  ['SEC_MP', 'SELECT SEC_MP(781598358);'],
  ['SCORE_MP', 'SELECT SCORE_MP(781598358, 781596310, 1, 2, 3, 4);'],
];

describe('SqlLinterProvider function coverage', () => {
  let provider: SqlLinterProvider;

  beforeEach(() => {
    validateMock.mockReset();
    getInitializedSqlValidatorMock.mockReset();
    getSqlValidationContextMock.mockReset();
    validateMock.mockReturnValue({
      valid: true,
      errors: [],
      warnings: [],
      scope: { tables: new Map(), ctes: new Map(), level: 0 },
    });
    getInitializedSqlValidatorMock.mockReturnValue(undefined);
    getSqlValidationContextMock.mockReturnValue(undefined);
    provider = new SqlLinterProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  const allQueries = [
    ...binaryMathQueries,
    ...characterQueries,
    ...dateTimeQueries,
    ...conversionQueries,
    ...miscellaneousQueries,
    ...regexpQueries,
    ...stringUtilityQueries,
    ...fuzzyPhoneticQueries,
  ];

  it.each(allQueries)(
    'does not report parser diagnostics in quality-only lint for %s',
    async (_functionName, sql) => {
      const issues = await provider.lintSql(sql, {}, false, 'advanced');

      expect(validateMock).not.toHaveBeenCalled();
      expect(issues.some((issue) => issue.ruleId === 'SQL011')).toBe(false);
      expect(issues.some((issue) => issue.ruleId.startsWith('PAR'))).toBe(
        false,
      );
    },
  );
});