import {
    BASE_SQL_FUNCTION_SIGNATURES,
    mergeFunctionSignatures
} from '../../../sql/authoring/baseProfiles';
import type { DatabaseSqlFunctionSignature } from '../../../sql/authoring/types';

const NETEZZA_FUNCTION_SIGNATURE_OVERLAYS: ReadonlyMap<string, readonly DatabaseSqlFunctionSignature[]> = new Map([
    ['NVL', [
        {
            name: 'NVL',
            parameters: ['value', 'replacement'],
            description: 'Returns the first argument when it is not NULL; otherwise returns the second argument.',
            example: "SELECT nvl(hire_date, current_date) FROM employees;"
        }
    ]],
    ['NVL2', [
        {
            name: 'NVL2',
            parameters: ['value', 'if_not_null', 'if_null'],
            description: 'Returns the second argument when the first is not NULL; otherwise returns the third argument.',
            example: 'SELECT nvl2(1, 2, 3); -- returns 2'
        }
    ]],
    ['DECODE', [
        {
            name: 'DECODE',
            parameters: ['expression', 'search1', 'result1', '...', 'default'],
            description: 'Compares expression to search values and returns the matching result, or default when no match is found.',
            example: "SELECT color_id,\n  decode(color_id, 1000, 'red', 1001, 'blue', 1002, 'yellow', 'none') AS color_name\nFROM colors;"
        }
    ]],
    ['TO_CHAR', [
        {
            name: 'TO_CHAR',
            parameters: ['value', 'format'],
            description: 'Format as string and cast to integer (Netezza :: cast syntax).',
            example: "SELECT TO_CHAR(CURRENT_DATE, 'YYYYMMDD')::INT;"
        }
    ]],
    ['GROUP_CONCAT', [
        { name: 'GROUP_CONCAT', parameters: ['expression'], description: 'Concatenate group values with comma separator' },
        { name: 'GROUP_CONCAT', parameters: ['DISTINCT expression'], description: 'Concatenate distinct group values' },
        { name: 'GROUP_CONCAT', parameters: ['expression SEPARATOR delimiter'], description: 'Concatenate group values with custom separator' }
    ]],
    ['GROUP_CONCAT_SORT', [
        { name: 'GROUP_CONCAT_SORT', parameters: ['expression'], description: 'Concatenate group values sorted alphabetically' },
        { name: 'GROUP_CONCAT_SORT', parameters: ['expression SEPARATOR delimiter'], description: 'Concatenate sorted group values with custom separator' },
        { name: 'GROUP_CONCAT_SORT', parameters: ['expression ORDER BY sort_expr'], description: 'Concatenate group values sorted by expression' }
    ]],
    ['PERCENTILE_CONT', [
        {
            name: 'PERCENTILE_CONT',
            parameters: ['fraction WITHIN GROUP (ORDER BY sort_expr)'],
            description: 'Continuous inverse distribution (interpolated percentile).',
            example: "SELECT grp, percentile_cont(0.4) WITHIN GROUP (ORDER BY sal) AS fortieth\nFROM pctest GROUP BY grp;"
        }
    ]],
    ['PERCENTILE_DISC', [
        {
            name: 'PERCENTILE_DISC',
            parameters: ['fraction WITHIN GROUP (ORDER BY sort_expr)'],
            description: 'Discrete inverse distribution (actual percentile value).',
            example: "SELECT grp, percentile_disc(0.4) WITHIN GROUP (ORDER BY sal) AS fortieth\nFROM pctest GROUP BY grp;"
        }
    ]],
    ['LE_DST', [
        {
            name: 'LE_DST',
            parameters: ['string1', 'string2'],
            description: 'Levenshtein edit distance between two strings. Returns 0 when strings are equivalent. Comparisons are case-sensitive.',
            example: "SELECT le_dst('sow', 'show'); -- returns 1\nSELECT le_dst('two', 'tow'); -- returns 2"
        }
    ]],
    ['DLE_DST', [
        {
            name: 'DLE_DST',
            parameters: ['string1', 'string2'],
            description: 'Damerau-Levenshtein edit distance. Like le_dst, but neighboring character transpositions count as one edit.',
            example: "SELECT dle_dst('two', 'tow'); -- returns 1"
        }
    ]],
    ['NYSIIS', [
        {
            name: 'NYSIIS',
            parameters: ['string'],
            description: 'Soundex NYSIIS phonetic encoding (up to 6 characters). Not case-sensitive.',
            example: "SELECT nysiis('Washington'); -- returns 'wasang'"
        }
    ]],
    ['DBL_MP', [
        {
            name: 'DBL_MP',
            parameters: ['string'],
            description: 'Double Metaphone composite 32-bit phonetic key (primary and secondary keys packed into int4).',
            example: "SELECT dbl_mp('washington'); -- returns 781598358"
        }
    ]],
    ['PRI_MP', [
        {
            name: 'PRI_MP',
            parameters: ['dbl_mp_value'],
            description: 'Extracts the four-character primary Double Metaphone key from a dbl_mp() result.',
            example: "SELECT pri_mp(781598358); -- returns 'AXNK'"
        }
    ]],
    ['SEC_MP', [
        {
            name: 'SEC_MP',
            parameters: ['dbl_mp_value'],
            description: 'Extracts the four-character secondary Double Metaphone key from a dbl_mp() result.',
            example: "SELECT sec_mp(781598358); -- returns 'FXNK'"
        }
    ]],
    ['SCORE_MP', [
        {
            name: 'SCORE_MP',
            parameters: ['dbl_mp_value1', 'dbl_mp_value2', 'strong_match', 'normal_match', 'minor_match', 'no_match'],
            description: 'Compares two Double Metaphone keys and returns a score based on match strength.',
            example: 'SELECT score_mp(781598358, 781596310, 1, 2, 3, 4); -- strongest match returns 1'
        }
    ]]
]);

export const NETEZZA_FUNCTION_SIGNATURES = mergeFunctionSignatures(
    BASE_SQL_FUNCTION_SIGNATURES,
    NETEZZA_FUNCTION_SIGNATURE_OVERLAYS
);
