/**
 * CQ-03: Error Taxonomy dla Copilot Tools
 * Standardowe typy błędów (CQ-04 compliance)
 */

import { ToolError, CommonErrorCodes } from './toolTypes';

/**
 * Factory dla tworzenia błędów tool
 */
export class ToolErrorFactory {
    /**
     * Tworzy błąd walidacji input
     */
    static invalidInput(field: string, message: string, details?: unknown): ToolError {
        return {
            code: CommonErrorCodes.INVALID_INPUT,
            type: 'validation',
            message: `Invalid input for field '${field}': ${message}`,
            details
        };
    }

    /**
     * Tworzy błąd brakującego wymaganego pola
     */
    static missingRequiredField(field: string): ToolError {
        return {
            code: CommonErrorCodes.MISSING_REQUIRED_FIELD,
            type: 'validation',
            message: `Required field '${field}' is missing`
        };
    }

    /**
     * Tworzy błąd nieprawidłowego typu
     */
    static invalidType(field: string, expected: string, actual: string): ToolError {
        return {
            code: CommonErrorCodes.INVALID_TYPE,
            type: 'validation',
            message: `Field '${field}' must be ${expected}, got ${actual}`
        };
    }

    /**
     * Tworzy błąd braku połączenia
     */
    static noConnection(): ToolError {
        return {
            code: CommonErrorCodes.NO_CONNECTION,
            type: 'connection',
            message: 'No active database connection. Please connect to a Netezza server first.'
        };
    }

    /**
     * Tworzy błąd utraty połączenia
     */
    static connectionLost(details?: unknown): ToolError {
        return {
            code: CommonErrorCodes.CONNECTION_LOST,
            type: 'connection',
            message: 'Database connection was lost during operation',
            details
        };
    }

    /**
     * Tworzy błąd wykonania
     */
    static executionFailed(message: string, details?: unknown): ToolError {
        return {
            code: CommonErrorCodes.EXECUTION_FAILED,
            type: 'execution',
            message,
            details
        };
    }

    /**
     * Tworzy błąd SQL
     */
    static sqlError(sqlError: string, details?: unknown): ToolError {
        return {
            code: CommonErrorCodes.SQL_ERROR,
            type: 'execution',
            message: `SQL execution failed: ${sqlError}`,
            details
        };
    }

    /**
     * Tworzy błąd timeout
     */
    static timeout(operation: string, timeoutMs: number): ToolError {
        return {
            code: CommonErrorCodes.TIMEOUT,
            type: 'timeout',
            message: `Operation '${operation}' timed out after ${timeoutMs}ms`
        };
    }

    /**
     * Tworzy błąd nieznalezienia obiektu
     */
    static objectNotFound(objectType: string, objectName: string): ToolError {
        return {
            code: CommonErrorCodes.OBJECT_NOT_FOUND,
            type: 'not_found',
            message: `${objectType} '${objectName}' not found in the database`
        };
    }

    /**
     * Tworzy błąd anulowania
     */
    static cancelled(reason?: string): ToolError {
        return {
            code: CommonErrorCodes.CANCELLED,
            type: 'cancelled',
            message: reason || 'Operation was cancelled by user'
        };
    }

    /**
     * Konwertuje Error na ToolError
     */
    static fromError(error: Error, defaultCode = CommonErrorCodes.EXECUTION_FAILED): ToolError {
        return {
            code: defaultCode,
            type: 'execution',
            message: error.message,
            details: error.stack
        };
    }
}

/**
 * Klasyfikacja błędów dla UI
 */
export const ErrorClassification = {
    /**
     * Błędy które wymagają potwierdzenia użytkownika
     */
    requiresConfirmation: (error: ToolError): boolean => {
        return error.type === 'execution' && error.code === CommonErrorCodes.EXECUTION_FAILED;
    },

    /**
     * Błędy które mogą być retry-owane
     */
    isRetryable: (error: ToolError): boolean => {
        return ['connection', 'timeout'].includes(error.type);
    },

    /**
     * Błędy które są spowodowane przez użytkownika
     */
    isUserError: (error: ToolError): boolean => {
        return error.type === 'validation';
    },

    /**
     * Błędy krytyczne infrastruktury
     */
    isInfrastructureError: (error: ToolError): boolean => {
        return error.type === 'execution' && !ErrorClassification.isUserError(error);
    }
};
