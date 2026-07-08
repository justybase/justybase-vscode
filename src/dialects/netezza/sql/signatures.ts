import {
    BASE_SQL_FUNCTION_SIGNATURES,
    mergeFunctionSignatures
} from '../../../sql/authoring/baseProfiles';
import type { DatabaseSqlFunctionSignature } from '../../../sql/authoring/types';

const NETEZZA_FUNCTION_SIGNATURE_OVERLAYS: ReadonlyMap<string, readonly DatabaseSqlFunctionSignature[]> = new Map([
    ['NVL', [
        { name: 'NVL', parameters: ['value', 'replacement'], description: 'Replace NULL with value' }
    ]],
    ['NVL2', [
        { name: 'NVL2', parameters: ['value', 'if_not_null', 'if_null'], description: 'Conditional NULL replacement' }
    ]],
    ['DECODE', [
        { name: 'DECODE', parameters: ['expression', 'search1', 'result1', '...', 'default'], description: 'Conditional expression' }
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
    ]]
]);

export const NETEZZA_FUNCTION_SIGNATURES = mergeFunctionSignatures(
    BASE_SQL_FUNCTION_SIGNATURES,
    NETEZZA_FUNCTION_SIGNATURE_OVERLAYS
);
