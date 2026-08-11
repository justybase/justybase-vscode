import { createMigrationProgress } from '../migration/progress';

describe('createMigrationProgress', () => {
    it('marks a completed migration as 100% even without a row count', () => {
        expect(createMigrationProgress('done', 42, undefined, 'done', Date.now()).percent).toBe(100);
    });

    it('keeps indeterminate streaming progress at zero until completion', () => {
        expect(createMigrationProgress('stream', 42, undefined, 'streaming', Date.now()).percent).toBe(0);
    });
});
