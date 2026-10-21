/**
 * DDL Generator - Sequence, Materialized View, Function and Aggregate DDL
 *
 * Catalog sources (live-checked on Netezza 11.2):
 * - _V_SEQUENCE (name/owner) joined to _VT_SEQUENCE.SEQ_ID (type, bounds, increment, cycle)
 * - _V_VIEW with OBJTYPE = 'MATERIALIZED VIEW' (stored SELECT definition)
 * - _V_FUNCTION / _V_AGGREGATE (signature, return type and UDX attributes)
 */

import { executeQueryHelper } from './helpers';
import type { NzConnection } from '../../../types';
import {
    buildNetezzaIdentifierEquality,
    createNetezzaCatalogIdentifier,
    escapeNetezzaSqlLiteral,
    formatNetezzaIdentifier,
} from '../metadata/identifierUtils';

function qualifiedName(database: string, schema: string, name: string): string {
    return [database, schema, name]
        .map(part => formatNetezzaIdentifier(createNetezzaCatalogIdentifier(part)))
        .join('.');
}

function catalogFrom(database: string, view: string): string {
    return `${formatNetezzaIdentifier(createNetezzaCatalogIdentifier(database))}..${view}`;
}

function commentStatement(kind: string, name: string, description: unknown): string {
    if (typeof description !== 'string' || description.length === 0) return '';
    return `\n\nCOMMENT ON ${kind} ${name} IS '${escapeNetezzaSqlLiteral(description)}';`;
}

function scopePredicate(database: string, schema: string, alias = ''): string {
    return `${buildNetezzaIdentifierEquality(`${alias}DATABASE`, createNetezzaCatalogIdentifier(database))}
            AND ${buildNetezzaIdentifierEquality(`${alias}SCHEMA`, createNetezzaCatalogIdentifier(schema))}`;
}

export interface NetezzaSequenceDefinition {
    dataType: string;
    minValue: string;
    maxValue: string;
    increment: number | string;
    cycle: boolean;
    nextCacheValue?: string | null;
    owner?: string | null;
    description?: string | null;
}

export function buildNetezzaSequenceDdl(
    database: string,
    schema: string,
    sequenceName: string,
    definition: NetezzaSequenceDefinition,
): string {
    const name = qualifiedName(database, schema, sequenceName);
    const increment = Number(definition.increment);
    const start = increment < 0 ? definition.maxValue : definition.minValue;
    const lines = [
        `CREATE SEQUENCE ${name} AS ${definition.dataType.toUpperCase()}`,
        `    START WITH ${start}`,
        `    INCREMENT BY ${definition.increment}`,
        `    MINVALUE ${definition.minValue}`,
        `    MAXVALUE ${definition.maxValue}`,
        `    ${definition.cycle ? 'CYCLE' : 'NO CYCLE'};`,
    ];
    const header = definition.nextCacheValue != null
        ? `-- Next cached value: ${definition.nextCacheValue}. Use START WITH ${definition.nextCacheValue} to continue numbering.\n`
        : '';
    const owner = definition.owner ? `\n\nALTER SEQUENCE ${name} OWNER TO ${formatNetezzaIdentifier(createNetezzaCatalogIdentifier(definition.owner))};` : '';
    return `${header}${lines.join('\n')}${owner}${commentStatement('SEQUENCE', name, definition.description)}`;
}

export async function generateSequenceDDL(
    connection: NzConnection,
    database: string,
    schema: string,
    sequenceName: string,
): Promise<string> {
    const rows = await executeQueryHelper<{
        OWNER: string;
        DESCRIPTION: string | null;
        DATA_TYPE: string;
        MIN_VALUE: string | number | bigint;
        MAX_VALUE: string | number | bigint;
        INCREMENT: string | number | bigint;
        CYCLE: boolean;
        NEXT_CACHE_VAL: string | number | bigint | null;
    }>(connection, `
        SELECT S.OWNER, O.DESCRIPTION, VT.DATA_TYPE, VT.MIN_VALUE, VT.MAX_VALUE, VT.INCREMENT, VT.CYCLE, VT.NEXT_CACHE_VAL
        FROM ${catalogFrom(database, '_V_SEQUENCE')} S
        JOIN ${catalogFrom(database, '_VT_SEQUENCE')} VT ON VT.SEQ_ID = S.OBJID
        LEFT JOIN ${catalogFrom(database, '_V_OBJECT_DATA')} O ON O.OBJID = S.OBJID
        WHERE ${scopePredicate(database, schema, 'S.')}
            AND ${buildNetezzaIdentifierEquality('S.SEQNAME', createNetezzaCatalogIdentifier(sequenceName))}
    `);
    if (rows.length === 0) {
        throw new Error(`Sequence ${database}.${schema}.${sequenceName} not found`);
    }
    const row = rows[0];
    return buildNetezzaSequenceDdl(database, schema, sequenceName, {
        dataType: row.DATA_TYPE,
        minValue: String(row.MIN_VALUE),
        maxValue: String(row.MAX_VALUE),
        increment: String(row.INCREMENT),
        cycle: Boolean(row.CYCLE),
        nextCacheValue: row.NEXT_CACHE_VAL == null ? null : String(row.NEXT_CACHE_VAL),
        owner: row.OWNER,
        description: row.DESCRIPTION,
    });
}

export function buildNetezzaMaterializedViewDdl(
    database: string,
    schema: string,
    viewName: string,
    definition: string,
    owner?: string | null,
    description?: string | null,
): string {
    const name = qualifiedName(database, schema, viewName);
    const select = definition.trim().replace(/;\s*$/, '');
    const ownerNote = owner ? `-- Owner: ${owner}\n` : '';
    return `${ownerNote}CREATE MATERIALIZED VIEW ${name} AS\n${select};${commentStatement('VIEW', name, description)}`;
}

export async function generateMaterializedViewDDL(
    connection: NzConnection,
    database: string,
    schema: string,
    viewName: string,
): Promise<string> {
    const rows = await executeQueryHelper<{ DEFINITION: string; OWNER: string; DESCRIPTION: string | null }>(connection, `
        SELECT DEFINITION, OWNER, DESCRIPTION
        FROM ${catalogFrom(database, '_V_VIEW')}
        WHERE ${scopePredicate(database, schema)}
            AND ${buildNetezzaIdentifierEquality('VIEWNAME', createNetezzaCatalogIdentifier(viewName))}
            AND OBJTYPE = 'MATERIALIZED VIEW'
    `);
    if (rows.length === 0) {
        throw new Error(`Materialized view ${database}.${schema}.${viewName} not found`);
    }
    return buildNetezzaMaterializedViewDdl(database, schema, viewName, rows[0].DEFINITION, rows[0].OWNER, rows[0].DESCRIPTION);
}

export interface NetezzaRoutineDefinition {
    kind: 'FUNCTION' | 'AGGREGATE';
    name: string;
    arguments: string;
    returns: string;
    stateType?: string | null;
    deterministic?: boolean | null;
    returnsNullOnNullInput?: boolean | null;
    fenced?: boolean | null;
    varargs?: boolean | null;
    externalName?: string | null;
    memory?: string | null;
    logMask?: string | null;
    version?: number | null;
    description?: string | null;
}

/**
 * Netezza user-defined functions and aggregates are compiled UDX objects. The
 * catalog keeps the signature and runtime attributes but not the compiled
 * object file locations, so the generated statement lists them as
 * placeholders that must be filled in before running it.
 */
export function buildNetezzaRoutineDdl(database: string, schema: string, routine: NetezzaRoutineDefinition): string {
    const name = qualifiedName(database, schema, routine.name);
    const args = routine.arguments?.trim() || '()';
    const options: string[] = ['LANGUAGE CPP', 'PARAMETER STYLE NPSGENERIC'];
    if (routine.varargs) options.push('VARARGS');
    if (routine.fenced != null) options.push(routine.fenced ? 'FENCED' : 'NOT FENCED');
    if (routine.kind === 'FUNCTION') {
        if (routine.deterministic != null) options.push(routine.deterministic ? 'DETERMINISTIC' : 'NOT DETERMINISTIC');
        if (routine.returnsNullOnNullInput != null) {
            options.push(routine.returnsNullOnNullInput ? 'RETURNS NULL ON NULL INPUT' : 'CALLED ON NULL INPUT');
        }
    }
    if (routine.memory && routine.memory !== '0') options.push(`MEMORY '${escapeNetezzaSqlLiteral(routine.memory)}'`);
    if (routine.logMask && routine.logMask !== 'NONE') options.push(`LOGMASK ${routine.logMask}`);
    const state = routine.kind === 'AGGREGATE' && routine.stateType ? `\nSTATE (${routine.stateType})` : '';
    const className = routine.externalName ? escapeNetezzaSqlLiteral(routine.externalName) : '<class name>';
    const header = [
        `-- Netezza ${routine.kind.toLowerCase()} UDX${routine.version ? ` version ${routine.version}` : ''}.`,
        '-- The catalog does not record the compiled object files; replace the',
        '-- EXTERNAL HOST/SPU OBJECT placeholders before running this statement.',
    ].join('\n');
    return `${header}
CREATE OR REPLACE ${routine.kind} ${name}${args}
RETURNS ${routine.returns}${state}
${options.join('\n')}
EXTERNAL CLASS NAME '${className}'
EXTERNAL HOST OBJECT '<path to host .o_x86>'
EXTERNAL SPU OBJECT '<path to SPU .o_spu10>';${commentStatement(routine.kind, `${name}${args}`, routine.description)}`;
}

function splitSignature(objectName: string): { name: string; signature?: string } {
    const open = objectName.indexOf('(');
    return open > 0 ? { name: objectName.slice(0, open).trim(), signature: objectName.trim() } : { name: objectName.trim() };
}

export async function generateRoutineDDL(
    connection: NzConnection,
    database: string,
    schema: string,
    objectName: string,
    kind: 'FUNCTION' | 'AGGREGATE',
): Promise<string> {
    const { name, signature } = splitSignature(objectName);
    const nameColumn = kind === 'FUNCTION' ? 'FUNCTION' : 'AGGREGATE';
    const signatureColumn = kind === 'FUNCTION' ? 'FUNCTIONSIGNATURE' : 'AGGREGATESIGNATURE';
    const match = signature
        ? `${signatureColumn} = '${escapeNetezzaSqlLiteral(signature.toUpperCase())}'`
        : buildNetezzaIdentifierEquality(nameColumn, createNetezzaCatalogIdentifier(name));
    const sql = kind === 'FUNCTION'
        ? `SELECT FUNCTION AS NAME, ARGUMENTS, RESULT AS RETURNS, NULL AS STATE, DETERMINISTIC, RETURNSNULLONNULLINPUT,
               FENCED, VARARGS, EXTERNALNAME, MEMORY, LOGMASK, VERSION, DESCRIPTION
           FROM ${catalogFrom(database, '_V_FUNCTION')}
           WHERE ${scopePredicate(database, schema)} AND ${match}`
        : `SELECT AGGREGATE AS NAME, ARGUMENTS, RETURN_TYPE AS RETURNS, STATE, NULL AS DETERMINISTIC, NULL AS RETURNSNULLONNULLINPUT,
               FENCED, VARARGS, EXTERNALNAME, MEMORY, LOGMASK, VERSION, DESCRIPTION
           FROM ${catalogFrom(database, '_V_AGGREGATE')}
           WHERE ${scopePredicate(database, schema)} AND ${match}`;
    const rows = await executeQueryHelper<{
        NAME: string; ARGUMENTS: string; RETURNS: string; STATE: string | null;
        DETERMINISTIC: boolean | null; RETURNSNULLONNULLINPUT: boolean | null; FENCED: boolean | null; VARARGS: boolean | null;
        EXTERNALNAME: string | null; MEMORY: string | null; LOGMASK: string | null; VERSION: number | null; DESCRIPTION: string | null;
    }>(connection, sql);
    if (rows.length === 0) {
        throw new Error(`${kind === 'FUNCTION' ? 'Function' : 'Aggregate'} ${database}.${schema}.${objectName} not found`);
    }
    return rows.map(row => buildNetezzaRoutineDdl(database, schema, {
        kind,
        name: row.NAME,
        arguments: row.ARGUMENTS,
        returns: row.RETURNS,
        stateType: row.STATE,
        deterministic: row.DETERMINISTIC,
        returnsNullOnNullInput: row.RETURNSNULLONNULLINPUT,
        fenced: row.FENCED,
        varargs: row.VARARGS,
        externalName: row.EXTERNALNAME,
        memory: row.MEMORY,
        logMask: row.LOGMASK,
        version: row.VERSION,
        description: row.DESCRIPTION,
    })).join('\n\n');
}
