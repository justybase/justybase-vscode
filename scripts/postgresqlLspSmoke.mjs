#!/usr/bin/env node
/** Exercise the built PostgreSQL LSP over its real stdio protocol. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';

const child = spawn(process.execPath, ['dist/server/main.js', '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
let serverVersionNum = 160013;
const context = () => ({ connectionName: 'pg-smoke', databaseKind: 'postgresql', effectiveDatabase: 'testdb',
  effectiveSchema: 'public', serverVersionNum, searchPath: ['public'] });
const columns = [{ name: 'id', type: 'integer' }, { name: 'payload', type: 'text' }];
const pendingDiagnostics = new Map();
const checks = [];
connection.onRequest('netezza/getMetadata', params => {
  if (params.kind === 'context') return context();
  if (params.kind === 'cachedTableInfo' || params.kind === 'tableInfo') {
    return { database: 'testdb', schema: params.schema ?? 'public', table: params.table,
      exists: params.table === 'items', columns: params.table === 'items' ? columns : [], columnsComplete: true };
  }
  if (params.kind === 'columns') return columns;
  if (params.kind === 'databases') return [{ name: 'testdb' }];
  if (params.kind === 'schemas') return [{ name: 'public' }];
  if (params.kind === 'tables' || params.kind === 'sourceObjects') return [{ name: 'items', schema: 'public' }];
  return [];
});
connection.onRequest('workspace/configuration', params => params.items.map(() => ({})));
connection.onRequest('client/registerCapability', () => null);
connection.onNotification('textDocument/publishDiagnostics', params => {
  const pending = pendingDiagnostics.get(params.uri);
  if (pending && pending.predicate(params.diagnostics)) {
    pendingDiagnostics.delete(params.uri);
    pending.resolve(params.diagnostics);
  }
});
connection.onNotification(() => undefined);
connection.listen();

function deadline(promise, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out: ' + label)), 20000);
  })]).finally(() => clearTimeout(timer));
}
function diagnostics(uri, predicate) {
  return deadline(new Promise(resolve => pendingDiagnostics.set(uri, { resolve, predicate })), 'diagnostics');
}
async function open(uri, text) {
  const ready = diagnostics(uri, () => true);
  await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'sql', version: 1, text } });
  return ready;
}
async function request(method, params) { return deadline(connection.sendRequest(method, params), method); }

try {
  await request('initialize', { processId: process.pid, rootUri: null, capabilities: { workspace: { configuration: true } } });
  await connection.sendNotification('initialized', {});
  const uri = 'file:///postgresql-lsp-smoke.sql';
  const sql = 'CREATE FUNCTION f() RETURNS integer LANGUAGE sql AS $$ SELECT 1; $$;\nSELECT ARRAY[missing] FROM public.items;';
  const first = await open(uri, sql);
  assert.ok(first.some(issue => issue.code === 'SQL004'));
  assert.ok(!first.some(issue => issue.code === 'SQL001'));
  checks.push('dollar-body-and-metadata-diagnostics');

  const jsonSql = "SELECT * FROM JSON_TABLE('[{\"id\":1}]', '$[*]' COLUMNS(id integer PATH '$.id')) AS jt";
  const second = diagnostics(uri, issues => issues.some(issue => issue.code === 'PG001'));
  await connection.sendNotification('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: jsonSql }] });
  await second;
  checks.push('incremental-version-warning');
  serverVersionNum = 180000;
  const refreshed = diagnostics(uri, issues => !issues.some(issue => issue.code === 'PG001'));
  await connection.sendNotification('netezza/documentContextChanged', { documentUri: uri });
  await refreshed;
  checks.push('connection-context-invalidation');

  const completionUri = 'file:///postgresql-completion-smoke.sql';
  const text = 'WITH x(id) AS (VALUES (1)) SELECT x. FROM x';
  await open(completionUri, text);
  const completion = await request('textDocument/completion', { textDocument: { uri: completionUri },
    position: { line: 0, character: text.indexOf('x. FROM') + 2 } });
  const items = Array.isArray(completion) ? completion : completion.items;
  assert.ok(items.some(item => item.label === 'id'));
  checks.push('cte-completion');

  const hoverUri = 'file:///postgresql-hover-smoke.sql';
  await open(hoverUri, 'SELECT i.id FROM public.items i');
  const hover = await request('textDocument/hover', { textDocument: { uri: hoverUri }, position: { line: 0, character: 10 } });
  assert.ok(JSON.stringify(hover).includes('integer'));
  checks.push('metadata-hover');
  for (const documentUri of [uri, completionUri, hoverUri]) {
    await connection.sendNotification('textDocument/didClose', { textDocument: { uri: documentUri } });
  }
  console.log(JSON.stringify({ type: 'postgresql-lsp-smoke', status: 'passed', checks }));
} catch (error) {
  console.error(JSON.stringify({ type: 'postgresql-lsp-smoke', status: 'failed', checks }));
  console.error(error);
  process.exitCode = 1;
} finally {
  try { await request('shutdown'); await connection.sendNotification('exit'); } catch { /* Process may already have exited. */ }
  connection.dispose();
  child.kill();
}
