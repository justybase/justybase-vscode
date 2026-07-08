jest.unmock('chevrotain');

import { SqlLexer } from '../dialects/netezza/sql/lexer';

function tokenImages(sql: string): string[] {
  const result = SqlLexer.tokenize(sql);
  expect(result.errors).toEqual([]);
  return result.tokens.map((token) => token.image);
}

describe('Netezza SqlLexer comments', () => {
  it('skips nested block comments as one trivia region', () => {
    const images = tokenImages([
      '/* outer start',
      '   /* inner still comment */',
      'outer end */',
      'SELECT 1',
    ].join('\n'));

    expect(images).toEqual(['SELECT', '1']);
  });

  it('does not treat block comment markers inside strings or quoted identifiers as comments', () => {
    const images = tokenImages(
      'SELECT \'/* not comment */\', "*/not comment/*" FROM JUST_DATA..DIMACCOUNT',
    );

    expect(images).toContain("'/* not comment */'");
    expect(images).toContain('"*/not comment/*"');
    expect(images).toContain('JUST_DATA');
    expect(images).toContain('DIMACCOUNT');
  });
});
