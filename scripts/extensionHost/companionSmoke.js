const assert = require('node:assert/strict');
const vscode = require('vscode');

async function run() {
    const coreExtensionId = process.env.COMPANION_CORE_EXTENSION_ID;
    const companionExtensionId = process.env.COMPANION_EXTENSION_ID;
    const expectedKind = process.env.COMPANION_DATABASE_KIND;

    assert.ok(coreExtensionId, 'COMPANION_CORE_EXTENSION_ID must be set.');
    assert.ok(companionExtensionId, 'COMPANION_EXTENSION_ID must be set.');
    assert.ok(expectedKind, 'COMPANION_DATABASE_KIND must be set.');

    const coreExtension = vscode.extensions.getExtension(coreExtensionId);
    const companionExtension = vscode.extensions.getExtension(companionExtensionId);
    assert.ok(coreExtension, `Core extension '${coreExtensionId}' is not available in Extension Host.`);
    assert.ok(companionExtension, `Companion extension '${companionExtensionId}' is not available in Extension Host.`);

    const coreApi = await coreExtension.activate();
    assert.equal(coreApi?.version, 1, 'Core extension must expose API version 1.');
    assert.equal(typeof coreApi?.listRegisteredDatabaseDialects, 'function');

    await companionExtension.activate();

    const registeredKinds = coreApi
        .listRegisteredDatabaseDialects()
        .map(dialect => dialect.kind);
    assert.ok(
        registeredKinds.includes(expectedKind),
        `Companion '${companionExtensionId}' did not register '${expectedKind}'. Registered: ${registeredKinds.join(', ')}`,
    );

    const contributedCommands = (companionExtension.packageJSON?.contributes?.commands || [])
        .map(command => command.command)
        .filter(command => typeof command === 'string');
    const registeredCommands = await vscode.commands.getCommands(true);
    for (const command of contributedCommands) {
        assert.ok(
            registeredCommands.includes(command),
            `Companion '${companionExtensionId}' contributed '${command}' but did not register a handler.`,
        );
    }

    console.log(
        `Extension Host activation passed: ${companionExtensionId} registered ${expectedKind}`
        + (contributedCommands.length > 0 ? ` and ${contributedCommands.length} command(s).` : '.'),
    );
}

module.exports = { run };
