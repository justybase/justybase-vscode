const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const SCENARIO_ID = 'extension-host-join-knowledge-index';

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

async function waitFor(check, description, timeoutMs = 20000) {
    const started = Date.now();
    let lastError;
    while (Date.now() - started < timeoutMs) {
        try {
            const value = await check();
            if (value) return value;
        } catch (error) {
            lastError = error;
        }
        await sleep(250);
    }
    throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

function completionItems(result) {
    if (!result) return [];
    return Array.isArray(result) ? result : result.items ?? [];
}

function git(directory, args) {
    return execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
}

async function openCompletionDocument(text) {
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: text });
    await vscode.window.showTextDocument(document, { preview: false });
    return { document, position: document.positionAt(document.getText().length) };
}

async function completionsFor(target) {
    const result = await vscode.commands.executeCommand(
        'vscode.executeCompletionItemProvider',
        target.document.uri,
        target.position,
    );
    return completionItems(result);
}

function hasTier(items, tier, labelPart) {
    return items.some(item => String(item.sortText ?? '').startsWith(tier)
        && (labelPart === undefined || String(item.label).includes(labelPart)));
}

async function setGhostMode(mode) {
    await vscode.workspace.getConfiguration('justybase.sql').update(
        'joinGhostText',
        mode,
        vscode.ConfigurationTarget.Global,
    );
}

function ghostAt(document, position, suggestWidgetOpen = false) {
    return vscode.commands.executeCommand('justybase.test.joinGhostText', document.uri, position, suggestWidgetOpen);
}

/**
 * The favorite USERS → ORDERS relation is an explicit `0_3_` tier without a
 * same-tier runner-up, so the registered inline provider must show it.
 */
async function verifyJoinGhostText(document, position) {
    await setGhostMode('afterJoin');
    const afterJoin = await waitFor(async () => {
        const item = await ghostAt(document, position);
        return item && item.insertText.includes('ORDERS') ? item : undefined;
    }, 'JOIN ghost text after JOIN');
    assert.equal(afterJoin.command, 'netezza.acceptJoinGhostSuggestion', 'Ghost acceptance must be remembered.');
    assert.ok(afterJoin.insertText.includes(' ON '), 'The target ghost must include its ON condition.');
    assert.equal(await ghostAt(document, position, true), undefined, 'No ghost while the suggest widget is open.');

    const accepted = await vscode.commands.executeCommand(
        afterJoin.command,
        ...(afterJoin.commandArguments ?? []),
    );
    assert.equal(accepted, true, 'Accepting the ghost must record the relation.');
    const ghostStatus = await vscode.commands.executeCommand('netezza.showJoinKnowledgeStatus');
    assert.ok(ghostStatus?.ghostText?.afterJoinTarget?.shown >= 1, 'The shown ghost must be counted.');
    assert.equal(ghostStatus.ghostText.afterJoinTarget.accepted, 1, 'The accepted ghost must be counted.');

    const newLine = await openCompletionDocument('SELECT *\nFROM USERS u\n');
    assert.equal(await ghostAt(newLine.document, newLine.position), undefined, 'afterJoin must not ghost on a new line.');
    await setGhostMode('afterJoinAndNewLine');
    const wholeJoin = await waitFor(async () => {
        const item = await ghostAt(newLine.document, newLine.position);
        return item && item.insertText.startsWith('JOIN ') ? item : undefined;
    }, 'JOIN ghost text on a new line');
    assert.ok(wholeJoin.insertText.includes('ORDERS'), 'The new-line ghost must offer the favorite target.');

    const grouped = await openCompletionDocument('SELECT u.NAME, COUNT(*)\nFROM USERS u\nGROUP BY ');
    const groupBy = await waitFor(
        () => ghostAt(grouped.document, grouped.position),
        'GROUP BY ghost text',
    );
    assert.equal(groupBy.insertText, 'u.NAME', 'The GROUP BY ghost must list the non-aggregated SELECT items.');
    assert.equal(await vscode.commands.executeCommand(groupBy.command, ...(groupBy.commandArguments ?? [])), true);

    await setGhostMode('off');
    assert.equal(await ghostAt(document, position), undefined, 'The off mode must not ghost.');
    await setGhostMode('afterJoin');
    return {
        afterJoin: fingerprint(afterJoin.insertText),
        newLine: fingerprint(wholeJoin.insertText),
        groupBy: fingerprint(groupBy.insertText),
        accepted,
    };
}

async function run() {
    const startedAt = Date.now();
    const workDirectory = process.env.JUSTYBASE_EXTENSION_HOST_WORK_DIR;
    assert.ok(workDirectory, 'JUSTYBASE_EXTENSION_HOST_WORK_DIR is required.');
    const coreExtensionId = 'krzysztof-d.justybaselite-netezza';
    const coreExtension = vscode.extensions.getExtension(coreExtensionId);
    assert.ok(coreExtension, `Core extension '${coreExtensionId}' is not available in Extension Host.`);
    await coreExtension.activate();

    const fixtureFolder = (vscode.workspace.workspaceFolders ?? [])[0];
    assert.ok(fixtureFolder, 'The Extension Host did not open the knowledge-index workspace folder.');
    const fixtureDirectory = fixtureFolder.uri.fsPath;
    assert.ok(fs.existsSync(path.join(fixtureDirectory, 'a.sql')), 'Fixture a.sql is missing.');
    assert.ok(fs.existsSync(path.join(fixtureDirectory, 'b.sql')), 'Fixture b.sql is missing.');
    assert.ok(fs.existsSync(path.join(fixtureDirectory, 'c.sql')), 'Fixture c.sql is missing.');

    await vscode.workspace.getConfiguration('justybase.sql').update(
        'joinKnowledgeIndex',
        true,
        vscode.ConfigurationTarget.Global,
    );
    await vscode.workspace.getConfiguration('justybase.sql').update(
        'joinKnowledgeIndexGitWindowDays',
        0,
        vscode.ConfigurationTarget.Global,
    );

    const status = await waitFor(async () => {
        try {
            const current = await vscode.commands.executeCommand('netezza.rebuildJoinKnowledgeIndex');
            return current && current.filesIndexed >= 3 ? current : undefined;
        } catch {
            return undefined;
        }
    }, 'workspace JOIN index rebuild');
    assert.equal(status.enabled, true);
    assert.equal(status.filesIndexed, 5, `Expected 5 indexed files, got ${status.filesIndexed}.`);
    assert.equal(status.relations.eligible, 2, 'Expected two eligible workspace relations.');
    assert.equal(status.relations.belowThreshold, 1, 'Expected one below-threshold workspace relation.');
    // FROM sources only (USERS, PRODUCTS); the joined ORDERS ranks as a relation.
    assert.equal(status.objects.eligible, 2, 'Expected two eligible workspace objects.');
    assert.equal(status.objects.belowThreshold, 1, 'Expected one below-threshold workspace object.');
    assert.equal(status.truncated, false, 'The fixture index must not be truncated.');

    const document = await vscode.workspace.openTextDocument({
        language: 'sql',
        content: 'SELECT * FROM USERS u JOIN ',
    });
    await vscode.window.showTextDocument(document, { preview: false });
    const position = document.positionAt(document.getText().length);
    let lastCompletionItems = [];
    const workspaceItems = await waitFor(async () => {
        const result = await vscode.commands.executeCommand(
            'vscode.executeCompletionItemProvider',
            document.uri,
            position,
        );
        const items = completionItems(result);
        lastCompletionItems = items;
        return items.some(item => String(item.sortText ?? '').startsWith('0_5_'))
            ? items
            : undefined;
    }, 'workspace JOIN completion').catch((error) => {
        console.error(JSON.stringify({
            type: 'knowledge-index-completion-debug',
            status,
            itemCount: lastCompletionItems.length,
            items: lastCompletionItems.slice(0, 20).map(item => ({
                label: item.label,
                sortText: item.sortText,
                detail: item.detail,
            })),
        }));
        throw error;
    });
    const workspaceItem = workspaceItems.find(item => String(item.sortText ?? '').startsWith('0_5_'));
    assert.ok(workspaceItem, 'Workspace JOIN item was not returned.');
    assert.ok(String(workspaceItem.label).includes('ORDERS'), 'Workspace JOIN target is missing ORDERS.');
    assert.ok(String(workspaceItem.detail).includes('workspace SQL'), 'Workspace JOIN detail is missing.');

    const relation = {
        left: { table: 'USERS' },
        right: { table: 'ORDERS' },
        columns: [{ left: 'USER_ID', right: 'OWNER_ID' }],
    };
    await vscode.commands.executeCommand('netezza.favoriteJoinKnowledgeRelation', relation);
    const favoriteItems = await waitFor(async () => {
        const result = await vscode.commands.executeCommand(
            'vscode.executeCompletionItemProvider',
            document.uri,
            position,
        );
        const items = completionItems(result);
        return items.some(item => String(item.sortText ?? '').startsWith('0_3_'))
            ? items
            : undefined;
    }, 'favorite JOIN completion');
    const favoriteItem = favoriteItems.find(item => String(item.sortText ?? '').startsWith('0_3_'));
    assert.ok(favoriteItem, 'Favorite JOIN item was not returned.');
    assert.ok(String(favoriteItem.detail).includes('favorite'), 'Favorite JOIN marker is missing.');

    const blockId = await vscode.commands.executeCommand(
        'netezza.blockJoinKnowledgeRelation',
        relation,
    );
    assert.ok(typeof blockId === 'string' && blockId.length > 0, 'Block did not return an override id.');
    await sleep(500);
    const blockedResult = await vscode.commands.executeCommand(
        'vscode.executeCompletionItemProvider',
        document.uri,
        position,
    );
    const blockedItems = completionItems(blockedResult);
    assert.ok(
        !blockedItems.some(item => String(item.label).includes('ORDERS')),
        'Blocked relation still appeared in completion.',
    );

    await vscode.commands.executeCommand('netezza.revertJoinKnowledgeOverride', blockId);
    const restoredItems = await waitFor(async () => {
        const result = await vscode.commands.executeCommand(
            'vscode.executeCompletionItemProvider',
            document.uri,
            position,
        );
        const items = completionItems(result);
        return items.some(item => String(item.sortText ?? '').startsWith('0_3_'))
            ? items
            : undefined;
    }, 'favorite restored after block revert');

    const ghost = await verifyJoinGhostText(document, position);

    const initialHead = git(fixtureDirectory, ['rev-parse', 'HEAD']);
    const initialStatus = await vscode.commands.executeCommand('netezza.showJoinKnowledgeStatus');
    assert.ok(initialStatus?.workspaceIndex, 'Status must include workspace index diagnostics.');
    assert.equal(initialStatus.workspaceIndex.git.mode, 'all', 'Window 0 must select all files.');
    assert.equal(initialStatus.workspaceIndex.git.head, initialHead, 'Status must report the fixture HEAD.');
    assert.equal(initialStatus.workspaceIndex.truncated, false, 'The fixture index must not be truncated.');
    const initialFavoriteCount = initialStatus.relationOverrides.favorites;
    assert.ok(initialFavoriteCount >= 1, 'The fixture must keep the favorite decision.');

    // Real branch switch: the fixture is a Git repository, so this exercises the
    // HEAD watcher and the full reconcile rather than a synthetic HEAD value.
    // PRODUCTS → ORDERS and DEPOTS → ORDERS are the switch markers; neither has
    // a manual preference, so the workspace tier is not shadowed by `0_3_`.
    const usersTarget = { document, position };
    const accountsTarget = await openCompletionDocument('SELECT * FROM ACCOUNTS a JOIN ');
    const productsTarget = await openCompletionDocument('SELECT * FROM PRODUCTS p JOIN ');
    const depotsTarget = await openCompletionDocument('SELECT * FROM DEPOTS d JOIN ');
    git(fixtureDirectory, ['checkout', '--quiet', 'alternate']);
    const alternateHead = git(fixtureDirectory, ['rev-parse', 'HEAD']);
    assert.notEqual(alternateHead, initialHead, 'The fixture branches must have distinct HEAD commits.');

    const switchedStatus = await waitFor(async () => {
        const current = await vscode.commands.executeCommand('netezza.showJoinKnowledgeStatus');
        if (current?.workspaceIndex?.git?.head !== alternateHead) return undefined;
        const accountsItems = await completionsFor(accountsTarget);
        const usersItems = await completionsFor(usersTarget);
        const productsItems = await completionsFor(productsTarget);
        const depotsItems = await completionsFor(depotsTarget);
        return hasTier(accountsItems, '0_5_', 'ORDERS')
            && !hasTier(usersItems, '0_5_')
            && hasTier(usersItems, '0_3_', 'ORDERS')
            && !hasTier(productsItems, '0_5_')
            && hasTier(depotsItems, '0_5_', 'ORDERS')
            ? current
            : undefined;
    }, 'workspace JOIN re-index after a branch switch');

    assert.ok(switchedStatus?.workspaceIndex, 'Status must include workspace index diagnostics.');
    assert.equal(switchedStatus.workspaceIndex.git.head, alternateHead, 'The index must persist the new HEAD.');
    assert.equal(switchedStatus.workspaceIndex.filesIndexed, 5, 'A branch switch must still index all five files.');
    assert.equal(switchedStatus.workspaceIndex.relations.eligible, 2);
    assert.equal(switchedStatus.workspaceIndex.relations.belowThreshold, 1);
    assert.equal(switchedStatus.workspaceIndex.truncated, false);
    assert.equal(
        switchedStatus.relationOverrides.favorites,
        initialFavoriteCount,
        'A branch switch must not touch manual decisions.',
    );

    git(fixtureDirectory, ['checkout', '--quiet', 'main']);
    const statusAfter = await waitFor(async () => {
        const current = await vscode.commands.executeCommand('netezza.showJoinKnowledgeStatus');
        if (current?.workspaceIndex?.git?.head !== initialHead) return undefined;
        const accountsItems = await completionsFor(accountsTarget);
        const productsItems = await completionsFor(productsTarget);
        const depotsItems = await completionsFor(depotsTarget);
        return hasTier(productsItems, '0_5_', 'ORDERS')
            && !hasTier(accountsItems, '0_5_')
            && !hasTier(depotsItems, '0_5_')
            ? current
            : undefined;
    }, 'workspace JOIN re-index after switching back');

    assert.ok(statusAfter, 'Status command returned no diagnostics.');
    assert.equal(statusAfter.workspaceIndex.git.head, initialHead, 'Switching back must restore the original HEAD.');
    assert.equal(
        statusAfter.relationOverrides.favorites,
        initialFavoriteCount,
        'Switching back must not touch manual decisions.',
    );

    const report = {
        scenarioId: SCENARIO_ID,
        status: 'passed',
        sourceUri: fingerprint(document.uri.toString()),
        filesIndexed: status.filesIndexed,
        filesSelected: status.filesSelected,
        relations: status.relations,
        objects: status.objects,
        gitMode: status.git.mode,
        gitHead: initialHead.slice(0, 12),
        skipped: status.skipped,
        truncated: status.truncated,
        branchSwitch: {
            fromHead: initialHead.slice(0, 12),
            toHead: alternateHead.slice(0, 12),
            relations: switchedStatus.workspaceIndex.relations,
            favorites: switchedStatus.relationOverrides.favorites,
            restored: true,
        },
        favoriteLabel: String(favoriteItem.label),
        workspaceLabel: String(workspaceItem.label),
        restoredCount: restoredItems.length,
        ghost,
        durationMs: Date.now() - startedAt,
    };
    writeReport(report);
    console.log(JSON.stringify({
        type: 'extension-host-join-knowledge-index',
        scenarioId: SCENARIO_ID,
        filesIndexed: report.filesIndexed,
        relations: report.relations,
        objects: report.objects,
        durationMs: report.durationMs,
    }));
}

module.exports = { run };
