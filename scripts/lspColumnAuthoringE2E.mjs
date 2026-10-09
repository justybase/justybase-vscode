#!/usr/bin/env node
/**
 * End-to-end check of SQL column authoring through the real, built language
 * server (dist/server/main.js) over JSON-RPC on stdio. The client answers the
 * server's netezza/getMetadata requests the way the extension does, from a
 * small in-memory catalog. Run `npm run build` first.
 *
 * Covers: column hover (relation, origin, type), Definition, References,
 * prepareRename/rename of a local projection (including its own ORDER BY),
 * rename rejection on a physical column, the netezza/columnCatalogTarget
 * request used by Jump to Schema, a catalog target that must not exist, and
 * an incomplete statement.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = path.join(root, 'dist', 'server', 'main.js');

const CATALOG = {
  CUSTOMERS: [['CUSTOMER_ID', 'INTEGER'], ['CUSTOMER_NAME', 'VARCHAR(120)'], ['EMAIL', 'VARCHAR(255)']],
};
const metadataRequests = [];

const child = spawn(process.execPath, [serverPath, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
connection.onRequest('netezza/getMetadata', params => {
  metadataRequests.push(params);
  if (params.kind === 'context') return { connectionName: 'e2e', effectiveDatabase: 'JUST_DATA', databaseKind: 'netezza' };
  if (params.kind === 'tableInfo') {
    const columns = CATALOG[String(params.table).toUpperCase()];
    return columns
      ? { exists: true, table: String(params.table).toUpperCase(), database: 'JUST_DATA', schema: 'SALES', columns: columns.map(([name, type]) => ({ name, type })) }
      : { exists: false, table: params.table, columns: [] };
  }
  return [];
});
connection.onNotification(() => undefined);
connection.onRequest('client/registerCapability', () => null);
connection.onRequest('workspace/configuration', params => params.items.map(() => null));
connection.listen();

const positionOf = (text, needle, occurrence = 0, shift = 1) => {
  let offset = -1;
  for (let index = 0; index <= occurrence; index++) offset = text.indexOf(needle, offset + 1);
  assert.ok(offset >= 0, `missing ${needle}`);
  const before = text.slice(0, offset + shift);
  const lines = before.split('\n');
  return { line: lines.length - 1, character: lines[lines.length - 1].length };
};
const textOf = (text, range) => {
  const lines = text.split('\n');
  assert.equal(range.start.line, range.end.line);
  return lines[range.start.line].slice(range.start.character, range.end.character);
};

let version = 0;
async function open(uri, text) {
  connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'sql', version: ++version, text } });
  return text;
}

const checks = [];
async function check(name, run) {
  await run();
  checks.push(name);
}

try {
  await connection.sendRequest('initialize', { processId: process.pid, rootUri: null, capabilities: {}, initializationOptions: {} });
  connection.sendNotification('initialized', {});

  const uri = 'file:///e2e/columns.sql';
  const sql = await open(uri,
    'WITH X AS (SELECT CUSTOMER_ID AS CID FROM JUST_DATA.SALES.CUSTOMERS ORDER BY CID) SELECT X.CID, C.EMAIL, X.CID + 1 AS NEXT_ID FROM X JOIN JUST_DATA.SALES.CUSTOMERS C ON C.CUSTOMER_ID = X.CID');
  const doc = { uri };
  const xCid = positionOf(sql, 'X.CID', 0, 3);
  const email = positionOf(sql, 'C.EMAIL', 0, 3);

  await check('hover-local-projection', async () => {
    const hover = await connection.sendRequest('textDocument/hover', { textDocument: doc, position: xCid });
    const value = hover?.contents?.value ?? '';
    assert.match(value, /\*\*column\*\* `CID`/);
    assert.match(value, /CTE: `X`/);
    assert.match(value, /origin: `JUST_DATA\.SALES\.CUSTOMERS\.CUSTOMER_ID`/);
    assert.match(value, /type: `INTEGER`/);
  });

  await check('hover-physical', async () => {
    const hover = await connection.sendRequest('textDocument/hover', { textDocument: doc, position: email });
    assert.match(hover?.contents?.value ?? '', /type: `VARCHAR\(255\)`/);
  });

  await check('definition-and-references', async () => {
    const definition = await connection.sendRequest('textDocument/definition', { textDocument: doc, position: xCid });
    const location = Array.isArray(definition) ? definition[0] : definition;
    assert.equal(textOf(sql, location.range), 'CID');
    assert.equal(location.range.start.character, sql.indexOf('AS CID') + 3);
    const references = await connection.sendRequest('textDocument/references', {
      textDocument: doc, position: xCid, context: { includeDeclaration: true },
    });
    // Alias, the CTE's own ORDER BY, and three outer references.
    assert.equal(references.length, 5);
    assert.ok(references.every(reference => textOf(sql, reference.range) === 'CID'));
  });

  await check('rename-local-projection', async () => {
    const prepared = await connection.sendRequest('textDocument/prepareRename', { textDocument: doc, position: xCid });
    assert.equal(prepared?.placeholder, 'CID');
    const edit = await connection.sendRequest('textDocument/rename', { textDocument: doc, position: xCid, newName: 'KEY_ID' });
    const edits = edit?.changes?.[uri] ?? [];
    assert.equal(edits.length, 5);
    assert.ok(edits.every(change => change.newText === 'KEY_ID'));
  });

  await check('rename-physical-rejected', async () => {
    const prepared = await connection.sendRequest('textDocument/prepareRename', { textDocument: doc, position: email });
    assert.equal(prepared, null);
    const edit = await connection.sendRequest('textDocument/rename', { textDocument: doc, position: email, newName: 'MAIL' });
    assert.equal(edit, null);
  });

  await check('catalog-targets', async () => {
    const physical = await connection.sendRequest('netezza/columnCatalogTarget', { textDocument: doc, position: email });
    assert.deepEqual(physical, { database: 'JUST_DATA', schema: 'SALES', relation: 'CUSTOMERS', column: 'EMAIL', via: 'catalog' });
    const origin = await connection.sendRequest('netezza/columnCatalogTarget', { textDocument: doc, position: xCid });
    assert.deepEqual(origin, { database: 'JUST_DATA', schema: 'SALES', relation: 'CUSTOMERS', column: 'CUSTOMER_ID', via: 'origin' });
    const computed = await connection.sendRequest('netezza/columnCatalogTarget', {
      textDocument: doc, position: positionOf(sql, 'NEXT_ID', 0, 2),
    });
    assert.equal(computed, null);
  });

  await check('metadata-requests-bounded', async () => {
    const tables = new Set(metadataRequests.filter(request => request.kind === 'tableInfo').map(request => String(request.table).toUpperCase()));
    assert.deepEqual([...tables], ['CUSTOMERS']);
    assert.ok(!metadataRequests.some(request => ['tables', 'views', 'warmDatabaseColumns'].includes(request.kind)));
  });

  await check('incomplete-sql', async () => {
    const incompleteUri = 'file:///e2e/incomplete.sql';
    const text = await open(incompleteUri, 'SELECT C.EMAIL,\nFROM JUST_DATA.SALES.CUSTOMERS C\nWHERE C.EMAIL IS NOT NULL AND C.');
    const position = positionOf(text, 'C.EMAIL', 0, 3);
    const references = await connection.sendRequest('textDocument/references', {
      textDocument: { uri: incompleteUri }, position, context: { includeDeclaration: false },
    });
    assert.equal(references.length, 2);
    const hover = await connection.sendRequest('textDocument/hover', { textDocument: { uri: incompleteUri }, position });
    assert.match(hover?.contents?.value ?? '', /origin: `JUST_DATA\.SALES\.CUSTOMERS\.EMAIL`/);
    const unfinished = 'file:///e2e/unfinished.sql';
    const unfinishedText = await open(unfinished, 'SELECT CUSTOMER_ID FROM JUST_DATA.SALES.');
    const target = await connection.sendRequest('netezza/columnCatalogTarget', {
      textDocument: { uri: unfinished }, position: positionOf(unfinishedText, 'CUSTOMER_ID', 0, 2),
    });
    assert.equal(target, null);
  });

  console.log(JSON.stringify({ type: 'lsp-column-authoring-e2e', status: 'passed', checks }));
} catch (error) {
  console.error(JSON.stringify({ type: 'lsp-column-authoring-e2e', status: 'failed', passed: checks }));
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    await connection.sendRequest('shutdown');
    connection.sendNotification('exit');
  } catch { /* the server may already be gone */ }
  connection.dispose();
  child.kill();
}
