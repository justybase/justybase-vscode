import type { ProcedureBlock } from '../../../sqlParser/procedure/procedureCodeLens';
import type {
    ProcedureCallArgument,
    ProcedureCallArgumentType,
    ProcedureRepairInput,
    ProcedureRepairMode,
} from '../../../contracts/copilotTools/types';

export const PROCEDURE_REPAIR_MAX_ATTEMPTS = 3;

export type { ProcedureCallArgument, ProcedureCallArgumentType, ProcedureRepairInput, ProcedureRepairMode };

export interface ProcedureIdentity {
    name: string;
    createMode: 'CREATE' | 'CREATE OR REPLACE';
}

export interface ProcedureTarget {
    block: ProcedureBlock;
    identity: ProcedureIdentity;
}

const PROCEDURE_HEADER_PATTERN = /\bCREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\s+/iu;
const IDENTIFIER_PART_PATTERN = /^(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)$/u;

/**
 * Extracts the procedure name from a CREATE PROCEDURE header without trying
 * to parse the complete parameter declaration. Netezza qualified names may
 * use DB..PROCEDURE, so empty qualified segments are preserved.
 */
export function extractProcedureIdentity(sql: string): ProcedureIdentity | undefined {
    const headerMatch = PROCEDURE_HEADER_PATTERN.exec(sql);
    if (!headerMatch) {
        return undefined;
    }

    const afterHeader = sql.slice(headerMatch.index + headerMatch[0].length);
    const openingParen = findOpeningParenthesis(afterHeader);
    if (openingParen < 0) {
        return undefined;
    }

    const rawName = afterHeader.slice(0, openingParen).trim();
    if (!rawName || rawName.includes(';') || !isQualifiedIdentifier(rawName)) {
        return undefined;
    }

    return {
        name: rawName.replace(/\s*\.\s*/gu, '.'),
        createMode: headerMatch[1] ? 'CREATE OR REPLACE' : 'CREATE'
    };
}

function findOpeningParenthesis(text: string): number {
    let inDoubleQuote = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        const nextChar = text[index + 1] ?? '';

        if (inLineComment) {
            if (char === '\n') {
                inLineComment = false;
            }
            continue;
        }
        if (inBlockComment) {
            if (char === '*' && nextChar === '/') {
                inBlockComment = false;
                index++;
            }
            continue;
        }
        if (inDoubleQuote) {
            if (char === '"' && nextChar === '"') {
                index++;
            } else if (char === '"') {
                inDoubleQuote = false;
            }
            continue;
        }

        if (char === '-' && nextChar === '-') {
            inLineComment = true;
            index++;
        } else if (char === '/' && nextChar === '*') {
            inBlockComment = true;
            index++;
        } else if (char === '"') {
            inDoubleQuote = true;
        } else if (char === '(') {
            return index;
        }
    }

    return -1;
}

function isQualifiedIdentifier(value: string): boolean {
    const parts = value.split('.');
    if (parts.length === 0 || parts.length > 3) {
        return false;
    }

    return parts.every((part, index) => index > 0 && part === '' ? true : IDENTIFIER_PART_PATTERN.test(part));
}

export function buildProcedureCall(
    procedureName: string,
    callArguments: readonly ProcedureCallArgument[],
): string {
    return `CALL ${procedureName}(${callArguments.map(formatProcedureCallArgument).join(', ')});`;
}

export function formatProcedureCallArgument(argument: ProcedureCallArgument): string {
    switch (argument.type) {
        case 'string':
            if (typeof argument.value !== 'string') {
                throw new Error('String CALL arguments must provide a string value.');
            }
            return `'${argument.value.replace(/'/gu, "''")}'`;
        case 'number':
            if (typeof argument.value !== 'number' || !Number.isFinite(argument.value)) {
                throw new Error('Number CALL arguments must provide a finite number value.');
            }
            return String(argument.value);
        case 'boolean':
            if (typeof argument.value !== 'boolean') {
                throw new Error('Boolean CALL arguments must provide a boolean value.');
            }
            return argument.value ? 'TRUE' : 'FALSE';
        case 'null':
            if (argument.value !== null) {
                throw new Error('Null CALL arguments must provide a null value.');
            }
            return 'NULL';
        case 'date':
            if (typeof argument.value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(argument.value)) {
                throw new Error('Date CALL arguments must use YYYY-MM-DD.');
            }
            return `DATE '${argument.value}'`;
        case 'timestamp':
            if (typeof argument.value !== 'string' || argument.value.trim().length === 0) {
                throw new Error('Timestamp CALL arguments must provide a non-empty value.');
            }
            return `TIMESTAMP '${argument.value.replace(/'/gu, "''")}'`;
        default:
            return assertNever(argument.type);
    }
}

function assertNever(value: never): never {
    throw new Error(`Unsupported CALL argument type: ${String(value)}`);
}

export function findProcedureTarget(
    blocks: readonly ProcedureBlock[],
    candidateSql: string,
): ProcedureTarget | undefined {
    const candidateIdentity = extractProcedureIdentity(candidateSql);
    if (!candidateIdentity) {
        return undefined;
    }

    const normalizedCandidateName = normalizeProcedureName(candidateIdentity.name);
    const matchingBlocks = blocks.filter(block => {
        const identity = extractProcedureIdentity(block.sql);
        return identity && normalizeProcedureName(identity.name) === normalizedCandidateName;
    });

    if (matchingBlocks.length !== 1) {
        return undefined;
    }

    return { block: matchingBlocks[0], identity: candidateIdentity };
}

export function normalizeProcedureName(name: string): string {
    return name.replace(/""/gu, '"').toUpperCase();
}
