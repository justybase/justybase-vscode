import type { DatabaseImportWizardAdapter } from '../import/wizard/adapters/DatabaseImportWizardAdapter';
import { BackgroundValidationService } from '../import/wizard/BackgroundValidationService';
import type {
    BackgroundValidationProgress,
    ImportWizardColumn,
    ImportWizardValidationSummary,
} from '../import/wizard/ImportWizardState';
import type { TabularDataImporter } from '../import/tabularDataImporter';

interface ValidationEvent {
    progress: BackgroundValidationProgress;
    summary?: ImportWizardValidationSummary;
}

interface ValidationOutcome {
    events: ValidationEvent[];
    terminalPhase: BackgroundValidationProgress['phase'];
    summary?: ImportWizardValidationSummary;
}

function createDeferred<T>(): {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
} {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((innerResolve, innerReject) => {
        resolve = innerResolve;
        reject = innerReject;
    });
    return { promise, resolve, reject };
}

function flushPromises(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

function createColumn(overrides: Partial<ImportWizardColumn> = {}): ImportWizardColumn {
    return {
        sourceIndex: 0,
        sourceName: 'col1',
        targetName: 'col1',
        defaultTargetName: 'col1',
        included: true,
        order: 0,
        inferredType: 'VARCHAR(255)',
        selectedType: 'VARCHAR(255)',
        overrideMode: 'inferred',
        ...overrides,
    };
}

function createAdapter(typeIssueMessages: string[] = []): jest.Mocked<DatabaseImportWizardAdapter> {
    return {
        kind: 'netezza',
        normalizeTargetColumnName: jest.fn(name => name.trim()),
        getSupportedTypeOptions: jest.fn(() => ['INTEGER', 'NUMERIC(18,2)', 'DATE', 'TIMESTAMP', 'BOOLEAN', 'VARCHAR(255)']),
        mapInferredType: jest.fn(typeName => typeName),
        validateTypeOverride: jest.fn((_typeName: string) =>
            typeIssueMessages.map(message => ({
                severity: 'warning' as const,
                message,
            })),
        ),
        buildCreateTableSql: jest.fn((_input) => 'CREATE TABLE sample(id INTEGER);'),
        buildExecutionPlan: jest.fn((_input) => ({
            mode: 'direct',
            createTableSql: 'CREATE TABLE sample(id INTEGER);',
            warnings: [],
        })),
        getExecutionMode: jest.fn(() => 'direct'),
    };
}

function createImporter(rows: string[][] | Promise<string[][]>): jest.Mocked<TabularDataImporter> {
    return {
        getSampleRows: jest.fn(() => rows),
    } as unknown as jest.Mocked<TabularDataImporter>;
}

function startValidation(
    service: BackgroundValidationService,
    options: {
        sessionId?: string;
        columns?: ImportWizardColumn[];
        importer: jest.Mocked<TabularDataImporter>;
        adapter?: jest.Mocked<DatabaseImportWizardAdapter>;
        sampleSize?: number;
    },
): Promise<ValidationOutcome> {
    const sessionId = options.sessionId ?? 'test-session';
    const events: ValidationEvent[] = [];

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Timed out waiting for validation outcome for session ${sessionId}.`));
        }, 2000);

        service.startValidation({
            sessionId,
            columns: options.columns ?? [createColumn()],
            importer: options.importer,
            adapter: options.adapter ?? createAdapter(),
            sampleSize: options.sampleSize ?? 10,
            progressCallback: (progress, summary) => {
                events.push({ progress, summary });

                if (progress.phase === 'complete' && summary) {
                    clearTimeout(timeout);
                    resolve({
                        events,
                        terminalPhase: 'complete',
                        summary,
                    });
                }

                if (progress.phase === 'cancelled') {
                    clearTimeout(timeout);
                    resolve({
                        events,
                        terminalPhase: 'cancelled',
                    });
                }
            },
        });
    });
}

describe('BackgroundValidationService', () => {
    let service: BackgroundValidationService;

    beforeEach(() => {
        service = new BackgroundValidationService();
    });

    it('accepts normalized date inputs across ISO and local formats', async () => {
        const outcome = await startValidation(service, {
            columns: [createColumn({ selectedType: 'DATE' })],
            importer: createImporter([
                ['2024-03-26'],
                ['26.3.2024'],
                ['07/04/2024'],
            ]),
        });

        expect(outcome.summary?.hasErrors).toBe(false);
        expect(outcome.summary?.issues).toEqual([]);
    });

    it('rejects impossible dates after normalization', async () => {
        const outcome = await startValidation(service, {
            columns: [createColumn({ selectedType: 'DATE' })],
            importer: createImporter([['2024-02-30']]),
        });

        expect(outcome.summary?.issues).toEqual([
            expect.objectContaining({
                rowIndex: 0,
                message: 'Expected a valid date value.',
                value: '2024-02-30',
            }),
        ]);
        expect(outcome.summary?.hasErrors).toBe(true);
    });

    it('accepts timestamp variants with T separators and local dates', async () => {
        const outcome = await startValidation(service, {
            columns: [createColumn({ selectedType: 'TIMESTAMP_NTZ' })],
            importer: createImporter([
                ['2024-03-26T14:30:00'],
                ['26.03.2024 9:5'],
                ['2024-03-26 22'],
            ]),
        });

        expect(outcome.summary?.hasErrors).toBe(false);
        expect(outcome.summary?.issues).toEqual([]);
    });

    it('rejects invalid timestamp values', async () => {
        const outcome = await startValidation(service, {
            columns: [createColumn({ selectedType: 'DATETIME2' })],
            importer: createImporter([['not-a-timestamp']]),
        });

        expect(outcome.summary?.issues[0]).toEqual(
            expect.objectContaining({
                message: 'Expected a valid timestamp value.',
            }),
        );
    });

    it('validates integers, decimals with comma separators, and booleans', async () => {
        const outcome = await startValidation(service, {
            columns: [
                createColumn({ sourceIndex: 0, selectedType: 'INTEGER', targetName: 'id' }),
                createColumn({ sourceIndex: 1, selectedType: 'NUMERIC(18,2)', targetName: 'amount' }),
                createColumn({ sourceIndex: 2, selectedType: 'BOOLEAN', targetName: 'enabled' }),
            ],
            importer: createImporter([
                ['42', '123,45', 'yes'],
                ['-10', '-0.50', '0'],
            ]),
        });

        expect(outcome.summary?.hasErrors).toBe(false);
        expect(outcome.summary?.issues).toEqual([]);
    });

    it('ignores blank values and unsupported types without raising cell errors', async () => {
        const outcome = await startValidation(service, {
            columns: [
                createColumn({ sourceIndex: 0, selectedType: 'INTEGER', targetName: 'id' }),
                createColumn({ sourceIndex: 1, selectedType: 'GEOGRAPHY', targetName: 'shape' }),
            ],
            importer: createImporter([['   ', 'POINT(0 0)']]),
        });

        expect(outcome.summary?.hasErrors).toBe(false);
        expect(outcome.summary?.issues).toEqual([]);
    });

    it('collects adapter warnings and duplicate target-name errors during column validation', async () => {
        const adapter = createAdapter(['Use a narrower type for this column.']);
        const outcome = await startValidation(service, {
            columns: [
                createColumn({ sourceIndex: 0, targetName: 'id', selectedType: 'INTEGER' }),
                createColumn({ sourceIndex: 1, targetName: 'ID', selectedType: 'INTEGER' }),
            ],
            importer: createImporter([]),
            adapter,
        });

        expect(outcome.summary?.warnings).toEqual(
            expect.arrayContaining([
                'id: Use a narrower type for this column.',
                'Duplicate target column name detected: ID.',
            ]),
        );
        expect(outcome.summary?.hasErrors).toBe(true);
    });

    it('validates included columns independently and skips excluded columns', async () => {
        const outcome = await startValidation(service, {
            columns: [
                createColumn({ sourceIndex: 0, selectedType: 'INTEGER', targetName: 'id' }),
                createColumn({ sourceIndex: 1, selectedType: 'DATE', targetName: 'created_at' }),
                createColumn({ sourceIndex: 2, selectedType: 'INTEGER', included: false, targetName: 'ignored_value' }),
            ],
            importer: createImporter([
                ['7', '2024-03-26', 'bad-number'],
                ['oops', 'not-a-date', 'still-ignored'],
            ]),
        });

        expect(outcome.summary?.issues).toHaveLength(2);
        expect(outcome.summary?.issues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ rowIndex: 1, columnIndex: 0, message: 'Expected an integer value.' }),
                expect.objectContaining({ rowIndex: 1, columnIndex: 1, message: 'Expected a valid date value.' }),
            ]),
        );
    });

    it('reports reading status while sample rows are still loading', async () => {
        const deferredRows = createDeferred<string[][]>();
        const importer = createImporter(deferredRows.promise);
        const outcomePromise = startValidation(service, {
            importer,
            sessionId: 'reading-session',
            sampleSize: 25,
        });

        await flushPromises();

        expect(service.isValidationActive('reading-session')).toBe(true);
        expect(service.getStatus('reading-session')).toEqual(
            expect.objectContaining({
                isActive: true,
                progress: expect.objectContaining({
                    phase: 'reading',
                    rowsProcessed: 0,
                    totalRows: 25,
                    issuesFound: 0,
                }),
            }),
        );

        deferredRows.resolve([]);
        const outcome = await outcomePromise;
        expect(outcome.terminalPhase).toBe('complete');
    });

    it('tracks validation phases and final progress counts', async () => {
        const outcome = await startValidation(service, {
            columns: [createColumn({ selectedType: 'INTEGER' })],
            importer: createImporter([['1'], ['bad-value']]),
        });

        expect(outcome.events.map(event => event.progress.phase)).toEqual(['reading', 'validating', 'complete']);
        expect(outcome.events[outcome.events.length - 1]?.progress).toEqual(
            expect.objectContaining({
                phase: 'complete',
                rowsProcessed: 2,
                totalRows: 2,
                issuesFound: 1,
            }),
        );
    });

    it('cancels in-flight validation and marks the session inactive', async () => {
        const deferredRows = createDeferred<string[][]>();
        const outcomePromise = startValidation(service, {
            importer: createImporter(deferredRows.promise),
            sessionId: 'cancel-session',
        });

        await flushPromises();
        service.cancelValidation('cancel-session');
        deferredRows.resolve([['1']]);

        const outcome = await outcomePromise;
        expect(outcome.terminalPhase).toBe('cancelled');
        expect(service.isValidationActive('cancel-session')).toBe(false);
    });

    it('isolates a restarted session from the callbacks of the previous run', async () => {
        const firstRows = createDeferred<string[][]>();
        const firstEvents: ValidationEvent[] = [];

        service.startValidation({
            sessionId: 'shared-session',
            columns: [createColumn({ selectedType: 'INTEGER' })],
            importer: createImporter(firstRows.promise),
            adapter: createAdapter(),
            sampleSize: 5,
            progressCallback: (progress, summary) => {
                firstEvents.push({ progress, summary });
            },
        });

        await flushPromises();

        const secondOutcomePromise = startValidation(service, {
            sessionId: 'shared-session',
            columns: [createColumn({ selectedType: 'INTEGER' })],
            importer: createImporter([['5']]),
        });

        firstRows.resolve([['1']]);

        const secondOutcome = await secondOutcomePromise;
        await flushPromises();

        expect(secondOutcome.summary?.hasErrors).toBe(false);
        expect(firstEvents.map(event => event.progress.phase)).toEqual(['reading']);
    });

    it('returns undefined status for an unknown session', () => {
        expect(service.isValidationActive('missing-session')).toBe(false);
        expect(service.getStatus('missing-session')).toBeUndefined();
    });
});
