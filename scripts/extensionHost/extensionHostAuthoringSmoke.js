const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { requestScreenshot } = require('./extensionHostScreenshot');

const SCENARIO_ID = 'extension-host-sql-authoring';
const SCENARIO_NAMES = Object.freeze([
    'editor-lifecycle',
    'navigation-refactoring',
    'command-settings',
]);

function fingerprint(value) {
    return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function writeReport(report) {
    const reportPath = process.env.JUSTYBASE_EXTENSION_HOST_REPORT_PATH;
    if (!reportPath) return;
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function namesOfSymbols(symbols) {
    return (Array.isArray(symbols) ? symbols : [])
        .map(symbol => symbol && typeof symbol.name === 'string' ? symbol.name : '')
        .filter(Boolean);
}

async function run() {
    const startedAt = Date.now();
    const coreExtensionId = 'krzysztof-d.justybaselite-netezza';
    const coreExtension = vscode.extensions.getExtension(coreExtensionId);
    assert.ok(coreExtension, `Core extension '${coreExtensionId}' is not available in Extension Host.`);
    await coreExtension.activate();

    const sql = [
        'WITH orders AS (',
        '    SELECT 1 AS order_id, 25 AS total',
        ')',
        'SELECT o.order_id, o.total',
        'FROM orders o',
        'WHERE o.total > 10',
        'GROUP BY o.order_id, o.total;',
    ].join('\n');
    const plainTextDocument = await vscode.workspace.openTextDocument({ language: 'plaintext', content: sql });
    assert.equal(plainTextDocument.languageId, 'plaintext');
    const document = await vscode.languages.setTextDocumentLanguage(plainTextDocument, 'sql');
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    assert.equal(document.languageId, 'sql');
    assert.equal(editor.document.uri.toString(), document.uri.toString());
    await requestScreenshot('01-sql-editor');

    const scenarioReports = [];

    const symbols = await vscode.commands.executeCommand(
        'vscode.executeDocumentSymbolProvider',
        document.uri,
    );
    const symbolNames = namesOfSymbols(symbols);
    assert.ok(symbolNames.length > 0, 'SQL document symbols were not returned.');
    assert.ok(symbolNames.some(name => name.toLowerCase().includes('orders')), 'CTE symbol was not returned.');

    const formatEdits = await vscode.commands.executeCommand(
        'vscode.executeFormatDocumentProvider',
        document.uri,
        { tabSize: 4, insertSpaces: true },
    );
    assert.ok(Array.isArray(formatEdits) && formatEdits.length > 0, 'SQL formatter did not return an edit.');
    assert.ok(
        formatEdits.some(edit => typeof edit?.newText === 'string' && edit.newText.length > 0),
        'SQL formatter returned an empty edit.',
    );

    const semanticTokens = await vscode.commands.executeCommand(
        'justybase.test.semanticTokens',
        document.uri,
    );
    assert.ok(
        semanticTokens && semanticTokens.data && semanticTokens.data.length > 0,
        'SQL semantic tokens were not returned.',
    );
    scenarioReports.push({
        name: SCENARIO_NAMES[0],
        checks: ['plain-text-to-sql', 'symbols', 'formatting', 'semantic-tokens'],
    });

    const ordersReferenceOffset = sql.indexOf('orders o');
    assert.ok(ordersReferenceOffset >= 0, 'Authoring fixture is missing the orders reference.');
    const ordersPosition = document.positionAt(ordersReferenceOffset);

    const references = await vscode.commands.executeCommand(
        'vscode.executeReferenceProvider',
        document.uri,
        ordersPosition,
        { includeDeclaration: true },
    );
    assert.ok(Array.isArray(references) && references.length >= 2, 'SQL reference provider returned too few locations.');

    const hover = await vscode.commands.executeCommand(
        'vscode.executeHoverProvider',
        document.uri,
        ordersPosition,
    );
    assert.ok(Array.isArray(hover) && hover.length > 0, 'SQL hover provider returned no hover.');

    const rename = await vscode.commands.executeCommand(
        'vscode.executeDocumentRenameProvider',
        document.uri,
        ordersPosition,
        'customer_orders',
    );
    assert.ok(rename && typeof rename.entries === 'function', 'SQL rename provider returned no WorkspaceEdit.');
    const renameEntries = rename.entries();
    const renameEditCount = renameEntries.reduce(
        (count, [, edits]) => count + (Array.isArray(edits) ? edits.length : 0),
        0,
    );
    assert.ok(renameEditCount >= 2, 'SQL rename provider returned too few edits.');
    await requestScreenshot('02-sql-navigation');
    scenarioReports.push({
        name: SCENARIO_NAMES[1],
        checks: ['references', 'hover', 'rename'],
    });

    const registeredCommands = new Set(await vscode.commands.getCommands(true));
    for (const command of [
        'netezza.runQuery',
        'netezza.runQueryBatch',
        'netezza.openSettings',
        'netezza.newSqlTabWithContext',
        'netezza.results.focus',
    ]) {
        assert.ok(registeredCommands.has(command), `Core command '${command}' is not registered.`);
    }

    const signatureSql = 'SELECT COUNT(';
    const signatureDocument = await vscode.workspace.openTextDocument({ language: 'sql', content: signatureSql });
    const signature = await vscode.commands.executeCommand(
        'vscode.executeSignatureHelpProvider',
        signatureDocument.uri,
        signatureDocument.positionAt(signatureSql.length),
        '(',
    );
    assert.ok(signature && Array.isArray(signature.signatures) && signature.signatures.length > 0, 'SQL signature help was not returned.');

    await vscode.commands.executeCommand('netezza.openSettings');
    await sleep(500);
    await requestScreenshot('03-settings');
    scenarioReports.push({
        name: SCENARIO_NAMES[2],
        checks: ['command-registry', 'signature-help', 'settings-webview'],
    });

    const report = {
        scenarioId: SCENARIO_ID,
        status: 'passed',
        sourceUri: fingerprint(document.uri.toString()),
        scenarioCount: scenarioReports.length,
        scenarios: scenarioReports,
        checks: scenarioReports.flatMap(scenario => scenario.checks),
        durationMs: Date.now() - startedAt,
    };
    writeReport(report);
    console.log(JSON.stringify({
        type: 'extension-host-authoring',
        scenarioId: SCENARIO_ID,
        scenarioCount: report.scenarioCount,
        checkCount: report.checks.length,
        durationMs: report.durationMs,
    }));
}

module.exports = { run };
