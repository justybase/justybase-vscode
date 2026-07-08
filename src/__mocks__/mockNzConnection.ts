
import { NzConnection, NzCommand, NzDataReader } from '../types/index';

type MockRow = Record<string, unknown>;

export class MockNzConnection implements NzConnection {
    public _connected: boolean = false;
    private mockData: Map<string, MockRow[]> = new Map();

    constructor(mockData?: Map<string, MockRow[]>) {
        if (mockData) {
            this.mockData = mockData;
        }
    }

    // Helper to setup mock responses for specific queries
    public setMockData(queryPattern: string, data: MockRow[]) {
        this.mockData.set(queryPattern, data);
    }

    public async connect(): Promise<void> {
        this._connected = true;
        return Promise.resolve();
    }

    public async close(): Promise<void> {
        this._connected = false;
        return Promise.resolve();
    }

    public createCommand(sql: string): NzCommand {
        return new MockNzCommand(sql, this.mockData);
    }

    // Event emitter stubs
    public on(_event: string, _listener: (arg: unknown) => void): void {
        // No-op
    }

    public removeListener(_event: string, _listener: (arg: unknown) => void): void {
        // No-op
    }
}

export class MockNzCommand implements NzCommand {
    public commandTimeout: number = 30;
    public _recordsAffected: number = -1;

    constructor(private sql: string, private mockData: Map<string, MockRow[]>) { }

    public async executeReader(): Promise<NzDataReader> {
        let data: MockRow[] = [];
        let bestPatternLength = -1;

        for (const [pattern, mockRows] of this.mockData.entries()) {
            if (this.sql.includes(pattern) && pattern.length > bestPatternLength) {
                bestPatternLength = pattern.length;
                data = mockRows;
            }
        }

        return new MockNzDataReader(data);
    }

    public async cancel(): Promise<void> {
        return Promise.resolve();
    }

    public async execute(): Promise<void> {
        return Promise.resolve();
    }
}

export class MockNzDataReader implements NzDataReader {
    private currentIndex: number = -1;
    public fieldCount: number = 0;
    private columns: string[] = [];

    constructor(private data: MockRow[]) {
        if (data.length > 0) {
            this.columns = Object.keys(data[0]);
            this.fieldCount = this.columns.length;
        }
    }

    public async read(): Promise<boolean> {
        this.currentIndex++;
        return Promise.resolve(this.currentIndex < this.data.length);
    }

    public async nextResult(): Promise<boolean> {
        return Promise.resolve(false);
    }

    public getValue(index: number): unknown {
        if (this.currentIndex >= 0 && this.currentIndex < this.data.length) {
            const row = this.data[this.currentIndex];
            const colName = this.columns[index];
            return row[colName];
        }
        return null;
    }

    public getName(index: number): string {
        return this.columns[index] || '';
    }

    public getTypeName(_index: number): string {
        return 'VARCHAR'; // Stub
    }

    public async close(): Promise<void> {
        return Promise.resolve();
    }
}
