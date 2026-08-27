const assert = require('node:assert/strict');
const vscode = require('vscode');

async function run() {
    const coreExtensionId = 'krzysztof-d.justybaselite-netezza';
    const coreExtension = vscode.extensions.getExtension(coreExtensionId);
    assert.ok(coreExtension, `Core extension '${coreExtensionId}' is not available in Extension Host.`);

    await coreExtension.activate();
    const coldEditorResult = await vscode.commands.executeCommand(
        'justybase.test.resultPanelRegression',
        { mode: 'cold-editor-command' },
    );
    assert.ok(coldEditorResult?.first?.snapshot, 'First cold editor-command regression returned no snapshot.');
    assert.ok(coldEditorResult?.second?.snapshot, 'Reused untitled editor regression returned no snapshot.');
    const firstColdSnapshot = coldEditorResult.first.snapshot;
    const reusedColdSnapshot = coldEditorResult.second.snapshot;
    assert.ok(
        firstColdSnapshot.sourceUri.startsWith('untitled:'),
        'Cold editor-command regression must execute an untitled document.',
    );
    assert.equal(
        reusedColdSnapshot.sourceUri,
        firstColdSnapshot.sourceUri,
        'VS Code must reuse the untitled URI for the second lifecycle execution.',
    );
    for (const coldSnapshot of [firstColdSnapshot, reusedColdSnapshot]) {
        const coldLogs = coldSnapshot.resultSets.find(resultSet => resultSet.isLog === true);
        const coldData = coldSnapshot.resultSets.find(resultSet => !resultSet.isLog);
        assert.ok(coldLogs, 'Cold editor-command execution must deliver Logs.');
        assert.ok(coldData, 'Cold editor-command execution must deliver a terminal result.');
        if (coldEditorResult.hasLiveConnection) {
            assert.equal(coldData.rowCount, 1);
        }
    }

    const snapshot = await vscode.commands.executeCommand(
        'justybase.test.resultPanelRegression',
        { sourceUri: 'untitled:Untitled-1' },
    );

    assert.ok(snapshot && typeof snapshot === 'object', 'Regression command returned no snapshot.');
    assert.equal(snapshot.sourceUri, 'untitled:Untitled-1');
    assert.ok(Array.isArray(snapshot.resultSets), 'Snapshot must contain resultSets.');

    const logs = snapshot.resultSets.find(resultSet => resultSet.isLog === true);
    const data = snapshot.resultSets.find(resultSet => resultSet.isLog !== true);
    assert.ok(logs, 'Untitled scenario must create a Logs result set.');
    assert.equal(logs.index, 0, 'Logs must remain the first result set.');
    assert.ok(data, 'Untitled scenario must create a tabular result set.');
    assert.equal(data.rowCount, 2, 'The deterministic result must contain two rows.');
    assert.equal(data.totalRowCount, 2);
    assert.equal(data.isStreamingComplete, true);

    assert.ok(Array.isArray(snapshot.trace), 'Snapshot must contain the bounded trace.');
    assert.ok(snapshot.trace.some(event => event.phase === 'start_execution'));
    assert.ok(snapshot.trace.some(event => event.phase === 'append_streaming_chunk'));
    assert.ok(snapshot.trace.some(event => event.phase === 'finalize_execution'));

    const hydrateAppliedIndex = snapshot.trace.findIndex(event =>
        event.origin === 'webview'
        && event.phase === 'webview.hydrate_applied'
        && event.sourceUri === snapshot.sourceUri,
    );
    const rowsAppliedIndex = snapshot.trace.findIndex(event =>
        event.origin === 'webview'
        && event.phase === 'webview.append_applied'
        && event.sourceUri === snapshot.sourceUri
        && event.resultSetIndex === 1
        && event.totalRows === 2,
    );
    const streamingCompleteIndex = snapshot.trace.findIndex(event =>
        event.origin === 'webview'
        && event.phase === 'webview.streaming_complete_applied'
        && event.sourceUri === snapshot.sourceUri
        && event.resultSetIndex === 1
        && event.totalRows === 2,
    );
    assert.ok(hydrateAppliedIndex >= 0, 'Webview must apply a source-specific hydrate.');
    assert.ok(rowsAppliedIndex > hydrateAppliedIndex, 'Webview must apply streamed rows after hydrate.');
    assert.ok(
        streamingCompleteIndex > rowsAppliedIndex,
        'Webview must apply streaming completion after the rows.',
    );

    const hostAppendDelivery = snapshot.trace.find(event =>
        event.origin === 'host'
        && event.phase === 'host_post_result'
        && event.command === 'appendRows'
        && event.sourceUri === snapshot.sourceUri
        && event.resultSetIndex === 1
        && event.delivered === true,
    );
    assert.ok(hostAppendDelivery, 'VS Code must confirm delivery of appendRows to the webview.');

    console.log(JSON.stringify({
        type: 'result-panel-regression',
        sourceUri: snapshot.sourceUri,
        resultSetCount: snapshot.resultSets.length,
        traceEvents: snapshot.trace.length,
    }));
}

module.exports = { run };
