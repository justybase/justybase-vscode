import { describeQueryError, ensureQueryErrorMessage } from '../core/errorPresentation';

describe('errorPresentation', () => {
    it('preserves a normal driver message', () => {
        expect(describeQueryError(new Error('connect ECONNREFUSED 127.0.0.1:5480'))).toBe(
            'connect ECONNREFUSED 127.0.0.1:5480',
        );
    });

    it('never returns an empty message for an empty Error', () => {
        expect(describeQueryError(new Error(''))).toBe('Query execution failed.');
        expect(describeQueryError(new Error('   '))).toBe('Query execution failed.');
    });

    it('uses the stable error code when no text is available', () => {
        expect(describeQueryError({ message: '', code: 'ECONNREFUSED' })).toBe(
            'Query execution failed. (ECONNREFUSED)',
        );
    });

    it('walks the cause chain without duplicating wrapper text', () => {
        const error = new Error('connect ECONNREFUSED 127.0.0.1:5480');
        const wrapped = new Error('Error (after reconnect attempt): connect ECONNREFUSED 127.0.0.1:5480', {
            cause: error,
        });
        expect(describeQueryError(wrapped)).toBe(
            'Error (after reconnect attempt): connect ECONNREFUSED 127.0.0.1:5480',
        );
    });

    it('explains a thrown non-Error value', () => {
        expect(describeQueryError('plain string failure')).toBe('plain string failure');
        expect(describeQueryError(undefined)).toBe('Query execution failed.');
    });

    it('keeps a non-blank message and replaces a blank one', () => {
        expect(ensureQueryErrorMessage('Table not found')).toBe('Table not found');
        expect(ensureQueryErrorMessage('', new Error('ECONNREFUSED'))).toBe('ECONNREFUSED');
        expect(ensureQueryErrorMessage(undefined, new Error(''))).toBe('Query execution failed.');
    });
});
