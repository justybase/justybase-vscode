import { Readable } from 'stream';

describe('PostgreSqlConnection COPY runtime', () => {
    afterEach(() => {
        jest.resetModules();
        jest.unmock('node:module');
    });

    async function loadModule(): Promise<{
        module: typeof import('../../extensions/postgresql/src/postgresqlConnection');
        capturedSql: string[];
    }> {
        const capturedSql: string[] = [];

        class FakePgInternalQuery {
            public callback?: (error: Error | null, result?: unknown) => void;
            public binary?: boolean;
            public query_timeout?: number;
            public _result?: { _types?: unknown };

            public constructor(config: string | { text: string }) {
                capturedSql.push(typeof config === 'string' ? config : config.text);
            }

            public submit(): Error | null {
                return null;
            }

            public handleError(): void {
                return undefined;
            }

            public handleReadyForQuery(): void {
                return undefined;
            }

            public handleCopyData(): void {
                return undefined;
            }
        }

        const extensionRequire = jest.fn((moduleName: string) => {
            if (moduleName === 'pg/lib/query') {
                return FakePgInternalQuery;
            }
            if (moduleName === 'pg-protocol') {
                return {
                    serialize: {
                        copyData(chunk: Buffer) {
                            return Buffer.from(chunk);
                        },
                        copyDone() {
                            return Buffer.from('__COPY_DONE__');
                        }
                    }
                };
            }
            if (moduleName === 'pg') {
                return {};
            }

            throw new Error(`Unexpected module request: ${moduleName}`);
        });

        jest.doMock('node:module', () => ({
            createRequire: jest.fn(() => extensionRequire)
        }));

        const module = await import('../../extensions/postgresql/src/postgresqlConnection');
        return { module, capturedSql };
    }

    it('rejects non-readable import streams', async () => {
        const { module } = await loadModule();
        const { PostgreSqlConnection } = module;

        expect(() => PostgreSqlConnection.registerImportStream('bad-stream', {})).toThrow(
            'PostgreSQL import stream must be a readable stream.'
        );
    });

    it('streams COPY input through pg internal query hooks and strips the marker comment', async () => {
        const { module, capturedSql } = await loadModule();
        const { PostgreSqlConnection } = module;
        const sentChunks: string[] = [];

        const connection = new PostgreSqlConnection({
            host: 'localhost',
            database: 'warehouse',
            user: 'postgres'
        });

        (connection as unknown as { _client: unknown })._client = {
            query(query: {
                callback?: (error: Error | null, result?: unknown) => void;
                handleCopyInResponse(connection: {
                    stream: {
                        write(buffer: Buffer): boolean;
                        once(eventName: string, listener: () => void): void;
                    };
                    sendCopyFail(message: string): void;
                }): void;
            }) {
                let shouldBackpressure = true;
                query.handleCopyInResponse({
                    stream: {
                        write(buffer: Buffer) {
                            const text = buffer.toString('utf8');
                            if (text === '__COPY_DONE__') {
                                query.callback?.(null, { rowCount: 2 });
                                return true;
                            }

                            sentChunks.push(text);
                            if (shouldBackpressure) {
                                shouldBackpressure = false;
                                return false;
                            }

                            return true;
                        },
                        once(_eventName: string, listener: () => void) {
                            setImmediate(listener);
                        }
                    },
                    sendCopyFail(message: string) {
                        query.callback?.(new Error(message));
                    }
                });
            }
        };

        PostgreSqlConnection.registerImportStream('unit-copy', Readable.from(['1\tAlice\n', '2\tBob\n']));

        try {
            const affectedRows = await connection.executeCopyFromStream(
                'COPY public.people FROM STDIN',
                'unit-copy'
            );

            expect(affectedRows).toBe(2);
            expect(sentChunks.join('')).toBe('1\tAlice\n2\tBob\n');
            expect(capturedSql).toEqual(['COPY public.people FROM STDIN']);
        } finally {
            PostgreSqlConnection.unregisterImportStream('unit-copy');
        }
    });

    it('routes COPY marker commands through the COPY runtime path', async () => {
        const { module } = await loadModule();
        const { PostgreSqlConnection } = module;
        const connection = new PostgreSqlConnection({
            host: 'localhost',
            database: 'warehouse',
            user: 'postgres'
        });

        const executeCopyFromStream = jest
            .spyOn(connection, 'executeCopyFromStream')
            .mockResolvedValue(4);

        const command = connection.createCommand('COPY public.people FROM STDIN /* JBL_IMPORT_STREAM:route-test */');
        await command.execute();

        expect(executeCopyFromStream).toHaveBeenCalledWith('COPY public.people FROM STDIN', 'route-test');
        expect(command._recordsAffected).toBe(4);
    });
});
