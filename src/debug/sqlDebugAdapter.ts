/**
 * DAP (Debug Adapter Protocol) server for SQL execution.
 * Shows SQL variables ($var, ${var}) in the Debug panel Variables section.
 * Communicates via stdin/stdout using JSON messages with Content-Length headers.
 */

interface DebugMessage {
    seq: number;
    type?: string;
    command?: string;
    event?: string;
    request_seq?: number;
    arguments?: Record<string, unknown>;
    success?: boolean;
    body?: unknown;
}

let messageSeq = 1;

// SQL variable storage
const sqlVariables = new Map<string, string>();
let queryText = '';

function sendMessage(msg: DebugMessage): void {
    const json = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
    process.stdout.write(header + json);
}

function sendResponse(requestSeq: number, command: string, body: unknown = {}): void {
    sendMessage({
        seq: messageSeq++,
        type: 'response',
        request_seq: requestSeq,
        command,
        success: true,
        body,
    });
}

function sendEvent(eventBody: unknown, eventType = 'output'): void {
    sendMessage({
        seq: messageSeq++,
        type: 'event',
        event: eventType,
        body: eventBody,
    });
}

/**
 * Extract SQL variables from query text.
 * Supports ${VAR_NAME} and $VAR_NAME formats.
 */
function extractVariables(sql: string): Map<string, string> {
    const vars = new Map<string, string>();

    // Match ${VAR_NAME}
    const curlyPattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
    let match;
    while ((match = curlyPattern.exec(sql)) !== null) {
        vars.set(match[1], '');
    }

    // Match $VAR_NAME (not inside ${...})
    const plainPattern = /\$([A-Za-z_][A-Za-z0-9_]*)/g;
    while ((match = plainPattern.exec(sql)) !== null) {
        const name = match[1];
        // Skip if preceded by { (part of ${...})
        if (match.index > 0 && sql[match.index - 1] === '{') {
            continue;
        }
        if (!vars.has(name)) {
            vars.set(name, '');
        }
    }

    return vars;
}

let buffer = '';

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    processBuffer();
});

function processBuffer(): void {
    while (true) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        const header = buffer.substring(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) return;

        const bodyLength = parseInt(match[1], 10);
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + bodyLength) return;

        const bodyStr = buffer.substring(bodyStart, bodyStart + bodyLength);
        buffer = buffer.substring(bodyStart + bodyLength);

        try {
            const msg = JSON.parse(bodyStr) as DebugMessage;
            handleMessage(msg);
        } catch {
            // ignore parse errors
        }
    }
}

function handleMessage(msg: DebugMessage): void {
    switch (msg.command) {
        case 'initialize':
            handleInitialize(msg);
            break;

        case 'launch':
            handleLaunch(msg);
            break;

        case 'scopes':
            handleScopes(msg);
            break;

        case 'variables':
            handleVariables(msg);
            break;

        case 'setVariable':
            handleSetVariable(msg);
            break;

        case 'terminate':
        case 'disconnect':
            sendResponse(msg.seq, msg.command, {});
            process.exit(0);
            break;

        default:
            // Respond to unknown requests with empty success
            if (msg.type === 'request') {
                sendResponse(msg.seq, msg.command || 'unknown', {});
            }
            break;
    }
}

function handleInitialize(msg: DebugMessage): void {
    sendResponse(msg.seq, 'initialize', {
        supportsConfigurationDoneRequest: true,
        supportsTerminateRequest: true,
        supportsSetVariable: true,
    });

    // Send initialized event — required by DAP before launch
    sendMessage({
        seq: messageSeq++,
        type: 'event',
        event: 'initialized',
    });
}

function handleLaunch(msg: DebugMessage): void {
    const args = (msg.arguments || {}) as Record<string, unknown>;
    queryText = (args.query as string) || '';
    const mode = (args.mode as string) || 'run';

    // Debug: show what arguments were received
    sendEvent({ category: 'stdout', output: `[debug] Launch args keys: ${Object.keys(args).join(', ')}\n` });
    sendEvent({ category: 'stdout', output: `[debug] Query length: ${queryText.length}\n` });
    if (!queryText) {
        sendEvent({ category: 'stdout', output: `[debug] Full args: ${JSON.stringify(args, null, 2)}\n` });
    }

    // Parse variables from query
    sqlVariables.clear();
    const extracted = extractVariables(queryText);
    for (const [name, value] of extracted) {
        sqlVariables.set(name, value);
    }

    sendEvent({ category: 'stdout', output: `SQL Debug: mode=${mode}\n` });
    sendEvent({ category: 'stdout', output: `Query:\n${queryText}\n\n` });

    if (sqlVariables.size > 0) {
        const varList = Array.from(sqlVariables.keys()).map(k => `  $${k} = ""`).join('\n');
        sendEvent({ category: 'stdout', output: `Variables detected:\n${varList}\n\n` });
        sendEvent({ category: 'stdout', output: 'Edit variable values in the Variables panel.\n' });
    } else {
        sendEvent({ category: 'stdout', output: 'No variables detected in query.\n' });
    }

    sendResponse(msg.seq, 'launch');
}

function handleScopes(msg: DebugMessage): void {
    const scopes = sqlVariables.size > 0
        ? [{
            name: 'SQL Variables',
            variablesReference: 1,
            expensive: false,
        }]
        : [];

    sendResponse(msg.seq, 'scopes', { scopes });
}

function handleVariables(msg: DebugMessage): void {
    const args = (msg.arguments || {}) as Record<string, unknown>;
    const ref = args.variablesReference as number;

    if (ref !== 1) {
        sendResponse(msg.seq, 'variables', { variables: [] });
        return;
    }

    const variables = Array.from(sqlVariables.entries()).map(([name, value]) => ({
        name: `$${name}`,
        value: value || '""',
        type: 'string',
        variablesReference: 0,
    }));

    sendResponse(msg.seq, 'variables', { variables });
}

function handleSetVariable(msg: DebugMessage): void {
    const args = (msg.arguments || {}) as Record<string, unknown>;
    const name = (args.name as string) || '';
    const value = (args.value as string) || '';
    const ref = args.variablesReference as number;

    if (ref !== 1) {
        sendResponse(msg.seq, 'setVariable', {});
        return;
    }

    // Strip leading $ if present
    const varName = name.startsWith('$') ? name.substring(1) : name;

    if (!sqlVariables.has(varName)) {
        sendResponse(msg.seq, 'setVariable', {});
        return;
    }

    sqlVariables.set(varName, value);

    sendResponse(msg.seq, 'setVariable', {
        value: value || '""',
        type: 'string',
        variablesReference: 0,
    });
}

// Send initial output
sendEvent({ category: 'stdout', output: 'SQL Debug Adapter started.\n' });
