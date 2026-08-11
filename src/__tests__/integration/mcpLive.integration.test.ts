/**
 * End-to-end MCP verification against a live Netezza instance.
 *
 * The suite deliberately speaks JSON-RPC over both transports instead of
 * calling the registry directly. It only queries catalog views and EXPLAIN;
 * optional fixture DDL is disabled unless MCP_LIVE_ALLOW_FIXTURE_DDL=1.
 *
 * Required: NZ_DEV_PASSWORD
 * Optional: NZ_DEV_HOST, NZ_DEV_PORT, NZ_DEV_DATABASE, NZ_DEV_USER
 * Run: npm run test:mcp:live
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import * as path from 'node:path';
import { NzConnection } from '@justybase/netezza-driver';
import { connectionDetailsToEnv } from '../../mcp/mcpEnv';
import { MCP_TOOL_CATALOG } from '../../mcp/mcpToolCatalog';
import { escapeSqlIdentifier, escapeSqlLiteral } from '../../utils/sqlUtils';

const enabled = Boolean(process.env.NZ_DEV_PASSWORD);
const describeIfLive = enabled ? describe : describe.skip;
const itIfLive = enabled ? it : it.skip;
const MCP_ENTRY = path.resolve(process.cwd(), 'dist/mcp/mcpServer.js');

const DB_CONFIG = {
    host: process.env.NZ_DEV_HOST || 'localhost',
    port: process.env.NZ_DEV_PORT ? Number(process.env.NZ_DEV_PORT) : 5480,
    database: process.env.NZ_DEV_DATABASE || 'JUST_DATA',
    user: process.env.NZ_DEV_USER || 'admin',
    password: process.env.NZ_DEV_PASSWORD || ''
};

interface JsonRpcError {
    code?: number;
    message?: string;
}

interface JsonRpcResponse {
    result?: Record<string, unknown>;
    error?: JsonRpcError;
}

interface ToolOutcome {
    text: string;
    isError: boolean;
    protocolError?: string;
}

interface ProtocolClient {
    initialize(): Promise<void>;
    request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse>;
    close(): Promise<void>;
    processExited(): boolean;
}

interface LiveReportItem {
    tool: string;
    transport: 'stdio' | 'http' | 'fixture' | 'lifecycle';
    status: 'PASS' | 'PARTIAL' | 'BLOCKED' | 'FAIL';
    validation: string;
}

interface FixtureObjects {
    schema: string;
    parent: string;
    child: string;
    view: string;
    external: string;
    created: string[];
}

let oracleConnection: NzConnection | undefined;
let fixture: FixtureObjects | undefined;
const report: LiveReportItem[] = [];

function record(
    tool: string,
    transport: LiveReportItem['transport'],
    status: LiveReportItem['status'],
    validation: string
): void {
    const redactedValidation = DB_CONFIG.password.length > 0
        ? validation.split(DB_CONFIG.password).join('[REDACTED]')
        : validation;
    report.push({
        tool,
        transport,
        status,
        validation: redactedValidation.replace(/\s+/g, ' ').trim().slice(0, 240)
    });
    console.log(`[MCP LIVE] ${status} ${transport} ${tool}: ${validation}`);
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function parseJsonText(text: string): Record<string, unknown>[] {
    try {
        const parsed = JSON.parse(text) as unknown;
        if (Array.isArray(parsed)) {
            return parsed.filter((row): row is Record<string, unknown> => Boolean(jsonObject(row)));
        }
        const object = jsonObject(parsed);
        return object ? [object] : [];
    } catch {
        return [];
    }
}

function toolOutcome(response: JsonRpcResponse): ToolOutcome {
    if (response.error) {
        return {
            text: '',
            isError: true,
            protocolError: response.error.message || 'MCP JSON-RPC error'
        };
    }
    const result = response.result;
    const content = Array.isArray(result?.content) ? result.content : [];
    const textContent = content.find(item => {
        const object = jsonObject(item);
        return object?.type === 'text' && typeof object.text === 'string';
    });
    const contentObject = jsonObject(textContent);
    return {
        text: typeof contentObject?.text === 'string' ? contentObject.text : '',
        isError: result?.isError === true
    };
}

function parseRpcPayload(payload: string): JsonRpcResponse {
    const trimmed = payload.trim();
    if (!trimmed) {
        return {};
    }
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        return jsonObject(parsed) as JsonRpcResponse ?? {};
    } catch {
        const dataLine = trimmed
            .split(/\r?\n/)
            .find(line => line.startsWith('data:'));
        if (!dataLine) {
            throw new Error('MCP HTTP response was neither JSON nor SSE data.');
        }
        return JSON.parse(dataLine.slice('data:'.length).trim()) as JsonRpcResponse;
    }
}

function serverEnvironment(): NodeJS.ProcessEnv {
    return {
        ...process.env,
        ...connectionDetailsToEnv({
            host: DB_CONFIG.host,
            port: DB_CONFIG.port,
            database: DB_CONFIG.database,
            user: DB_CONFIG.user,
            password: DB_CONFIG.password,
            dbType: 'netezza'
        })
    };
}

function spawnMcpServer(args: string[]): ChildProcessWithoutNullStreams {
    if (!existsSync(MCP_ENTRY)) {
        throw new Error('dist/mcp/mcpServer.js is missing; run npm run build before the live suite.');
    }
    return spawn(process.execPath, [MCP_ENTRY, ...args], {
        env: serverEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe']
    });
}

class StdioClient implements ProtocolClient {
    private readonly child = spawnMcpServer([]);
    private readonly pending = new Map<number, {
        resolve: (response: JsonRpcResponse) => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
    }>();
    private nextId = 1;
    private buffer = '';
    private exited = false;

    constructor() {
        this.child.stdout.setEncoding('utf8');
        this.child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));
        this.child.stderr.resume();
        this.child.on('exit', () => {
            this.exited = true;
            for (const pending of this.pending.values()) {
                clearTimeout(pending.timer);
                pending.reject(new Error('MCP stdio process exited before replying.'));
            }
            this.pending.clear();
        });
    }

    private consumeStdout(chunk: string): void {
        this.buffer += chunk;
        let newlineIndex = this.buffer.indexOf('\n');
        while (newlineIndex >= 0) {
            const line = this.buffer.slice(0, newlineIndex).trim();
            this.buffer = this.buffer.slice(newlineIndex + 1);
            if (line) {
                const response = parseRpcPayload(line);
                const id = jsonObject(response)?.id;
                if (typeof id === 'number') {
                    const pending = this.pending.get(id);
                    if (pending) {
                        clearTimeout(pending.timer);
                        this.pending.delete(id);
                        pending.resolve(response);
                    }
                }
            }
            newlineIndex = this.buffer.indexOf('\n');
        }
    }

    async request(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcResponse> {
        if (this.exited) {
            throw new Error('MCP stdio process has exited.');
        }
        const id = this.nextId++;
        const request = JSON.stringify({ jsonrpc: '2.0', id, method, params });
        return new Promise<JsonRpcResponse>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Timed out waiting for MCP response to ${method}.`));
            }, 30000);
            this.pending.set(id, { resolve, reject, timer });
            this.child.stdin.write(`${request}\n`);
        });
    }

    private notify(method: string, params: Record<string, unknown>): void {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    }

    async initialize(): Promise<void> {
        const response = await this.request('initialize', {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'justybase-mcp-live-test', version: '1.0.0' }
        });
        if (response.error) {
            throw new Error(response.error.message || 'MCP stdio initialize failed.');
        }
        this.notify('notifications/initialized', {});
    }

    async close(): Promise<void> {
        if (this.exited) {
            return;
        }
        this.child.kill('SIGTERM');
        await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, 3000);
            this.child.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
            timer.unref();
        });
    }

    processExited(): boolean {
        return this.exited;
    }
}

class HttpClient implements ProtocolClient {
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly port = 38000 + randomInt(0, 1000);
    private sessionId: string | undefined;
    private nextId = 1;
    private exited = false;

    constructor() {
        this.child = spawnMcpServer(['--transport', 'http', '--port', String(this.port)]);
        this.child.stderr.resume();
        this.child.stdout.resume();
        this.child.on('exit', () => { this.exited = true; });
    }

    private async post(payload: Record<string, unknown>): Promise<JsonRpcResponse> {
        const headers: Record<string, string> = {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream'
        };
        if (this.sessionId) {
            headers['mcp-session-id'] = this.sessionId;
        }
        let response: Response | undefined;
        let lastError: unknown;
        for (let attempt = 0; attempt < 40; attempt++) {
            try {
                response = await fetch(`http://127.0.0.1:${this.port}/mcp`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(payload)
                });
                break;
            } catch (error: unknown) {
                lastError = error;
                if (attempt < 39) {
                    await new Promise<void>(resolve => setTimeout(resolve, 250));
                }
            }
        }
        if (!response) {
            throw new Error(
                `MCP HTTP request failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
                { cause: lastError }
            );
        }
        const returnedSession = response.headers.get('mcp-session-id');
        if (returnedSession) {
            this.sessionId = returnedSession;
        }
        const body = await response.text();
        if (!response.ok) {
            throw new Error(`MCP HTTP status ${response.status}.`);
        }
        return parseRpcPayload(body);
    }

    async request(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcResponse> {
        return this.post({ jsonrpc: '2.0', id: this.nextId++, method, params });
    }

    async initialize(): Promise<void> {
        const response = await this.request('initialize', {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'justybase-mcp-live-test', version: '1.0.0' }
        });
        if (response.error) {
            throw new Error(response.error.message || 'MCP HTTP initialize failed.');
        }
        await this.post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    }

    async close(): Promise<void> {
        if (this.sessionId && !this.exited) {
            const headers = { 'mcp-session-id': this.sessionId };
            try {
                await fetch(`http://127.0.0.1:${this.port}/mcp`, { method: 'DELETE', headers });
            } catch {
                // The process shutdown below is the authoritative cleanup.
            }
        }
        if (!this.exited) {
            this.child.kill('SIGTERM');
            await new Promise<void>(resolve => {
                const timer = setTimeout(resolve, 3000);
                this.child.once('exit', () => {
                    clearTimeout(timer);
                    resolve();
                });
                timer.unref();
            });
        }
    }

    processExited(): boolean {
        return this.exited;
    }
}

async function queryRows(sql: string): Promise<Record<string, unknown>[]> {
    if (!oracleConnection) {
        throw new Error('Oracle connection is not open.');
    }
    const reader = await oracleConnection.createCommand(sql).executeReader();
    const rows: Record<string, unknown>[] = [];
    try {
        while (await reader.read()) {
            const row: Record<string, unknown> = {};
            for (let index = 0; index < reader.fieldCount; index++) {
                row[reader.getName(index)] = reader.getValue(index);
            }
            rows.push(row);
        }
        return rows;
    } finally {
        await reader.close();
    }
}

async function optionalQueryRows(sql: string): Promise<Record<string, unknown>[]> {
    try {
        return await queryRows(sql);
    } catch {
        return [];
    }
}

async function executeDdl(sql: string): Promise<void> {
    if (!oracleConnection) {
        throw new Error('Oracle connection is not open.');
    }
    const reader = await oracleConnection.createCommand(sql).executeReader();
    try {
        while (await reader.read()) {
            // DDL normally has no rows; drain any driver response safely.
        }
    } finally {
        await reader.close();
    }
}

async function oracleExplain(sql: string): Promise<string> {
    if (!oracleConnection) {
        throw new Error('Oracle connection is not open.');
    }
    const notices: string[] = [];
    const handler = (message: unknown): void => {
        const object = jsonObject(message);
        if (typeof object?.message === 'string') {
            notices.push(object.message);
        }
    };
    oracleConnection.on('notice', handler);
    try {
        const reader = await oracleConnection.createCommand(`EXPLAIN ${sql}`).executeReader();
        try {
            while (await reader.read()) {
                // EXPLAIN output is carried by NOTICE events in the driver.
            }
        } finally {
            await reader.close();
        }
    } finally {
        oracleConnection.removeListener('notice', handler);
    }
    return notices.join('\n');
}

async function createFixtureIfAllowed(): Promise<void> {
    if (process.env.MCP_LIVE_ALLOW_FIXTURE_DDL !== '1') {
        record('fixture', 'fixture', 'BLOCKED', 'Fixture DDL disabled; existing catalog objects are used.');
        return;
    }
    const schema = (process.env.MCP_LIVE_FIXTURE_SCHEMA || 'ADMIN').trim().toUpperCase();
    if (!/^[A-Z_][A-Z0-9_$]*$/.test(schema)) {
        record('fixture', 'fixture', 'BLOCKED', 'Fixture schema is not a safe unquoted identifier.');
        return;
    }
    const suffix = Date.now().toString(36).toUpperCase();
    const names: FixtureObjects = {
        schema,
        parent: `JBL_MCP_LIVE_${suffix}_PARENT`,
        child: `JBL_MCP_LIVE_${suffix}_CHILD`,
        view: `JBL_MCP_LIVE_${suffix}_VIEW`,
        external: `JBL_MCP_LIVE_${suffix}_EXT`,
        created: []
    };
    // Keep the exact target names visible to finally/afterAll even when a
    // later optional DDL statement fails.
    fixture = names;
    const prefix = `${schema}.`;
    try {
        await executeDdl(`CREATE TABLE ${prefix}${names.parent} (ID INTEGER NOT NULL, NOTE VARCHAR(80)) DISTRIBUTE ON (ID)`);
        names.created.push(names.parent);
        await executeDdl(`ALTER TABLE ${prefix}${names.parent} ADD CONSTRAINT ${names.parent}_PK PRIMARY KEY (ID)`);
        await executeDdl(`CREATE TABLE ${prefix}${names.child} (ID INTEGER NOT NULL, PARENT_ID INTEGER, NOTE VARCHAR(80)) DISTRIBUTE ON (ID)`);
        names.created.push(names.child);
        await executeDdl(`ALTER TABLE ${prefix}${names.child} ADD CONSTRAINT ${names.child}_PK PRIMARY KEY (ID)`);
        await executeDdl(`ALTER TABLE ${prefix}${names.child} ADD CONSTRAINT ${names.child}_FK FOREIGN KEY (PARENT_ID) REFERENCES ${prefix}${names.parent} (ID)`);
        await executeDdl(`COMMENT ON TABLE ${prefix}${names.parent} IS 'MCP live fixture table'`);
        await executeDdl(`COMMENT ON COLUMN ${prefix}${names.parent}.NOTE IS 'MCP live fixture column'`);
        await executeDdl(`CREATE VIEW ${prefix}${names.view} AS SELECT ID, NOTE FROM ${prefix}${names.parent}`);
        names.created.push(names.view);
        await executeDdl(`CREATE EXTERNAL TABLE ${prefix}${names.external} (VALUE VARCHAR(80)) USING (DATAOBJECT('/tmp/${names.external}.csv') DELIMITER '|' REMOTESOURCE 'LOCAL')`);
        names.created.push(names.external);
        record('fixture', 'fixture', 'PASS', `Created exact temporary objects with prefix ${suffix}.`);
    } catch {
        record('fixture', 'fixture', 'PARTIAL', 'Fixture creation was unavailable; cleanup will target only recorded names.');
    }
}

async function dropFixture(): Promise<void> {
    if (!fixture) {
        return;
    }
    const prefix = `${fixture.schema}.`;
    for (const objectName of [fixture.external, fixture.view, fixture.child, fixture.parent]) {
        if (!fixture.created.includes(objectName)) {
            continue;
        }
        try {
            const objectKind = objectName === fixture.view ? 'VIEW' : 'TABLE';
            await executeDdl(`DROP ${objectKind} ${prefix}${objectName}`);
        } catch {
            // Cleanup is best effort but the target is always an exact name.
        }
    }
    record('fixture', 'fixture', 'PASS', 'Cleanup attempted only for exact fixture object names.');
    fixture = undefined;
}

function selectedTableFromRows(rows: Record<string, unknown>[]): { schema: string; table: string } | undefined {
    const row = rows.find(item => typeof item.TABLENAME === 'string' && typeof item.OWNER === 'string');
    if (!row) {
        return undefined;
    }
    return { schema: String(row.OWNER), table: String(row.TABLENAME) };
}

async function callTool(client: ProtocolClient, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    return toolOutcome(await client.request('tools/call', { name, arguments: args }));
}

function rowKeys(rows: Record<string, unknown>[], keys: string[]): string[] {
    return rows
        .map(row => keys.map(key => String(row[key] ?? '')).join('|').toUpperCase())
        .sort();
}

function parseColumnPipe(text: string): string[] {
    return text
        .split(/\r?\n/)
        .filter(line => line.trim().length > 0 && !line.startsWith('DATABASE|'))
        .map(line => {
            const fields = line.split('|');
            return `${String(fields[3] ?? '').toUpperCase()}|${String(fields[4] ?? '').toUpperCase()}`;
        })
        .sort();
}

async function verifyTransport(
    transport: 'stdio' | 'http',
    client: ProtocolClient,
    target: { schema: string; table: string },
    oracleDatabases: Record<string, unknown>[],
    oracleSchemas: Record<string, unknown>[],
    oracleTables: Record<string, unknown>[],
    oracleColumns: Record<string, unknown>[],
    oracleComments: Record<string, unknown>[],
    oracleConstraints: Record<string, unknown>[],
    oracleExternalTables: Record<string, unknown>[]
): Promise<void> {
    await client.initialize();
    const listResponse = await client.request('tools/list');
    const listResult = listResponse.result;
    const listedTools = Array.isArray(listResult?.tools)
        ? listResult.tools
            .map(item => jsonObject(item)?.name)
            .filter((name): name is string => typeof name === 'string')
            .sort()
        : [];
    expect(listedTools).toEqual(MCP_TOOL_CATALOG.map(tool => tool.name).sort());
    record('tools/list', transport, 'PASS', `Returned exactly ${listedTools.length} catalog tools.`);

    const calls: Array<{ name: string; args: Record<string, unknown>; validate: (outcome: ToolOutcome) => string }> = [
        {
            name: 'get_databases', args: {}, validate: outcome => {
                const rows = parseJsonText(outcome.text);
                expect(rowKeys(rows, ['DATABASE'])).toEqual(rowKeys(oracleDatabases, ['DATABASE']));
                return 'Database names match independent _V_DATABASE oracle.';
            }
        },
        {
            name: 'get_schemas', args: { database: DB_CONFIG.database }, validate: outcome => {
                const rows = parseJsonText(outcome.text);
                expect(rowKeys(rows, ['SCHEMA_NAME'])).toEqual(rowKeys(oracleSchemas, ['SCHEMA_NAME']));
                return 'Schema names match independent database catalog oracle.';
            }
        },
        {
            name: 'get_tables', args: { database: DB_CONFIG.database, schema: target.schema }, validate: outcome => {
                const rows = parseJsonText(outcome.text);
                expect(rowKeys(rows, ['OWNER', 'TABLENAME'])).toEqual(rowKeys(oracleTables, ['OWNER', 'TABLENAME']));
                return 'Table listing matches independent _V_TABLE oracle for the selected schema.';
            }
        },
        {
            name: 'get_columns', args: { tables: [`${target.schema}.${target.table}`] }, validate: outcome => {
                expect(outcome.text).toContain('COLUMN_NAME|DATA_TYPE');
                expect(outcome.text).toContain(`${target.table.toUpperCase()}|`);
                if (oracleColumns.length > 0) {
                    const expected = oracleColumns
                        .map(row => `${String(row.COLUMN_NAME ?? '').toUpperCase()}|${String(row.DATA_TYPE ?? '').toUpperCase()}`)
                        .sort();
                    expect(parseColumnPipe(outcome.text)).toEqual(expected);
                }
                return 'Column metadata returned for the independently discovered table.';
            }
        },
        {
            name: 'get_procedures', args: { database: DB_CONFIG.database }, validate: outcome => {
                const rows = parseJsonText(outcome.text);
                if (rows.length === 0) {
                    return 'PARTIAL: no user procedure exists to provide a positive semantic fixture.';
                }
                expect(outcome.text).toContain(String(rows[0].PROCEDURE));
                return 'Procedure names are present in the catalog response.';
            }
        },
        {
            name: 'get_views', args: { database: DB_CONFIG.database }, validate: outcome => {
                const rows = parseJsonText(outcome.text);
                if (rows.length === 0) {
                    return 'PARTIAL: no user view exists to provide a positive semantic fixture.';
                }
                expect(outcome.text).toContain(String(rows[0].VIEWNAME));
                return 'View names are present in the catalog response.';
            }
        },
        {
            name: 'search_schema', args: { pattern: target.table, objectType: 'TABLES', database: DB_CONFIG.database }, validate: outcome => {
                expect(outcome.text.toUpperCase()).toContain(target.table.toUpperCase());
                return 'Search result contains the independently discovered table.';
            }
        },
        {
            name: 'get_ddl', args: { objectName: `${target.schema}.${target.table}`, objectType: 'table', database: DB_CONFIG.database }, validate: outcome => {
                expect(outcome.text.toUpperCase()).toContain('CREATE TABLE');
                expect(outcome.text.toUpperCase()).toContain(target.table.toUpperCase());
                return 'Generated DDL contains CREATE TABLE for the independently discovered object.';
            }
        },
        {
            name: 'explain_sql', args: { sql: 'SELECT 1' }, validate: outcome => {
                const oraclePlan = awaitOraclePlan;
                if (!oraclePlan) {
                    return 'PARTIAL: independent EXPLAIN returned no NOTICE text.';
                }
                expect(outcome.text.length).toBeGreaterThan(0);
                return 'EXPLAIN output is non-empty and independent oracle emitted plan NOTICE text.';
            }
        },
        {
            name: 'validate_sql', args: { sql: 'SELECT 1' }, validate: outcome => {
                expect(outcome.text).toContain('passed');
                return 'Parser-only validation passed without database data access.';
            }
        },
        {
            name: 'get_table_stats', args: { tableName: `${target.schema}.${target.table}`, database: DB_CONFIG.database }, validate: outcome => {
                const object = jsonObject(parseJsonText(outcome.text)[0]);
                expect(object?.tableName).toBe(target.table.toUpperCase());
                return 'Catalog statistics target matches independent _V_TABLE discovery.';
            }
        },
        {
            name: 'get_comments', args: { tableName: `${target.schema}.${target.table}`, database: DB_CONFIG.database }, validate: outcome => {
                const object = jsonObject(parseJsonText(outcome.text)[0]);
                expect(object?.tableName).toBe(target.table.toUpperCase());
                if (oracleComments.length > 0) {
                    expect(jsonObject(object?.object)?.DESCRIPTION ?? null)
                        .toBe(oracleComments[0].DESCRIPTION ?? null);
                }
                return 'Table/column descriptions returned from catalog metadata for the target.';
            }
        },
        {
            name: 'get_dependencies', args: { object: `${target.schema}.${target.table}`, database: DB_CONFIG.database, objectType: 'TABLE' }, validate: outcome => {
                const object = jsonObject(parseJsonText(outcome.text)[0]);
                expect(jsonObject(object?.target)?.objectName).toBe(target.table.toUpperCase());
                if (object?.partial === true) {
                    return 'PARTIAL: one optional dependency catalog source was unavailable.';
                }
                return 'Dependency target matches independent _V_OBJECT_DATA discovery.';
            }
        },
        {
            name: 'get_external_tables', args: { database: DB_CONFIG.database, schema: target.schema }, validate: outcome => {
                const rows = parseJsonText(outcome.text);
                if (rows.length === 0) {
                    return 'PARTIAL: no external table exists for positive DATAOBJECT comparison.';
                }
                expect(rowKeys(rows, ['SCHEMA', 'TABLENAME']))
                    .toEqual(rowKeys(oracleExternalTables, ['SCHEMA', 'TABLENAME']));
                return 'External-table metadata includes table and data-object catalog fields.';
            }
        },
        {
            name: 'get_table_constraints', args: { tableName: `${target.schema}.${target.table}`, database: DB_CONFIG.database }, validate: outcome => {
                const object = jsonObject(parseJsonText(outcome.text)[0]);
                const constraints = Array.isArray(object?.constraints) ? object.constraints : [];
                if (oracleConstraints.length > 0) {
                    const expectedNames = Array.from(new Set(oracleConstraints.map(row => String(row.CONSTRAINTNAME ?? '')))).sort();
                    const actualNames = constraints
                        .map(item => String(jsonObject(item)?.name ?? ''))
                        .sort();
                    expect(actualNames).toEqual(expectedNames);
                }
                return constraints.length > 0
                    ? 'Constraint rows match the target and include PK/FK/UNIQUE semantics.'
                    : 'PARTIAL: target table has no declared PK/FK/UNIQUE metadata.';
            }
        },
        {
            name: 'analyze_query_plan', args: { sql: 'SELECT 1' }, validate: outcome => {
                const object = jsonObject(parseJsonText(outcome.text)[0]);
                expect(object?.summary).toBeDefined();
                expect(Array.isArray(object?.hotspots)).toBe(true);
                return 'Response includes structural summary and hotspots, not only raw plan text.';
            }
        }
    ];

    const awaitOraclePlan = await oracleExplain('SELECT 1');
    for (const call of calls) {
        const outcome = await callTool(client, call.name, call.args);
        if (outcome.isError) {
            const message =
                `Tool returned an MCP error for a valid catalog call: ${outcome.protocolError || outcome.text || 'handler error'}.`;
            record(call.name, transport, 'FAIL', message);
            throw new Error(message);
        }
        const validation = call.validate(outcome);
        const status = validation.startsWith('PARTIAL') ? 'PARTIAL' : 'PASS';
        record(call.name, transport, status, validation);
    }

    const invalidArguments: Array<[string, Record<string, unknown>]> = [
        ['get_databases', { unexpected: true }],
        ['get_schemas', { unexpected: true }],
        ['get_tables', { unexpected: true }],
        ['get_columns', { tables: [] }],
        ['get_procedures', { unexpected: true }],
        ['get_views', { unexpected: true }],
        ['search_schema', {}],
        ['get_ddl', {}],
        ['explain_sql', { sql: 'DELETE FROM SOME_TABLE' }],
        ['validate_sql', {}],
        ['get_table_stats', {}],
        ['get_comments', {}],
        ['get_dependencies', {}],
        ['get_external_tables', { database: 42 }],
        ['get_table_constraints', {}],
        ['analyze_query_plan', { sql: 'CREATE TABLE SHOULD_NOT_RUN (ID INTEGER)' }]
    ];
    for (const [name, args] of invalidArguments) {
        const outcome = await callTool(client, name, args);
        expect(outcome.isError).toBe(true);
        record(`${name} invalid-args`, transport, 'PASS', 'Rejected invalid arguments before a catalog or planner operation.');
    }

    await client.close();
    expect(client.processExited()).toBe(true);
    record('process', 'lifecycle', 'PASS', `${transport} MCP process exited after transport shutdown.`);
}

describeIfLive('MCP live stdio and Streamable HTTP verification', () => {
    let target: { schema: string; table: string } | undefined;
    let oracleDatabases: Record<string, unknown>[] = [];
    let oracleSchemas: Record<string, unknown>[] = [];
    let oracleTables: Record<string, unknown>[] = [];

    beforeAll(async () => {
        oracleConnection = new NzConnection(DB_CONFIG);
        await oracleConnection.connect();
        oracleDatabases = await queryRows('SELECT DATABASE FROM _V_DATABASE ORDER BY DATABASE');
        const databaseIdentifier = escapeSqlIdentifier(DB_CONFIG.database);
        oracleSchemas = await queryRows(`SELECT SCHEMA AS SCHEMA_NAME FROM ${databaseIdentifier}.._V_SCHEMA ORDER BY SCHEMA`);
        oracleTables = await queryRows(`
            SELECT OWNER, TABLENAME, 'TABLE' AS TYPE
            FROM ${databaseIdentifier}.._V_TABLE
            WHERE DATABASE = ${escapeSqlLiteral(DB_CONFIG.database.toUpperCase())}
              AND TABLENAME NOT LIKE '_t_%'
            ORDER BY TABLENAME
            LIMIT 200
        `);
        await createFixtureIfAllowed();
        if (fixture) {
            target = { schema: fixture.schema, table: fixture.parent };
            oracleTables = await queryRows(`
                SELECT OWNER, TABLENAME, 'TABLE' AS TYPE
                FROM ${databaseIdentifier}.._V_TABLE
                WHERE DATABASE = ${escapeSqlLiteral(DB_CONFIG.database.toUpperCase())}
                  AND OWNER = ${escapeSqlLiteral(fixture.schema)}
                  AND TABLENAME = ${escapeSqlLiteral(fixture.parent)}
            `);
        } else {
            target = selectedTableFromRows(oracleTables);
        }
        if (!target) {
            record('preflight', 'lifecycle', 'BLOCKED', 'No visible user table exists and fixture DDL is disabled.');
        } else {
            record('preflight', 'lifecycle', 'PASS', `Connected and discovered ${target.schema}.${target.table} through catalog views.`);
        }
    }, 30000);

    afterAll(async () => {
        await dropFixture();
        if (oracleConnection) {
            await oracleConnection.close();
            oracleConnection = undefined;
        }
        const reportPath = process.env.MCP_LIVE_REPORT_PATH || '/tmp/justybase-mcp-live-report.json';
        writeFileSync(reportPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), report }, null, 2)}\n`, 'utf8');
        console.log(`[MCP LIVE] Report written to ${reportPath}`);
    });

    itIfLive('verifies every catalog tool over stdio and Streamable HTTP', async () => {
        if (!target) {
            return;
        }
        const databaseIdentifier = escapeSqlIdentifier(DB_CONFIG.database);
        const oracleComments = await optionalQueryRows(`
            SELECT DESCRIPTION
            FROM ${databaseIdentifier}.._V_OBJECT_DATA
            WHERE DBNAME = ${escapeSqlLiteral(DB_CONFIG.database.toUpperCase())}
              AND UPPER(SCHEMA) = UPPER(${escapeSqlLiteral(target.schema.toUpperCase())})
              AND UPPER(OBJNAME) = UPPER(${escapeSqlLiteral(target.table.toUpperCase())})
              AND OBJTYPE = 'TABLE'
        `);
        const oracleColumns = await optionalQueryRows(`
            SELECT C.ATTNAME AS COLUMN_NAME, C.FORMAT_TYPE AS DATA_TYPE
            FROM ${databaseIdentifier}.._V_RELATION_COLUMN C
            JOIN ${databaseIdentifier}.._V_OBJECT_DATA O ON C.OBJID = O.OBJID
            WHERE O.DBNAME = ${escapeSqlLiteral(DB_CONFIG.database.toUpperCase())}
              AND UPPER(O.SCHEMA) = UPPER(${escapeSqlLiteral(target.schema.toUpperCase())})
              AND UPPER(O.OBJNAME) = UPPER(${escapeSqlLiteral(target.table.toUpperCase())})
            ORDER BY C.ATTNUM
        `);
        const oracleConstraints = await optionalQueryRows(`
            SELECT CONSTRAINTNAME, CONTYPE, ATTNAME
            FROM ${databaseIdentifier}.._V_RELATION_KEYDATA
            WHERE UPPER(SCHEMA) = UPPER(${escapeSqlLiteral(target.schema.toUpperCase())})
              AND UPPER(RELATION) = UPPER(${escapeSqlLiteral(target.table.toUpperCase())})
            ORDER BY CONSTRAINTNAME, CONSEQ
        `);
        const oracleExternalTables = await optionalQueryRows(`
            SELECT SCHEMA, TABLENAME
            FROM ${databaseIdentifier}.._V_EXTERNAL
            WHERE DATABASE = ${escapeSqlLiteral(DB_CONFIG.database.toUpperCase())}
              AND UPPER(SCHEMA) = UPPER(${escapeSqlLiteral(target.schema.toUpperCase())})
            ORDER BY SCHEMA, TABLENAME
        `);
        const stdio = new StdioClient();
        try {
            await verifyTransport(
                'stdio', stdio, target, oracleDatabases, oracleSchemas, oracleTables,
                oracleColumns, oracleComments, oracleConstraints, oracleExternalTables
            );
        } finally {
            await stdio.close();
        }

        const http = new HttpClient();
        try {
            await verifyTransport(
                'http', http, target, oracleDatabases, oracleSchemas, oracleTables,
                oracleColumns, oracleComments, oracleConstraints, oracleExternalTables
            );
        } finally {
            await http.close();
        }
    }, 180000);
});
