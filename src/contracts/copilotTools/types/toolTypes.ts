/**
 * CQ-03: Contract Layer dla Copilot Tools
 * Centralne definicje typów dla kontraktów narzędzi Copilot
 */

/**
 * Standardowy format odpowiedzi z tool (AI-02 compliance)
 * Wszystkie tools muszą zwracać ten format
 */
export interface ToolOutput<TData = unknown> {
    /** Podsumowanie dla LLM - co zostało wykonane */
    summary: string;

    /** Dane specyficzne dla danego tool - może być dowolnego typu */
    data: TData;

    /** Lista błędów (pusta jeśli brak) */
    errors: ToolError[];

    /** Opcjonalne sugestie kolejnych kroków dla agenta */
    nextActions?: string[];
}

/**
 * Definicja błędu tool
 */
export interface ToolError {
    /** Kod błędu (np. TOOL-INPUT-001) */
    code: string;

    /** Typ błędu */
    type: 'validation' | 'execution' | 'connection' | 'timeout' | 'cancelled' | 'not_found';

    /** Wiadomość dla użytkownika/LLM */
    message: string;

    /** Opcjonalne szczegóły techniczne */
    details?: unknown;
}

/**
 * Definicja rejestru błędów dla tool
 */
export interface ToolErrorRegistry {
    [code: string]: {
        message: string;
        type: ToolError['type'];
    };
}

/**
 * Funkcja walidująca input
 */
export type ValidatorFn<T> = (input: unknown) => ValidationResult<T>;

/**
 * Typ dla wyniku walidacji
 */
export type ValidationResult<T> =
    | { success: true; data: T }
    | { success: false; errors: ValidationError[] };

/**
 * Błąd walidacji
 */
export interface ValidationError {
    field: string;
    message: string;
    code: string;
}

/**
 * Centralna definicja kontraktu narzędzia
 * Używana jako Single Source of Truth dla każdego tool
 */
export interface ToolContract<TInput = unknown, TOutput = unknown> {
    /** Nazwa tool w VS Code (zgodna z package.json) */
    name: string;

    /** Nazwa wyświetlana */
    displayName: string;

    /** Opis dla modelu */
    description: string;

    /** Referencja w promptach (np. #schema) */
    toolReferenceName?: string;

    /** Funkcja walidacji input */
    validateInput: ValidatorFn<TInput>;

    /** Funkcja walidacji output */
    validateOutput: ValidatorFn<ToolOutput<TOutput>>;

    /** Rejestr błędów specyficznych dla tego tool */
    errorCodes: ToolErrorRegistry;

    /** Czy tool wymaga aktywnego połączenia */
    requiresConnection: boolean;

    /** Tagi dla kategoryzacji */
    tags: string[];
}

/**
 * Input parameters dla tools - base types
 */
export interface BaseToolInput {
    /** Opcjonalna nazwa bazy danych */
    database?: string;
}

/**
 * Typ dla SQL w input
 */
export interface SqlToolInput extends BaseToolInput {
    /** Kod SQL */
    sql: string;
}

/**
 * Typ dla table reference
 */
export interface TableToolInput extends BaseToolInput {
    /** Nazwa tabeli (może zawierać schema) */
    tableName: string;

    /** Opcjonalna nazwa schema */
    schema?: string;
}

/**
 * Metadata dla tool execution
 */
export interface ToolExecutionMetadata {
    /** Timestamp startu */
    startTime: number;

    /** Timestamp zakończenia */
    endTime?: number;

    /** ID tool */
    toolName: string;

    /** ID requestu (do korelacji) */
    requestId: string;
}

/**
 * Predefined error codes (CQ-04 compliance)
 */
export const CommonErrorCodes = {
    // Input validation errors (TOOL-INPUT-xxx)
    INVALID_INPUT: 'TOOL-INPUT-001',
    MISSING_REQUIRED_FIELD: 'TOOL-INPUT-002',
    INVALID_TYPE: 'TOOL-INPUT-003',
    INVALID_FORMAT: 'TOOL-INPUT-004',

    // Connection errors (TOOL-CONN-xxx)
    NO_CONNECTION: 'TOOL-CONN-001',
    CONNECTION_LOST: 'TOOL-CONN-002',

    // Execution errors (TOOL-EXEC-xxx)
    EXECUTION_FAILED: 'TOOL-EXEC-001',
    SQL_ERROR: 'TOOL-EXEC-002',

    // Timeout errors (TOOL-TIMEOUT-xxx)
    TIMEOUT: 'TOOL-TIMEOUT-001',

    // Not found errors (TOOL-NOTFOUND-xxx)
    OBJECT_NOT_FOUND: 'TOOL-NOTFOUND-001',

    // Cancelled (TOOL-CANCEL-xxx)
    CANCELLED: 'TOOL-CANCEL-001'
} as const;

/**
 * Builder dla ToolOutput
 */
export class ToolOutputBuilder<TData> {
    private output: Partial<ToolOutput<TData>> = {
        errors: []
    };

    summary(text: string): this {
        this.output.summary = text;
        return this;
    }

    data(data: TData): this {
        this.output.data = data;
        return this;
    }

    error(error: ToolError): this {
        if (!this.output.errors) {
            this.output.errors = [];
        }
        this.output.errors.push(error);
        return this;
    }

    nextActions(actions: string[]): this {
        this.output.nextActions = actions;
        return this;
    }

    build(): ToolOutput<TData> {
        if (!this.output.summary) {
            throw new Error('ToolOutput requires summary');
        }
        if (this.output.data === undefined) {
            throw new Error('ToolOutput requires data');
        }
        return this.output as ToolOutput<TData>;
    }

    /**
     * Create success output
     */
    static success<TData>(summary: string, data: TData, nextActions?: string[]): ToolOutput<TData> {
        return {
            summary,
            data,
            errors: [],
            nextActions
        };
    }

    /**
     * Create error output
     */
    static error(summary: string, error: ToolError): ToolOutput<null> {
        return {
            summary,
            data: null,
            errors: [error]
        };
    }
}
