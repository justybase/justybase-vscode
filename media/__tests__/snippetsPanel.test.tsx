/** @jest-environment jsdom */

interface VsCodeApiMock {
    postMessage: jest.Mock;
    getState: jest.Mock;
    setState: jest.Mock;
}

interface WebviewMessage {
    type: string;
    [key: string]: unknown;
}

const originalAddEventListener = window.addEventListener.bind(window);
let api: VsCodeApiMock;
let messageListeners: Array<(event: MessageEvent<WebviewMessage>) => void>;

function element<T extends HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (!found) {
        throw new Error(`Missing element #${id}`);
    }
    return found as T;
}

function dispatch(message: WebviewMessage): void {
    const event = new MessageEvent<WebviewMessage>('message', { data: message });
    messageListeners.forEach((listener) => listener(event));
}

function clickAction(action: string): void {
    const button = document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
    if (!button) {
        throw new Error(`Missing snippet action ${action}`);
    }
    button.click();
}

describe('snippets panel', () => {
    beforeEach(async () => {
        jest.resetModules();
        messageListeners = [];
        document.body.innerHTML = '<div id="app"></div>';
        api = {
            postMessage: jest.fn(),
            getState: jest.fn(),
            setState: jest.fn(),
        };
        (globalThis as Record<string, unknown>).acquireVsCodeApi = () => api;

        jest.spyOn(window, 'addEventListener').mockImplementation(
            (type, listener, options) => {
                if (type === 'message' && typeof listener === 'function') {
                    messageListeners.push(listener as (event: MessageEvent<WebviewMessage>) => void);
                    return;
                }
                originalAddEventListener(type, listener, options);
            },
        );

        await import('../snippets.js');
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete (globalThis as Record<string, unknown>).acquireVsCodeApi;
    });

    it('bootstraps the panel and shows the empty state', () => {
        expect(api.postMessage).toHaveBeenCalledWith({ type: 'getSnippets' });
        expect(api.postMessage).toHaveBeenCalledWith({ type: 'getCurrentSql' });
        expect(element('snippetCount').textContent).toBe('0');
        expect(element<HTMLElement>('snippetForm').hidden).toBe(true);
        expect(element<HTMLButtonElement>('saveCurrentBtn').disabled).toBe(true);
        expect(element('emptyState').hidden).toBe(false);
        expect(element('emptyState').textContent).toContain('No snippets yet');
    });

    it('renders snippets, tags, and filters by search', () => {
        dispatch({
            type: 'snippetsData',
            currentSql: 'SELECT 1;',
            snippets: [
                {
                    id: 's1',
                    name: 'Monthly totals',
                    tags: 'report, monthly',
                    sql: 'SELECT * FROM DIMDATE;',
                    updatedAt: 1,
                },
                {
                    id: 's2',
                    name: 'Users',
                    tags: '',
                    sql: 'SELECT * FROM USERS;',
                    updatedAt: 2,
                },
            ],
        });

        expect(element('snippetCount').textContent).toBe('2');
        expect(document.querySelectorAll('.snippet-card')).toHaveLength(2);
        expect(element<HTMLButtonElement>('saveCurrentBtn').disabled).toBe(false);
        expect(document.querySelector('.snippet-tags')?.textContent).toContain('report');
        expect(document.querySelectorAll('.snippet-tag')).toHaveLength(2);

        const search = element<HTMLInputElement>('searchInput');
        search.value = 'admin';
        search.dispatchEvent(new Event('input'));
        expect(document.querySelectorAll('.snippet-card')).toHaveLength(0);

        search.value = 'DIMDATE';
        search.dispatchEvent(new Event('input'));
        expect(document.querySelectorAll('.snippet-card')).toHaveLength(1);

        search.value = 'missing';
        search.dispatchEvent(new Event('input'));
        expect(document.querySelectorAll('.snippet-card')).toHaveLength(0);
        expect(element('emptyState').textContent).toContain('No snippets match this search.');
    });

    it('dispatches insert, run, edit, and delete actions', () => {
        dispatch({
            type: 'snippetsData',
            currentSql: '',
            snippets: [
                {
                    id: 's1',
                    name: 'Monthly totals',
                    tags: 'report, monthly',
                    sql: 'SELECT * FROM DIMDATE;',
                    updatedAt: 1,
                },
            ],
        });

        clickAction('insert');
        expect(api.postMessage).toHaveBeenLastCalledWith({
            type: 'insertSnippet',
            sql: 'SELECT * FROM DIMDATE;',
        });

        clickAction('run');
        expect(api.postMessage).toHaveBeenLastCalledWith({
            type: 'runSnippet',
            sql: 'SELECT * FROM DIMDATE;',
            name: 'Monthly totals',
        });

        clickAction('delete');
        expect(api.postMessage).toHaveBeenLastCalledWith({
            type: 'deleteSnippet',
            id: 's1',
            name: 'Monthly totals',
        });

        clickAction('edit');
        expect(element<HTMLElement>('snippetForm').hidden).toBe(false);
        expect(element('snippetFormTitle').textContent).toBe('Edit snippet');
        expect(element<HTMLInputElement>('snippetName').value).toBe('Monthly totals');
        expect(element<HTMLInputElement>('snippetTags').value).toBe('report, monthly');
        expect(element<HTMLTextAreaElement>('snippetSql').value).toBe('SELECT * FROM DIMDATE;');

        element<HTMLButtonElement>('saveSnippetBtn').click();
        expect(api.postMessage).toHaveBeenLastCalledWith({
            type: 'saveSnippet',
            id: 's1',
            name: 'Monthly totals',
            tags: 'report, monthly',
            sql: 'SELECT * FROM DIMDATE;',
        });
    });

    it('saves the current SQL through the form', () => {
        dispatch({ type: 'currentSql', sql: 'SELECT 2;' });
        expect(element<HTMLButtonElement>('saveCurrentBtn').disabled).toBe(false);

        element<HTMLButtonElement>('saveCurrentBtn').click();
        expect(api.postMessage).toHaveBeenLastCalledWith({ type: 'getCurrentSql' });

        dispatch({ type: 'currentSql', sql: 'SELECT 2;' });
        expect(element<HTMLElement>('snippetForm').hidden).toBe(false);
        expect(element<HTMLTextAreaElement>('snippetSql').value).toBe('SELECT 2;');

        element<HTMLInputElement>('snippetName').value = 'Current query';
        element<HTMLButtonElement>('saveSnippetBtn').click();
        expect(api.postMessage).toHaveBeenLastCalledWith({
            type: 'saveSnippet',
            name: 'Current query',
            tags: '',
            sql: 'SELECT 2;',
        });
    });

    it('validates the form and surfaces host errors', () => {
        element<HTMLButtonElement>('newSnippetBtn').click();
        expect(element<HTMLElement>('snippetForm').hidden).toBe(false);
        expect(element('snippetFormTitle').textContent).toBe('New snippet');

        element<HTMLButtonElement>('saveSnippetBtn').click();
        expect(element('formError').textContent).toBe('Give the snippet a name.');

        element<HTMLInputElement>('snippetName').value = 'Test';
        element<HTMLButtonElement>('saveSnippetBtn').click();
        expect(element('formError').textContent).toBe('The SQL text is empty.');

        element<HTMLTextAreaElement>('snippetSql').value = 'SELECT 3;';
        element<HTMLButtonElement>('saveSnippetBtn').click();
        expect(api.postMessage).toHaveBeenLastCalledWith({
            type: 'saveSnippet',
            name: 'Test',
            tags: '',
            sql: 'SELECT 3;',
        });

        dispatch({ type: 'snippetsError', message: 'Name already exists' });
        expect(element('formError').textContent).toBe('Name already exists');
        expect(element<HTMLButtonElement>('saveSnippetBtn').disabled).toBe(false);

        dispatch({ type: 'snippetSaved', id: 's3', name: 'Test' });
        expect(element<HTMLElement>('snippetForm').hidden).toBe(true);
    });

    it('handles host-driven forms, cancellation, and panel errors', () => {
        dispatch({ type: 'openForm', sql: 'SELECT 9;' });
        expect(element<HTMLElement>('snippetForm').hidden).toBe(false);
        expect(element<HTMLTextAreaElement>('snippetSql').value).toBe('SELECT 9;');

        element<HTMLButtonElement>('cancelFormBtn').click();
        expect(element<HTMLElement>('snippetForm').hidden).toBe(true);

        element<HTMLButtonElement>('newSnippetBtn').click();
        element<HTMLButtonElement>('closeFormBtn').click();
        expect(element<HTMLElement>('snippetForm').hidden).toBe(true);

        dispatch({ type: 'snippetsError', message: 'Load failed' });
        expect(element('panelError').textContent).toBe('Load failed');
        expect(element<HTMLElement>('panelError').hidden).toBe(false);

        dispatch({ type: 'snippetDeleted', id: 's1', name: 'Removed' });
    });

    it('handles an empty search and ignores saves without an open form', () => {
        const search = element<HTMLInputElement>('searchInput');
        search.value = 'missing';
        search.dispatchEvent(new Event('input'));
        expect(element('emptyState').textContent).toBe('No snippets match this search.');

        element<HTMLButtonElement>('saveSnippetBtn').click();
        expect(api.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: 'saveSnippet' }),
        );
    });
});
