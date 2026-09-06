const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

function writeReport(report) {
    const reportPath = process.env.JUSTYBASE_EXTENSION_HOST_REPORT_PATH;
    if (!reportPath) return;
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function run() {
    const coreExtensionId = 'krzysztof-d.justybaselite-netezza';
    const coreExtension = vscode.extensions.getExtension(coreExtensionId);
    assert.ok(coreExtension, `Core extension '${coreExtensionId}' is not available in Extension Host.`);
    const coreApi = await coreExtension.activate();

    const connectionName = `extension-host-designer-${process.pid}`;
    const databasePath = process.env.JUSTYBASE_EXTENSION_HOST_DATABASE_PATH;
    assert.ok(databasePath, 'Designer Extension Host fixture database path is missing.');
    await coreApi.openFileSqlSession({
        name: connectionName,
        host: 'local',
        port: 0,
        user: 'file',
        database: databasePath,
        dbType: 'sqlite',
    }, {
        connectionName,
        content: '-- Table Designer Extension Host fixture\n',
    });

    const report = await vscode.commands.executeCommand('justybase.test.tableDesignerScenario', {
        connectionName,
        dbName: 'main',
        schemaName: 'main',
    });
    assert.ok(report && typeof report === 'object', 'Table Designer Extension Host returned no report.');
    assert.equal(report.status, 'passed');
    assert.equal(report.scenarioId, 'extension-host-table-designer');
    assert.equal(report.commandRegistered, true);
    assert.equal(report.panelOpened, true);
    assert.equal(report.activeTabLabel, 'Table Designer (main)');
    assert.equal(report.containerDisplay, 'main');
    assert.equal(report.clickhouseSupported, false);
    assert.equal(report.readOnlySupported, false);
    assert.equal(
        report.sqliteDdl,
        'CREATE TABLE IF NOT EXISTS main.extension_host_orders (\n'
        + '    id INTEGER NOT NULL,\n'
        + "    status TEXT DEFAULT 'ready',\n"
        + '    PRIMARY KEY (id)\n'
        + ');',
    );
    assert.equal(
        report.netezzaDdl,
        'CREATE TABLE IF NOT EXISTS SYSTEM.ADMIN."extension_host_orders" (\n'
        + '    "id" INTEGER NOT NULL,\n'
        + '    PRIMARY KEY ("id")\n'
        + ') DISTRIBUTE ON ("id") ORGANIZE ON ("id");',
    );

    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    writeReport({
        ...report,
        connectionName,
        databasePath: 'redacted-fixture-path',
    });
    console.log(JSON.stringify({
        type: 'extension-host-table-designer',
        scenarioId: report.scenarioId,
        panelOpened: report.panelOpened,
        activeTabLabel: report.activeTabLabel,
    }));
}

module.exports = { run };
