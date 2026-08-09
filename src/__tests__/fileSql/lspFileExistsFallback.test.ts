import { __TEST_ONLY_resolveExistsFallback } from '../../activation/lspRegistration';

describe('LSP table-exists fallback for File SQL', () => {
    it('treats negative cache entries as unknown for file connections', () => {
        expect(__TEST_ONLY_resolveExistsFallback(false, 'file')).toBe(true);
    });

    it('keeps positive and unknown entries unchanged', () => {
        expect(__TEST_ONLY_resolveExistsFallback(true, 'file')).toBe(true);
        expect(__TEST_ONLY_resolveExistsFallback(undefined, 'file')).toBe(true);
    });

    it('keeps negative entries for other dialects', () => {
        expect(__TEST_ONLY_resolveExistsFallback(false, 'netezza')).toBe(false);
        expect(__TEST_ONLY_resolveExistsFallback(false, 'duckdb')).toBe(false);
        expect(__TEST_ONLY_resolveExistsFallback(false, undefined)).toBe(false);
    });
});
