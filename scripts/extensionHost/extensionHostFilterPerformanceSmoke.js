const assert = require('node:assert/strict');
const fs = require('node:fs');
const vscode = require('vscode');

async function run() {
    const coreExtensionId = 'krzysztof-d.justybaselite-netezza';
    const coreExtension = vscode.extensions.getExtension(coreExtensionId);
    assert.ok(coreExtension, `Core extension '${coreExtensionId}' is not available in Extension Host.`);
    await coreExtension.activate();

    const reportPath = process.env.JUSTYBASE_EXTENSION_HOST_REPORT_PATH;
    const report = await vscode.commands.executeCommand('justybase.test.extensionHostFilterPerformance');

    assert.ok(report && typeof report === 'object', 'Extension Host filter performance returned no report.');
    assert.equal(report.status, 'passed');
    assert.equal(report.engine, 'sqlite');
    assert.equal(report.scenarioId, 'extension-host-result-panel-filter-performance');
    assert.equal(report.rowCount, 4000);
    assert.equal(report.columnCount, 32);
    assert.equal(report.storageMode, 'memory');
    assert.ok(Array.isArray(report.metrics));
    assert.equal(report.metrics.length, 4);

    for (const metric of report.metrics) {
        assert.equal(metric.actualVisibleRows, metric.expectedVisibleRows, `${metric.name} returned an unexpected row count.`);
        assert.equal(metric.filterApplyCount, 1, `${metric.name} applied more than once.`);
        assert.equal(metric.filterDebounceMs, 200, `${metric.name} used an unexpected debounce.`);
        assert.ok(metric.filterApplyLatencyMs >= 180, `${metric.name} applied before the quiet period elapsed.`);
        assert.ok(metric.durationMs >= metric.filterApplyLatencyMs, `${metric.name} has an invalid duration.`);
    }

    const rapid = report.metrics.find(metric => metric.name === '4000x32/rapid-typing');
    assert.ok(rapid, 'Rapid-typing performance metric is missing.');
    assert.equal(rapid.finalFilter, 'needle-middle');
    assert.equal(rapid.actualVisibleRows, 1);

    if (reportPath) {
        assert.ok(fs.existsSync(reportPath), 'Extension Host filter performance report JSON was not written.');
    }

    console.log(JSON.stringify({
        type: 'extension-host-result-panel-filter-performance',
        rowCount: report.rowCount,
        columnCount: report.columnCount,
        metrics: report.metrics.map(metric => ({
            name: metric.name,
            durationMs: Math.round(metric.durationMs * 100) / 100,
            filterApplyLatencyMs: Math.round(metric.filterApplyLatencyMs * 100) / 100,
            filterApplyCount: metric.filterApplyCount,
        })),
    }));
}

module.exports = { run };
