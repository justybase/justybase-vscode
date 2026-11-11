import type {
    SnippetDto,
    SnippetsHostToWebviewMessage,
    SnippetsWebviewToHostMessage,
} from './hostContracts.js';
import {
    escapeHtml,
    filterSnippets,
    formatUpdatedAt,
    parseTags,
    snippetPreview,
} from './model.js';

interface SnippetsVsCodeApi {
    postMessage(message: SnippetsWebviewToHostMessage): void;
    getState(): unknown;
    setState(state: unknown): void;
}

declare function acquireVsCodeApi(): SnippetsVsCodeApi;

const vscode = acquireVsCodeApi();
const postToHost = (message: SnippetsWebviewToHostMessage): void => {
    vscode.postMessage(message);
};

const iconBookmark = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M3 1h10v14l-5-3.6L3 15V1zm1 1v11.2l4-2.9 4 2.9V2H4z"/></svg>';
const iconPlus = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M8 2.5v11M2.5 8h11"/></svg>';
const iconSearch = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" d="M10.7 10.7 14 14M11.2 7.1a4.1 4.1 0 1 1-8.2 0 4.1 4.1 0 0 1 8.2 0z"/></svg>';
const iconClose = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="m3.5 3.5 9 9m0-9-9 9"/></svg>';
const iconCheck = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="m3 8.3 3.1 3.1L13 4.6"/></svg>';
const iconPaste = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M6 1h4v1h2.5L14 3.5v10L12.5 15h-9L2 13.5v-9L3.5 3H6V1zm1 2h2V2H7v1zM4 4.1 3.1 5v8.5l.9.9h9l.9-.9V5L13 4.1H4z"/></svg>';
const iconPlay = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M4 2.5 13 8l-9 5.5v-11z"/></svg>';
const iconEdit = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="m11.1 1.6 3.3 3.3-1.3 1.3-3.3-3.3 1.3-1.3zM8.9 3.8l3.3 3.3-6.7 6.7-3.6.3.3-3.6 6.7-6.7z"/></svg>';
const iconTrash = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M6 1h4l.5 1H14v1H2V2h3.5L6 1zM3 4h10l-.7 10.3L11.6 15H4.4l-.7-.7L3 4zm2.2 2 .5 7h1l-.4-7h-1zm2.8 0v7h1V6H8zm2.8 0-.4 7h1l.5-7h-1z"/></svg>';

const app = document.getElementById('app');
if (app) {
    app.innerHTML = `
        <div class="snippets-panel">
            <header class="snippets-head">
                <span class="snippets-title">${iconBookmark}<span>Snippets</span></span>
                <span class="snippets-count" id="snippetCount">0</span>
                <button type="button" class="icon-button" id="newSnippetBtn" title="Create a blank snippet">${iconPlus}</button>
            </header>
            <label class="snippets-search">
                ${iconSearch}
                <input id="searchInput" type="search" placeholder="Search snippets..." aria-label="Search snippets" />
            </label>
            <button type="button" class="save-current" id="saveCurrentBtn" disabled>
                ${iconPlus}<span>Save current SQL</span>
            </button>
            <section class="snippet-form" id="snippetForm" hidden>
                <div class="snippet-form-head">
                    <strong id="snippetFormTitle">New snippet</strong>
                    <button type="button" class="icon-button" id="closeFormBtn" title="Close snippet editor">${iconClose}</button>
                </div>
                <label class="snippet-field">
                    <span>Name</span>
                    <input id="snippetName" type="text" placeholder="Monthly totals" autocomplete="off" />
                </label>
                <label class="snippet-field">
                    <span>Tags</span>
                    <input id="snippetTags" type="text" placeholder="report, monthly" autocomplete="off" />
                </label>
                <label class="snippet-field">
                    <span>SQL</span>
                    <textarea id="snippetSql" placeholder="SELECT ..." spellcheck="false"></textarea>
                </label>
                <div class="snippet-form-error" id="formError" hidden></div>
                <div class="snippet-form-actions">
                    <button type="button" class="ghost" id="cancelFormBtn">Cancel</button>
                    <button type="button" class="primary" id="saveSnippetBtn">${iconCheck}<span>Save</span></button>
                </div>
            </section>
            <div class="snippets-error" id="panelError" hidden></div>
            <div class="snippet-list" id="snippetList"></div>
            <div class="snippets-empty" id="emptyState" hidden></div>
        </div>
    `;
}

function requireElement<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`Missing snippets webview element #${id}`);
    }
    return element as T;
}

const count = requireElement<HTMLSpanElement>('snippetCount');
const searchInput = requireElement<HTMLInputElement>('searchInput');
const newSnippetBtn = requireElement<HTMLButtonElement>('newSnippetBtn');
const saveCurrentBtn = requireElement<HTMLButtonElement>('saveCurrentBtn');
const formSection = requireElement<HTMLElement>('snippetForm');
const formTitle = requireElement<HTMLElement>('snippetFormTitle');
const nameInput = requireElement<HTMLInputElement>('snippetName');
const tagsInput = requireElement<HTMLInputElement>('snippetTags');
const sqlInput = requireElement<HTMLTextAreaElement>('snippetSql');
const formError = requireElement<HTMLDivElement>('formError');
const panelError = requireElement<HTMLDivElement>('panelError');
const saveSnippetBtn = requireElement<HTMLButtonElement>('saveSnippetBtn');
const cancelFormBtn = requireElement<HTMLButtonElement>('cancelFormBtn');
const closeFormBtn = requireElement<HTMLButtonElement>('closeFormBtn');
const snippetList = requireElement<HTMLDivElement>('snippetList');
const emptyState = requireElement<HTMLDivElement>('emptyState');

let snippets: SnippetDto[] = [];
let currentSql = '';
let searchTerm = '';
let form: { id?: string; name: string; tags: string; sql: string } | null = null;
let pendingFormFromCurrentSql = false;

function updateSaveCurrentState(): void {
    saveCurrentBtn.disabled = currentSql.trim().length === 0;
    saveCurrentBtn.title = saveCurrentBtn.disabled
        ? 'Open a query with SQL before saving a snippet'
        : 'Save the current editor SQL as a snippet';
}

function renderCard(snippet: SnippetDto): string {
    const tags = parseTags(snippet.tags);
    const tagMarkup = tags.length > 0
        ? `<div class="snippet-tags">${tags
            .map((tag) => `<span class="snippet-tag">${escapeHtml(tag)}</span>`)
            .join('')}</div>`
        : '';
    const id = escapeHtml(snippet.id);
    const name = escapeHtml(snippet.name);
    const updatedAt = escapeHtml(formatUpdatedAt(snippet.updatedAt));
    const sql = escapeHtml(snippet.sql);
    const preview = escapeHtml(snippetPreview(snippet.sql));
    return `
        <article class="snippet-card" data-id="${id}">
            <div class="snippet-card-head">
                <strong title="${name}">${name}</strong>
                <span>${updatedAt}</span>
            </div>
            <pre class="snippet-preview" title="${sql}">${preview}</pre>
            ${tagMarkup}
            <div class="snippet-actions">
                <button type="button" class="icon-button" data-action="insert" title="Insert snippet into the editor">${iconPaste}</button>
                <button type="button" class="icon-button" data-action="run" title="Open and run in a new query">${iconPlay}</button>
                <button type="button" class="icon-button" data-action="edit" title="Edit snippet">${iconEdit}</button>
                <button type="button" class="icon-button" data-action="delete" title="Delete snippet">${iconTrash}</button>
            </div>
        </article>
    `;
}

function renderList(): void {
    const visible = filterSnippets(snippets, searchTerm);
    count.textContent = String(visible.length);
    snippetList.innerHTML = visible.map(renderCard).join('');

    if (visible.length === 0) {
        emptyState.hidden = false;
        emptyState.textContent = searchTerm
            ? 'No snippets match this search.'
            : 'No snippets yet. Save the current SQL or create one.';
    } else {
        emptyState.hidden = true;
        emptyState.textContent = '';
    }
}

function showFormError(message: string): void {
    formError.textContent = message;
    formError.hidden = false;
}

function showPanelError(message: string): void {
    panelError.textContent = message;
    panelError.hidden = false;
}

function clearErrors(): void {
    formError.hidden = true;
    formError.textContent = '';
    panelError.hidden = true;
    panelError.textContent = '';
}

function openForm(sql: string, snippet?: SnippetDto): void {
    form = {
        id: snippet?.id,
        name: snippet?.name ?? '',
        tags: snippet?.tags ?? '',
        sql,
    };
    formTitle.textContent = snippet ? 'Edit snippet' : 'New snippet';
    nameInput.value = form.name;
    tagsInput.value = form.tags;
    sqlInput.value = form.sql;
    saveSnippetBtn.disabled = false;
    clearErrors();
    formSection.hidden = false;
    nameInput.focus();
}

function closeForm(): void {
    form = null;
    formSection.hidden = true;
    saveSnippetBtn.disabled = false;
}

function submitForm(): void {
    if (!form) {
        return;
    }
    const name = nameInput.value.trim();
    const sql = sqlInput.value.trim();
    if (!name) {
        showFormError('Give the snippet a name.');
        return;
    }
    if (!sql) {
        showFormError('The SQL text is empty.');
        return;
    }
    clearErrors();
    saveSnippetBtn.disabled = true;
    postToHost({
        type: 'saveSnippet',
        ...(form.id ? { id: form.id } : {}),
        name,
        tags: tagsInput.value.trim(),
        sql,
    });
}

searchInput.addEventListener('input', () => {
    searchTerm = searchInput.value;
    renderList();
});

newSnippetBtn.addEventListener('click', () => {
    openForm('');
});

saveCurrentBtn.addEventListener('click', () => {
    pendingFormFromCurrentSql = true;
    postToHost({ type: 'getCurrentSql' });
});

saveSnippetBtn.addEventListener('click', submitForm);
cancelFormBtn.addEventListener('click', closeForm);
closeFormBtn.addEventListener('click', closeForm);

snippetList.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest('button[data-action]');
    if (!(target instanceof HTMLButtonElement)) {
        return;
    }
    const card = target.closest('.snippet-card');
    const id = card instanceof HTMLElement ? card.dataset.id : undefined;
    const snippet = snippets.find((item) => item.id === id);
    if (!snippet) {
        return;
    }
    switch (target.dataset.action) {
        case 'insert':
            postToHost({ type: 'insertSnippet', sql: snippet.sql });
            break;
        case 'run':
            postToHost({ type: 'runSnippet', sql: snippet.sql, name: snippet.name });
            break;
        case 'edit':
            openForm(snippet.sql, snippet);
            break;
        case 'delete':
            postToHost({ type: 'deleteSnippet', id: snippet.id, name: snippet.name });
            break;
    }
});

window.addEventListener('message', (event: MessageEvent<SnippetsHostToWebviewMessage>) => {
    const message = event.data;
    switch (message.type) {
        case 'snippetsData':
            snippets = message.snippets;
            currentSql = message.currentSql;
            updateSaveCurrentState();
            renderList();
            break;
        case 'currentSql':
            currentSql = message.sql;
            updateSaveCurrentState();
            if (pendingFormFromCurrentSql) {
                pendingFormFromCurrentSql = false;
                openForm(currentSql);
            }
            break;
        case 'openForm':
            openForm(message.sql, message.snippet);
            break;
        case 'snippetSaved':
            closeForm();
            break;
        case 'snippetDeleted':
            break;
        case 'snippetsError':
            saveSnippetBtn.disabled = false;
            if (form) {
                showFormError(message.message);
            } else {
                showPanelError(message.message);
            }
            break;
    }
});

renderList();
postToHost({ type: 'getSnippets' });
postToHost({ type: 'getCurrentSql' });
