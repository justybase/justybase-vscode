export interface MacroVariable {
    name: string;
    normalizedName: string;
    value: string;
}

export interface MacroPreprocessorOptions {
    environment?: MacroEnvironment;
    initialValues?: Record<string, string>;
    replaceVariables?: boolean;
    resolvePutMessages?: boolean;
}

export interface MacroPythonExecutionResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export type MacroPythonExecutor = (
    script: string,
    args: string[],
) => Promise<MacroPythonExecutionResult>;

export interface MacroPreprocessorContext {
    log?: (message: string) => void | Promise<void>;
    prompt?: (variables: Set<string>) => Promise<Record<string, string>>;
    query?: MacroQueryExecutor;
    exporter?: MacroExportExecutor;
    pythonExecutor?: MacroPythonExecutor;
    readFile?: (
        path: string,
        fromSource?: string,
    ) => Promise<{ path: string; content: string }>;
    sourceName?: string;
    maxIncludeDepth?: number;
    maxBlockDepth?: number;
}

export interface MacroScriptEvent {
    type: 'put' | 'export' | 'include' | 'branch' | 'error' | 'statement' | 'python';
    message: string;
    sourceName?: string;
    line?: number;
}

export interface MacroPreprocessResult {
    sql: string;
    variables: Record<string, string>;
    putMessages: string[];
    unresolvedVariables: string[];
    environment: MacroEnvironment;
    scriptEvents?: MacroScriptEvent[];
}

export interface MacroQueryExecutionResult {
    columns?: readonly { name: string; type?: string }[];
    rows: readonly (readonly unknown[])[];
}

export type MacroQueryExecutor = (
    sql: string,
) => Promise<MacroQueryExecutionResult>;

export type MacroExportFormat = 'xlsx' | 'xlsb' | 'parquet' | 'csv' | 'xpt';

export interface MacroExportRequest {
    format: MacroExportFormat;
    filePath: string;
    query: string;
    sheetName: string;
    overwrite: boolean;
}

export interface MacroExportExecutionResult {
    filePath: string;
    format: MacroExportFormat;
    rowsExported: number;
    columns: number;
    message?: string;
}

export type MacroExportExecutor = (
    request: MacroExportRequest,
) => Promise<MacroExportExecutionResult>;

export interface MacroReference {
    name: string;
    start: number;
    end: number;
    text: string;
}

export interface ScanOptions {
    replaceVariables: boolean;
    unresolved: Set<string>;
}

export interface MacroQueryFunction {
    kind: 'sql' | 'sqllist';
    start: number;
    end: number;
    text: string;
    query: string;
}

export interface MacroEvalFunction {
    start: number;
    end: number;
    text: string;
    expression: string;
}

export type MacroDirective =
    | { kind: 'declaration'; name: string; value: string; end: number }
    | { kind: 'put'; message: string; end: number }
    | { kind: 'export'; payload: string; end: number }
    | { kind: 'include'; path: string; end: number }
    | { kind: 'python'; script: string; args: string[]; end: number }
    | { kind: 'do'; end: number }
    | { kind: 'if'; condition: string; end: number }
    | { kind: 'else'; end: number }
    | { kind: 'end'; end: number };

export interface MacroProcessingState {
    environment: MacroEnvironment;
    putMessages: string[];
    scriptEvents: MacroScriptEvent[];
    unresolved: Set<string>;
    replaceVariables: boolean;
    resolvePutMessages: boolean;
    context: MacroPreprocessorContext;
}

export interface IfBlockRange {
    thenStart: number;
    thenEnd: number;
    elseStart?: number;
    elseEnd?: number;
    end: number;
}

export interface DoBlockRange {
    bodyEnd: number;
    end: number;
}

export const DEFAULT_MAX_INCLUDE_DEPTH = 16;
export const DEFAULT_MAX_BLOCK_DEPTH = 32;

export class MacroScriptError extends Error {}

export class MacroEnvironment {
    private readonly values = new Map<string, MacroVariable>();

    constructor(initialValues?: Record<string, string>) {
        this.setMany(initialValues);
    }

    public set(name: string, value: string): void {
        const normalizedName = normalizeVariableName(name);
        this.values.set(normalizedName, {
            name: name.trim(),
            normalizedName,
            value,
        });
    }

    public setMany(values?: Record<string, string>): void {
        if (!values) {
            return;
        }

        for (const [name, value] of Object.entries(values)) {
            this.set(name, value);
        }
    }

    public get(name: string): string | undefined {
        return this.values.get(normalizeVariableName(name))?.value;
    }

    public has(name: string): boolean {
        return this.values.has(normalizeVariableName(name));
    }

    public toRecord(): Record<string, string> {
        const record: Record<string, string> = {};
        for (const [name, variable] of this.values) {
            record[name] = variable.value;
        }
        return record;
    }
}

export function normalizeVariableName(name: string): string {
    return name.trim().toUpperCase();
}
