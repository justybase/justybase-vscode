import {
    DATABASE_USAGE_STATE_KEY,
    DatabaseUsageHistory,
    MAX_POPULAR_DATABASE_COUNT,
    normalizeDatabaseUsageKey,
} from '../../metadata/databaseUsageHistory';

class FakeMemento {
    public readonly values = new Map<string, unknown>();

    get<T>(key: string): T | undefined {
        return this.values.get(key) as T | undefined;
    }

    async update(key: string, value: unknown): Promise<void> {
        this.values.set(key, value);
    }
}

describe('DatabaseUsageHistory', () => {
    it('ranks databases by use count and recency', () => {
        let now = 1_000;
        const history = new DatabaseUsageHistory(new FakeMemento(), () => now);

        history.record('CONN', 'STAGING');
        now += 10;
        history.record('CONN', 'PROD');
        now += 10;
        history.record('CONN', 'PROD');
        now += 10;
        history.record('CONN', 'ARCHIVE');

        expect(history.getPopular('CONN', 2)).toEqual(['PROD', 'ARCHIVE']);
        expect(normalizeDatabaseUsageKey('  prod  ')).toBe('PROD');
    });

    it('bounds the popular limit and exposes usage records', () => {
        const history = new DatabaseUsageHistory(new FakeMemento());
        for (let index = 0; index < MAX_POPULAR_DATABASE_COUNT + 2; index += 1) {
            history.record('CONN', `DB_${index}`);
        }

        expect(history.getPopular('CONN', 100)).toHaveLength(MAX_POPULAR_DATABASE_COUNT);
        expect(history.getPopular('CONN', 0)).toEqual([]);
        expect(history.getUsage('CONN')).toHaveLength(MAX_POPULAR_DATABASE_COUNT + 2);
    });

    it('seeds from query history without requiring SQL text', () => {
        const history = new DatabaseUsageHistory(new FakeMemento());
        const added = history.seed([
            { database: 'PROD', connectionName: 'CONN', timestamp: 10 },
            { database: 'prod', connectionName: 'CONN', timestamp: 20 },
            { database: 'STAGING', connectionName: 'CONN', timestamp: 5 },
            { database: '', connectionName: 'CONN', timestamp: 30 },
            { database: 'IGNORED', connectionName: undefined, timestamp: 30 },
        ]);

        expect(added).toBe(3);
        expect(history.getPopular('CONN', 2)).toEqual(['PROD', 'STAGING']);
    });

    it('prunes old databases and caps the per-connection store', () => {
        let now = 0;
        const history = new DatabaseUsageHistory(new FakeMemento(), () => now);
        history.record('CONN', 'OLD');
        now += 31 * 24 * 60 * 60 * 1000;
        history.record('CONN', 'NEW');

        history.prune(30);
        expect(history.getPopular('CONN', 5)).toEqual(['NEW']);
    });

    it('ignores corrupt persisted state', () => {
        const memento = new FakeMemento();
        memento.values.set(DATABASE_USAGE_STATE_KEY, {
            version: 1,
            connections: {
                CONN: {
                    GOOD: { database: 'GOOD', count: 2, lastUsedAt: 1 },
                    BAD_COUNT: { database: 'BAD_COUNT', count: -1, lastUsedAt: 1 },
                    BAD_TIME: { database: 'BAD_TIME', count: 1, lastUsedAt: 'nope' },
                },
            },
        });

        const history = new DatabaseUsageHistory(memento);
        expect(history.getPopular('CONN', 5)).toEqual(['GOOD']);
    });

    it('persists the state on flush', async () => {
        const memento = new FakeMemento();
        const history = new DatabaseUsageHistory(memento);
        history.record('CONN', 'PROD');
        await history.flush();

        const stored = memento.values.get(DATABASE_USAGE_STATE_KEY) as {
            connections: Record<string, Record<string, { count: number }>>;
        };
        expect(stored.connections.CONN.PROD.count).toBe(1);
    });
});
