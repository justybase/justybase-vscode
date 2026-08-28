const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const DEFAULT_CAPTURE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 50;

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function boundedError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/\s+/gu, ' ').slice(0, 512);
}

function safeFileName(value) {
    const normalized = String(value || 'screenshot')
        .replace(/[^A-Za-z0-9._-]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 120);
    return normalized || 'screenshot';
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Captures the visible VS Code renderer through Chrome DevTools Protocol.
 *
 * The extension test process requests a named capture by writing a small JSON
 * file. This parent-side session owns Playwright and acknowledges the request
 * only after the PNG has been written, so the test can use screenshots as
 * deterministic checkpoints without importing Playwright into the extension.
 */
class ExtensionHostScreenshotSession {
    constructor(options) {
        this.port = options.port;
        this.requestDirectory = path.resolve(options.requestDirectory);
        this.screenshotDirectory = path.resolve(options.screenshotDirectory);
        this.captureTimeoutMs = options.captureTimeoutMs || DEFAULT_CAPTURE_TIMEOUT_MS;
        this.browser = undefined;
        this.running = false;
        this.pollPromise = undefined;
        this.processedRequests = new Set();
        this.manifest = [];
    }

    start() {
        fs.mkdirSync(this.requestDirectory, { recursive: true });
        fs.rmSync(this.screenshotDirectory, { recursive: true, force: true });
        fs.mkdirSync(this.screenshotDirectory, { recursive: true });
        this.running = true;
        this.pollPromise = this.pollRequests();
    }

    async stop() {
        this.running = false;
        await this.pollPromise;
        this.pollPromise = undefined;
        if (this.browser?.isConnected()) {
            await this.browser.close().catch(() => undefined);
        }
        this.browser = undefined;
        const manifestPath = path.join(this.screenshotDirectory, 'manifest.json');
        fs.writeFileSync(manifestPath, `${JSON.stringify(this.manifest, null, 2)}\n`, 'utf8');
    }

    async pollRequests() {
        while (this.running) {
            const requestPaths = fs.readdirSync(this.requestDirectory)
                .filter(fileName => fileName.endsWith('.request.json'))
                .sort()
                .map(fileName => path.join(this.requestDirectory, fileName));

            for (const requestPath of requestPaths) {
                if (!this.running || this.processedRequests.has(requestPath)) {
                    continue;
                }
                this.processedRequests.add(requestPath);
                await this.processRequest(requestPath);
            }

            await sleep(POLL_INTERVAL_MS);
        }
    }

    async processRequest(requestPath) {
        let request;
        try {
            request = readJson(requestPath);
            const screenshot = await this.capture(request);
            const response = { ok: true, ...screenshot };
            this.manifest.push(response);
            this.writeResponse(request, response);
        } catch (error) {
            const response = {
                ok: false,
                id: request?.id,
                name: request?.name,
                error: boundedError(error),
            };
            this.manifest.push(response);
            this.writeResponse(request || {}, response);
        }
    }

    writeResponse(request, response) {
        if (!request?.id) {
            return;
        }
        const responsePath = path.join(this.requestDirectory, `${safeFileName(request.id)}.response.json`);
        fs.writeFileSync(responsePath, `${JSON.stringify(response)}\n`, 'utf8');
    }

    async capture(request) {
        const name = safeFileName(request?.name);
        const outputPath = path.join(this.screenshotDirectory, `${name}.png`);
        const deadline = Date.now() + this.captureTimeoutMs;
        let lastError;

        while (Date.now() < deadline) {
            try {
                const page = await this.findWorkbenchPage();
                if (page) {
                    await page.screenshot({ path: outputPath, fullPage: false });
                    const viewport = page.viewportSize();
                    return {
                        id: request.id,
                        name,
                        path: outputPath,
                        url: page.url().slice(0, 256),
                        ...(viewport ? { width: viewport.width, height: viewport.height } : {}),
                    };
                }
            } catch (error) {
                lastError = error;
                if (this.browser && !this.browser.isConnected()) {
                    await this.browser.close().catch(() => undefined);
                    this.browser = undefined;
                }
            }
            await sleep(POLL_INTERVAL_MS);
        }

        throw new Error(
            `Timed out waiting for the VS Code renderer${lastError ? `: ${boundedError(lastError)}` : '.'}`,
        );
    }

    async findWorkbenchPage() {
        if (!this.browser?.isConnected()) {
            this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.port}`, {
                timeout: 1_000,
            });
        }

        const pages = this.browser.contexts().flatMap(context => context.pages());
        const usablePages = pages.filter(page => !page.isClosed() && !page.url().startsWith('devtools://'));
        return usablePages.find(page => /workbench/i.test(page.url())) || usablePages[0];
    }
}

/**
 * Request a screenshot from an Extension Host test. The request is a no-op in
 * the normal gate, keeping Playwright/CDP entirely opt-in.
 */
async function requestScreenshot(name) {
    if (process.env.JUSTYBASE_EXTENSION_HOST_SCREENSHOTS !== '1') {
        return undefined;
    }

    const requestDirectory = process.env.JUSTYBASE_EXTENSION_HOST_SCREENSHOT_REQUEST_DIR;
    if (!requestDirectory) {
        throw new Error('Screenshot mode requires JUSTYBASE_EXTENSION_HOST_SCREENSHOT_REQUEST_DIR.');
    }

    fs.mkdirSync(requestDirectory, { recursive: true });
    const requestId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const request = {
        id: requestId,
        name: safeFileName(name),
    };
    const requestPath = path.join(requestDirectory, `${safeFileName(requestId)}.request.json`);
    const responsePath = path.join(requestDirectory, `${safeFileName(requestId)}.response.json`);
    fs.writeFileSync(requestPath, `${JSON.stringify(request)}\n`, 'utf8');

    const deadline = Date.now() + Number(process.env.JUSTYBASE_EXTENSION_HOST_SCREENSHOT_TIMEOUT_MS || DEFAULT_CAPTURE_TIMEOUT_MS);
    try {
        while (Date.now() < deadline) {
            if (fs.existsSync(responsePath)) {
                const response = readJson(responsePath);
                if (!response.ok) {
                    throw new Error(`Screenshot '${request.name}' failed: ${response.error || 'unknown error'}`);
                }
                return response;
            }
            await sleep(POLL_INTERVAL_MS);
        }
        throw new Error(`Timed out waiting for screenshot '${request.name}'.`);
    } finally {
        fs.rmSync(requestPath, { force: true });
        fs.rmSync(responsePath, { force: true });
    }
}

module.exports = {
    ExtensionHostScreenshotSession,
    requestScreenshot,
};
