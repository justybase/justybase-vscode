import type { IRecognitionException, IToken } from 'chevrotain';

/**
 * Token types that serve as recovery boundaries for trailing dot parser errors.
 * When a trailing dot is encountered (e.g., "table."), the parser can recover
 * if the next token is one of these boundary tokens.
 */
export const TRAILING_DOT_RECOVERY_BOUNDARY_TOKENS = new Set<string>([
    'EOF',
    'Semicolon',
    'Comma',
    'RParen',
    'From',
    'Where',
    'Group',
    'Having',
    'Order',
    'Limit',
    'Union',
    'Intersect',
    'Except',
    'MinusSet',
    'Join',
    'On',
    'And',
    'Or'
]);

/**
 * Determines if a parser error is an ignorable trailing dot error.
 * 
 * Trailing dot errors occur when the user types a dot at the end of an identifier
 * (e.g., "table.") and then triggers autocomplete. These errors are recoverable
 * and should not block parsing for completion purposes.
 * 
 * @param error - The parser exception to check
 * @returns true if the error is an ignorable trailing dot error
 */
export function isIgnorableTrailingDotParserError(error: IRecognitionException): boolean {
    const parserError = error as IRecognitionException & { previousToken?: IToken };
    if (parserError.previousToken?.tokenType.name !== 'Dot') {
        return false;
    }

    const tokenName = error.token?.tokenType?.name;
    return !!tokenName && TRAILING_DOT_RECOVERY_BOUNDARY_TOKENS.has(tokenName);
}
