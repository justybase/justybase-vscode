/**
 * CQ-03: Common validators dla Copilot Tools
 * Lightweight validation functions (bez dodatkowych zależności)
 */

import { ValidationResult, ValidationError } from '../types';

/**
 * Walidator dla string (wymagany)
 */
export function requiredString(value: unknown, field: string): ValidationResult<string> {
    if (value === undefined || value === null) {
        return {
            success: false,
            errors: [{ field, message: `Field '${field}' is required`, code: 'REQUIRED' }]
        };
    }
    if (typeof value !== 'string') {
        return {
            success: false,
            errors: [{ field, message: `Field '${field}' must be a string`, code: 'INVALID_TYPE' }]
        };
    }
    if (value.trim().length === 0) {
        return {
            success: false,
            errors: [{ field, message: `Field '${field}' cannot be empty`, code: 'EMPTY_STRING' }]
        };
    }
    return { success: true, data: value };
}

/**
 * Walidator dla string (opcjonalny)
 */
export function optionalString(value: unknown, field: string): ValidationResult<string | undefined> {
    if (value === undefined || value === null) {
        return { success: true, data: undefined };
    }
    if (typeof value !== 'string') {
        return {
            success: false,
            errors: [{ field, message: `Field '${field}' must be a string or undefined`, code: 'INVALID_TYPE' }]
        };
    }
    return { success: true, data: value };
}

/**
 * Walidator dla number (wymagany)
 */
export function requiredNumber(value: unknown, field: string): ValidationResult<number> {
    if (value === undefined || value === null) {
        return {
            success: false,
            errors: [{ field, message: `Field '${field}' is required`, code: 'REQUIRED' }]
        };
    }
    if (typeof value !== 'number' || isNaN(value)) {
        return {
            success: false,
            errors: [{ field, message: `Field '${field}' must be a number`, code: 'INVALID_TYPE' }]
        };
    }
    return { success: true, data: value };
}

/**
 * Walidator dla number (opcjonalny)
 */
export function optionalNumber(value: unknown, field: string): ValidationResult<number | undefined> {
    if (value === undefined || value === null) {
        return { success: true, data: undefined };
    }
    if (typeof value !== 'number' || isNaN(value)) {
        return {
            success: false,
            errors: [{ field, message: `Field '${field}' must be a number or undefined`, code: 'INVALID_TYPE' }]
        };
    }
    return { success: true, data: value };
}

/**
 * Walidator dla boolean (opcjonalny)
 */
export function optionalBoolean(value: unknown, field: string): ValidationResult<boolean | undefined> {
    if (value === undefined || value === null) {
        return { success: true, data: undefined };
    }
    if (typeof value !== 'boolean') {
        return {
            success: false,
            errors: [{ field, message: `Field '${field}' must be a boolean or undefined`, code: 'INVALID_TYPE' }]
        };
    }
    return { success: true, data: value };
}

/**
 * Walidator dla array stringów (opcjonalny)
 */
export function optionalStringArray(value: unknown, field: string): ValidationResult<string[] | undefined> {
    if (value === undefined || value === null) {
        return { success: true, data: undefined };
    }
    if (!Array.isArray(value)) {
        return {
            success: false,
            errors: [{ field, message: `Field '${field}' must be an array`, code: 'INVALID_TYPE' }]
        };
    }
    if (!value.every(item => typeof item === 'string')) {
        return {
            success: false,
            errors: [{ field, message: `Field '${field}' must be an array of strings`, code: 'INVALID_ARRAY_TYPE' }]
        };
    }
    return { success: true, data: value };
}

/**
 * Walidator dla array stringów (wymagany)
 */
export function requiredStringArray(value: unknown, field: string): ValidationResult<string[]> {
    if (value === undefined || value === null) {
        return {
            success: false,
            errors: [{ field, message: `Field '${field}' is required`, code: 'REQUIRED' }]
        };
    }
    if (!Array.isArray(value)) {
        return {
            success: false,
            errors: [{ field, message: `Field '${field}' must be an array`, code: 'INVALID_TYPE' }]
        };
    }
    if (value.length === 0) {
        return {
            success: false,
            errors: [{ field, message: `Field '${field}' cannot be empty`, code: 'EMPTY_ARRAY' }]
        };
    }
    if (!value.every(item => typeof item === 'string')) {
        return {
            success: false,
            errors: [{ field, message: `Field '${field}' must be an array of strings`, code: 'INVALID_ARRAY_TYPE' }]
        };
    }
    return { success: true, data: value };
}

/**
 * Walidator dla enum stringów
 */
export function enumValidator<T extends string>(
    allowedValues: readonly T[],
    value: unknown,
    field: string
): ValidationResult<T> {
    if (value === undefined || value === null) {
        return {
            success: false,
            errors: [{ field, message: `Field '${field}' is required`, code: 'REQUIRED' }]
        };
    }
    if (typeof value !== 'string') {
        return {
            success: false,
            errors: [{ field, message: `Field '${field}' must be a string`, code: 'INVALID_TYPE' }]
        };
    }
    if (!allowedValues.includes(value as T)) {
        return {
            success: false,
            errors: [{
                field,
                message: `Field '${field}' must be one of: ${allowedValues.join(', ')}`,
                code: 'INVALID_ENUM'
            }]
        };
    }
    return { success: true, data: value as T };
}

/**
 * Walidator dla nazwy obiektu Netezza (table, schema, etc.)
 * Dopuszcza: alfanumeryczne, podkreślenia, kropki dla kwalifikowanych nazw
 */
export function netezzaObjectName(value: unknown, field: string): ValidationResult<string> {
    const stringResult = requiredString(value, field);
    if (!stringResult.success) {
        return stringResult;
    }

    const name = stringResult.data;
    // Dopuszczalne: alfanumeryczne, podkreślenia, kropki (dla kwalifikowanych nazw)
    const validPattern = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/;

    if (!validPattern.test(name)) {
        return {
            success: false,
            errors: [{
                field,
                message: `Field '${field}' contains invalid characters. Use alphanumeric, underscores, and dots for qualified names`,
                code: 'INVALID_FORMAT'
            }]
        };
    }

    return { success: true, data: name };
}

/**
 * Walidator dla SQL - podstawowa walidacja
 */
export function sqlString(value: unknown, field: string): ValidationResult<string> {
    const stringResult = requiredString(value, field);
    if (!stringResult.success) {
        return stringResult;
    }

    const sql = stringResult.data;

    // Podstawowa walidacja: musi zawierać jakieś SQL keywords
    const sqlKeywords = /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|WITH|EXPLAIN)\b/i;
    if (!sqlKeywords.test(sql)) {
        return {
            success: false,
            errors: [{
                field,
                message: `Field '${field}' does not appear to be valid SQL (no SQL keywords found)`,
                code: 'INVALID_SQL'
            }]
        };
    }

    return { success: true, data: sql };
}

/**
 * Łączy wiele błędów walidacji w jeden wynik
 */
export function combineValidationResults<T>(results: ValidationResult<T>[]): ValidationResult<T[]> {
    const allErrors: ValidationError[] = [];
    const validData: T[] = [];

    for (const result of results) {
        if (result.success) {
            validData.push(result.data);
        } else {
            allErrors.push(...result.errors);
        }
    }

    if (allErrors.length > 0) {
        return { success: false, errors: allErrors };
    }

    return { success: true, data: validData };
}
