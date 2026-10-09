/**
 * Netezza quick-fix policy shared by the VS Code extension provider and the
 * LSP code-action handler: titles, safety classification and Fix All
 * eligibility. Kept free of the vscode API so the language server and the
 * conformance adapter can use the same policy as the extension.
 */
import { EQUALS_NULL_QUICK_FIX, UPDATE_ALIAS_AS_QUICK_FIX } from './netezzaQuickFixes';

export type QuickFixSafety = 'safe' | 'review-required' | 'unsafe';

export interface QuickFixMatrixEntry {
    code: string;
    title: string;
    safety: QuickFixSafety;
    fixAllEligible: boolean;
    rationale: string;
}

/**
 * Error code to quick fix mapping
 */
export const ERROR_CODE_ACTIONS: Record<string, { title: string; fix: string }> = {
    'SQL007': {
        title: "Convert to DB..TABLE format (Netezza syntax)",
        fix: '..'
    },
    'SQL012': {
        title: "Add VARCHAR length (e.g., VARCHAR(100))",
        fix: '(100)'
    },
    'SQL004': {
        title: 'Use suggested column name',
        fix: ''
    },
    'PAR101': {
        title: 'Insert missing AS in CTE definition',
        fix: ' AS '
    },
    'NZ002': {
        title: 'Add safe WHERE guard (WHERE 1 = 0)',
        fix: ' WHERE 1 = 0'
    },
    'SQL043': {
        title: 'Add safe WHERE guard (WHERE 1 = 0)',
        fix: ' WHERE 1 = 0'
    },
    'NZ003': {
        title: 'Add safe WHERE guard (WHERE 1 = 0)',
        fix: ' WHERE 1 = 0'
    },
    'SQL044': {
        title: 'Add safe WHERE guard (WHERE 1 = 0)',
        fix: ' WHERE 1 = 0'
    },
    'NZ006': {
        title: 'Add FETCH FIRST 100 ROWS ONLY',
        fix: ' FETCH FIRST 100 ROWS ONLY'
    },
    'NZ007': {
        title: 'Normalize keyword casing',
        fix: ''
    },
    'NZ001': {
        title: 'Expand SELECT * to explicit columns',
        fix: ''
    },
    'NZ004': {
        title: 'Replace CROSS JOIN with explicit INNER JOIN',
        fix: 'INNER JOIN'
    },
    'SQL008': {
        title: 'Qualify ambiguous column',
        fix: ''
    },
    'SQL048': {
        title: 'Qualify table name',
        fix: ''
    },
    'NZ010': {
        title: 'Add missing table alias',
        fix: ''
    },
    'NZ012': {
        title: 'Remove AS in UPDATE alias',
        fix: ''
    },
    'SQL046': {
        title: UPDATE_ALIAS_AS_QUICK_FIX.title,
        fix: ''
    },
    'NZL006': {
        title: EQUALS_NULL_QUICK_FIX.title,
        fix: EQUALS_NULL_QUICK_FIX.newText
    },
    'NZ013': {
        title: 'Replace UNION with UNION ALL',
        fix: 'UNION ALL'
    },
    'NZP012': {
        title: 'Replace ELSEIF/ELSE IF with ELSIF',
        fix: 'ELSIF'
    },
    'SQL018': {
        title: 'Remove unused CTE',
        fix: ''
    },
    'SQL019': {
        title: 'Remove unused table alias',
        fix: ''
    },
    'SQL020': {
        title: 'Add subquery alias',
        fix: ''
    },
    'NZ021': {
        title: 'Remove extra comma (,, → ,)',
        fix: ','
    },
    'PAR002': {
        title: 'Remove extra comma (,, → ,)',
        fix: ','
    }
};

export const QUICK_FIX_MATRIX: Record<string, QuickFixMatrixEntry> = {
    SQL007: {
        code: 'SQL007',
        title: ERROR_CODE_ACTIONS.SQL007.title,
        safety: 'safe',
        fixAllEligible: true,
        rationale: 'Deterministic syntax normalization DB.TABLE -> DB..TABLE.'
    },
    SQL004: {
        code: 'SQL004',
        title: ERROR_CODE_ACTIONS.SQL004.title,
        safety: 'safe',
        fixAllEligible: false,
        rationale: 'Uses the single visible-column suggestion carried by the diagnostic.'
    },
    SQL051: {
        code: 'SQL051',
        title: ERROR_CODE_ACTIONS.NZ004.title,
        safety: 'review-required',
        fixAllEligible: false,
        rationale: 'The replacement supplies only a tautological predicate; review the intended join semantics.'
    },
    SQL052: {
        code: 'SQL052',
        title: ERROR_CODE_ACTIONS.NZ010.title,
        safety: 'review-required',
        fixAllEligible: false,
        rationale: 'Alias insertion also rewrites visible table references and is offered only for an unambiguous JOIN.'
    },
    SQL053: {
        code: 'SQL053',
        title: 'Review JOIN literal type',
        safety: 'unsafe',
        fixAllEligible: false,
        rationale: 'The correct typed value or CAST target cannot be inferred safely while typing.'
    },
    SQL012: {
        code: 'SQL012',
        title: ERROR_CODE_ACTIONS.SQL012.title,
        safety: 'safe',
        fixAllEligible: true,
        rationale: 'Deterministic parser-compliance rewrite for VARCHAR length.'
    },
    PAR101: {
        code: 'PAR101',
        title: ERROR_CODE_ACTIONS.PAR101.title,
        safety: 'safe',
        fixAllEligible: true,
        rationale: 'Deterministic insertion of the required AS keyword in a CTE definition.'
    },
    PAR002: {
        code: 'PAR002',
        title: ERROR_CODE_ACTIONS.PAR002.title,
        safety: 'safe',
        fixAllEligible: true,
        rationale: 'Removes a duplicated comma; deterministic parser-compliance rewrite.'
    },
    PAR004: {
        code: 'PAR004',
        title: 'Fix keyword typo',
        safety: 'safe',
        fixAllEligible: false,
        rationale: 'Replaces a recognized keyword typo with the parser-provided intended keyword.'
    },
    NZ001: {
        code: 'NZ001',
        title: ERROR_CODE_ACTIONS.NZ001.title,
        safety: 'review-required',
        fixAllEligible: false,
        rationale: 'Expands projection and can alter query shape/intent.'
    },
    NZ002: {
        code: 'NZ002',
        title: ERROR_CODE_ACTIONS.NZ002.title,
        safety: 'review-required',
        fixAllEligible: false,
        rationale: 'Adds guard clause and intentionally changes DML behavior.'
    },
    NZ003: {
        code: 'NZ003',
        title: ERROR_CODE_ACTIONS.NZ003.title,
        safety: 'review-required',
        fixAllEligible: false,
        rationale: 'Adds guard clause and intentionally changes DML behavior.'
    },
    SQL043: {
        code: 'SQL043',
        title: ERROR_CODE_ACTIONS.SQL043.title,
        safety: 'review-required',
        fixAllEligible: false,
        rationale: 'Adds guard clause and intentionally changes DML behavior.'
    },
    SQL044: {
        code: 'SQL044',
        title: ERROR_CODE_ACTIONS.SQL044.title,
        safety: 'review-required',
        fixAllEligible: false,
        rationale: 'Adds guard clause and intentionally changes DML behavior.'
    },
    NZ004: {
        code: 'NZ004',
        title: ERROR_CODE_ACTIONS.NZ004.title,
        safety: 'review-required',
        fixAllEligible: false,
        rationale: 'Makes Cartesian semantics explicit with a tautological predicate; review intent and result cardinality.'
    },
    NZ006: {
        code: 'NZ006',
        title: ERROR_CODE_ACTIONS.NZ006.title,
        safety: 'review-required',
        fixAllEligible: false,
        rationale: 'Adds row limiting semantics and may change expected result set size.'
    },
    NZ007: {
        code: 'NZ007',
        title: ERROR_CODE_ACTIONS.NZ007.title,
        safety: 'safe',
        fixAllEligible: true,
        rationale: 'Deterministic keyword normalization based on linter-selected dominant case.'
    },
    NZ010: {
        code: 'NZ010',
        title: ERROR_CODE_ACTIONS.NZ010.title,
        safety: 'review-required',
        fixAllEligible: false,
        rationale: 'Generated alias can affect readability and downstream references.'
    },
    NZ011: {
        code: 'NZ011',
        title: 'Add DISTRIBUTE ON RANDOM',
        safety: 'review-required',
        fixAllEligible: false,
        rationale: 'Physical design decision should be reviewed per workload.'
    },
    NZ012: {
        code: 'NZ012',
        title: ERROR_CODE_ACTIONS.NZ012.title,
        safety: 'safe',
        fixAllEligible: true,
        rationale: 'Netezza syntax normalization; removes unsupported AS keyword.'
    },
    SQL045: {
        code: 'SQL045',
        title: 'Add DISTRIBUTE ON RANDOM',
        safety: 'review-required',
        fixAllEligible: false,
        rationale: 'Physical design decision should be reviewed per workload.'
    },
    SQL046: {
        code: 'SQL046',
        title: UPDATE_ALIAS_AS_QUICK_FIX.title,
        safety: UPDATE_ALIAS_AS_QUICK_FIX.safety,
        fixAllEligible: UPDATE_ALIAS_AS_QUICK_FIX.fixAllEligible,
        rationale: 'Netezza syntax normalization; removes unsupported AS keyword.'
    },
    NZL006: {
        code: 'NZL006',
        title: EQUALS_NULL_QUICK_FIX.title,
        safety: EQUALS_NULL_QUICK_FIX.safety,
        fixAllEligible: EQUALS_NULL_QUICK_FIX.fixAllEligible,
        rationale: 'Deterministic rewrite of an equality-to-NULL predicate as IS NULL.'
    },
    NZ013: {
        code: 'NZ013',
        title: ERROR_CODE_ACTIONS.NZ013.title,
        safety: 'review-required',
        fixAllEligible: false,
        rationale: 'UNION -> UNION ALL can change duplicate-handling semantics.'
    },
    NZP012: {
        code: 'NZP012',
        title: ERROR_CODE_ACTIONS.NZP012.title,
        safety: 'safe',
        fixAllEligible: true,
        rationale: 'Deterministic NZPLSQL syntax normalization ELSEIF/ELSE IF -> ELSIF.'
    },
    SQL008: {
        code: 'SQL008',
        title: ERROR_CODE_ACTIONS.SQL008.title,
        safety: 'review-required',
        fixAllEligible: false,
        rationale: 'Requires user choice between multiple qualifiers.'
    },
    SQL048: {
        code: 'SQL048',
        title: ERROR_CODE_ACTIONS.SQL048.title,
        safety: 'safe',
        fixAllEligible: false,
        rationale: 'Uses metadata-backed DB.SCHEMA.TABLE qualification.'
    },
    SQL018: {
        code: 'SQL018',
        title: ERROR_CODE_ACTIONS.SQL018.title,
        safety: 'unsafe',
        fixAllEligible: false,
        rationale: 'Automated CTE removal can break dependent expressions.'
    },
    SQL019: {
        code: 'SQL019',
        title: ERROR_CODE_ACTIONS.SQL019.title,
        safety: 'unsafe',
        fixAllEligible: false,
        rationale: 'Alias removal can change query behavior or readability.'
    },
    SQL020: {
        code: 'SQL020',
        title: ERROR_CODE_ACTIONS.SQL020.title,
        safety: 'review-required',
        fixAllEligible: false,
        rationale: 'Alias naming requires context and naming convention review.'
    },
    NZ021: {
        code: 'NZ021',
        title: ERROR_CODE_ACTIONS.NZ021.title,
        safety: 'safe',
        fixAllEligible: true,
        rationale: 'Deterministic removal of extra comma in comma-separated list.'
    }
};

/**
 * Shared SQL conformance Fix All contract: only deterministic, meaning-preserving
 * Safe fixes are eligible. Suggestion fixes (PAR004, SQL048) and NZL006 stay
 * explicit-only; review-required fixes are never eligible.
 */
export const SAFE_FIX_ALL_CODES = new Set(
    Object.values(QUICK_FIX_MATRIX)
        .filter(entry => entry.fixAllEligible)
        .map(entry => entry.code)
);

export function getNetezzaQuickFixSafety(code: string): QuickFixSafety | undefined {
    return QUICK_FIX_MATRIX[code]?.safety;
}

/** Whether Fix All Safe may apply the quick fix for `code`. */
export function isNetezzaFixAllEligible(code: string): boolean {
    return SAFE_FIX_ALL_CODES.has(code);
}

/** Codes whose quick fixes are served by the language server, not the extension. */
export const LSP_SERVED_CODES = new Set([
    'SQL004', 'SQL007', 'SQL012', 'SQL019', 'SQL048', 'SQL051', 'SQL052', 'SQL053',
    'PAR003', 'PAR004'
]);
