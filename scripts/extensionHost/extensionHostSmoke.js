const assert = require('node:assert/strict');
const fs = require('node:fs');
const vscode = require('vscode');

async function configureRegressionSettings() {
    const global = vscode.ConfigurationTarget.Global;
    const root = vscode.workspace.getConfiguration('justybase');
    const results = vscode.workspace.getConfiguration('justybase.results');
    await root.update('enableStreaming', true, global);
    await root.update('streamingChunkSize', 2, global);
    await root.update('safeExecute.enabled', false, global);
    await results.update('diskBackedResults.enabled', true, global);
    await results.update('diskBackedResults.rowThreshold', 4, global);
    await results.update('diskBackedResults.memoryRowThreshold', 4, global);
    await results.update('diskBackedResults.memoryByteThreshold', 1000000, global);
    await results.update('diskBackedResults.insertBatchSize', 2, global);
}

async function run() {
    const coreExtensionId = 'krzysztof-d.justybaselite-netezza';
    const coreExtension = vscode.extensions.getExtension(coreExtensionId);
    assert.ok(coreExtension, `Core extension '${coreExtensionId}' is not available in Extension Host.`);
    await coreExtension.activate();

    await configureRegressionSettings();
    const engine = process.env.JUSTYBASE_EXTENSION_HOST_ENGINE === 'netezza' ? 'netezza' : 'sqlite';
    const reportPath = process.env.JUSTYBASE_EXTENSION_HOST_REPORT_PATH;
    const tracePath = process.env.JUSTYBASE_EXTENSION_HOST_TRACE_PATH;
    const report = await vscode.commands.executeCommand('justybase.test.extensionHostScenario', { engine });

    assert.ok(report && typeof report === 'object', 'Extension Host scenario returned no report.');
    assert.equal(report.status, 'passed');
    assert.equal(report.engine, engine);
    assert.equal(report.scenarioId, 'extension-host-result-panel-sqlite-netezza');
    assert.ok(typeof report.sourceUri === 'string' && report.sourceUri.length > 0);
    assert.match(report.sourceUri, /^sha256:[0-9a-f]{64}$/u, 'Report source must be a stable fingerprint.');
    assert.ok(report.resultSetCount >= 2, 'Scenario must include Logs and tabular results.');
    assert.ok(report.rowCounts.includes(12), 'Scenario report must include the deterministic 12-row result.');
    assert.equal(report.pendingRequestCount, 0, 'Scenario must finish without host bridge requests.');
    assert.equal(report.activeCommandCount, 0, 'Scenario must finish without registered streaming commands.');
    assert.equal(report.executingSourceCount, 0, 'Scenario must finish without executing result sources.');
    assert.equal(report.streamingResultCount, 0, 'Scenario must finish without tracked streaming results.');
    assert.equal(report.streamingTransportCount, 0, 'Scenario must finish without transport cursors.');
    assert.equal(report.pendingResultSyncCount, 0, 'Scenario must finish without deferred result synchronization.');
    assert.equal(
        report.untitledLanguageLifecyclePassed,
        true,
        'Two parallel Plain Text -> SQL untitled tabs must execute and render distinct scalar results.',
    );
    assert.ok(report.hostResponses.includes('testBridge'), 'Host must send test bridge messages.');
    assert.ok(report.hostRequests.includes('requestDatabaseFilterValues'), 'Host must receive database filter requests.');
    assert.ok(report.hostRequests.includes('applyDatabaseFilter'), 'Host must receive database filter apply requests.');
    assert.ok(report.hostRequests.includes('requestDatabaseAggregations'), 'Host must receive database aggregation requests.');
    assert.ok(report.hostRequests.includes('requestDatabaseGrouping'), 'Host must receive grouping requests.');
    assert.ok(report.hostRequests.includes('diskQuery'), 'Host must receive disk-backed query requests.');
    assert.ok(report.hostRequests.includes('export'), 'Host must receive export requests.');
    assert.ok(report.hostResponses.includes('databaseFilterValuesResult'), 'Host must send database filter values responses.');
    assert.ok(report.hostResponses.includes('databaseFilterApplyResult'), 'Host must send database filter apply responses.');
    assert.ok(report.hostResponses.includes('databaseAggregationResult'), 'Host must send database aggregation responses.');
    assert.ok(report.hostResponses.includes('databaseGroupingResult'), 'Host must send database grouping responses.');
    assert.ok(report.hostResponses.includes('appendRows'), 'Host must confirm appendRows delivery.');
    assert.ok(report.webviewPhases.includes('webview.hydrate_applied'), 'Webview must apply a source-specific hydrate.');
    assert.ok(report.webviewPhases.includes('webview.append_applied'), 'Webview must apply streamed rows.');
    assert.ok(report.webviewPhases.includes('webview.test_bridge_received'), 'Webview must receive bridge requests.');
    assert.ok(report.webviewPhases.includes('webview.test_bridge_result_sent'), 'Webview must send bridge responses.');
    if (reportPath) {
        assert.ok(fs.existsSync(reportPath), 'Extension Host report JSON was not written.');
    }
    if (tracePath) {
        assert.ok(fs.existsSync(tracePath), 'Extension Host trace JSON was not written.');
        const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
        assert.ok(Array.isArray(trace), 'Extension Host trace must be an array.');
        for (const event of trace) {
            assert.equal(event.error, undefined, 'Sanitized trace must not persist raw errors.');
            assert.equal(event.sql, undefined, 'Sanitized trace must not persist SQL.');
            assert.equal(event.rows, undefined, 'Sanitized trace must not persist rows.');
            if (event.sourceUri !== undefined) {
                assert.match(event.sourceUri, /^sha256:[0-9a-f]{64}$/u, 'Trace source must be a stable fingerprint.');
            }
        }
    }

    console.log(JSON.stringify({
        type: 'extension-host-result-panel',
        engine: report.engine,
        scenarioId: report.scenarioId,
        resultSetCount: report.resultSetCount,
        rowCounts: report.rowCounts,
        tracePhaseCount: report.webviewPhases.length,
    }));
}

module.exports = { run };
