import type {
    PermissionPayload,
    SecurityPanelHostToWebviewMessage,
    SecurityPanelWebviewToHostMessage,
    SecurityPrincipal,
} from './hostContracts.js';
import { getElementById } from './dom.js';
import { postToHost, asHostMessage } from './protocol.js';
import { escapeHtml } from './utils.js';

const refreshBtn = getElementById<HTMLButtonElement>('refreshBtn');
const action = getElementById<HTMLSelectElement>('action');
const grantVariant = getElementById<HTMLSelectElement>('grantVariant');
const principalType = getElementById<HTMLSelectElement>('principalType');
const principalLabel = getElementById('principalLabel');
const principalPickerLabel = getElementById('principalPickerLabel');
const principal = getElementById<HTMLInputElement>('principal');
const principalPicker = getElementById<HTMLSelectElement>('principalPicker');
const withGrantOption = getElementById<HTMLInputElement>('withGrantOption');
const grantOptionRow = getElementById('grantOptionRow');
const objectPrivileges = getElementById<HTMLInputElement>('objectPrivileges');
const objectTarget = getElementById<HTMLInputElement>('objectTarget');
const objectTypeClause = getElementById<HTMLInputElement>('objectTypeClause');
const adminPrivileges = getElementById<HTMLInputElement>('adminPrivileges');
const adminScope = getElementById<HTMLInputElement>('adminScope');
const customSql = getElementById<HTMLTextAreaElement>('customSql');
const objectSections = document.querySelectorAll('.object-variant');
const adminSections = document.querySelectorAll('.admin-variant');
const rawSections = document.querySelectorAll('.raw-variant');
const previewBtn = getElementById<HTMLButtonElement>('previewBtn');
const executeBtn = getElementById<HTMLButtonElement>('executeBtn');
const sqlPreview = getElementById<HTMLTextAreaElement>('sqlPreview');
const principalTableBody = getElementById('principalTableBody');
const statusMessage = getElementById('statusMessage');

let principals: SecurityPrincipal[] = [];

if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
        postToHost({ command: 'loadData' });
    });
}

if (action) {
    action.addEventListener('change', () => {
        updateFormVisibility();
    });
}

if (grantVariant) {
    grantVariant.addEventListener('change', () => {
        updateFormVisibility();
    });
}

if (principalType) {
    principalType.addEventListener('change', () => {
        updatePrincipalControls();
    });
}

if (principalPicker && principal) {
    principalPicker.addEventListener('change', () => {
        if (principalPicker.value) {
            principal.value = principalPicker.value;
        }
    });
}

if (previewBtn) {
    previewBtn.addEventListener('click', () => {
        postToHost({
            command: 'previewSql',
            payload: buildPayload(),
        });
    });
}

if (executeBtn) {
    executeBtn.addEventListener('click', () => {
        postToHost({
            command: 'executeSql',
            payload: buildPayload(),
        });
    });
}

window.addEventListener('message', event => {
    const message = asHostMessage(event.data);

    switch (message.command) {
        case 'setLoading':
            setLoading(Boolean(message.loading));
            break;
        case 'setData':
            principals = message.data?.principals ?? [];
            renderPrincipals();
            setStatus(`Loaded ${principals.length} user/group entries.`, false);
            break;
        case 'previewSql':
            if (sqlPreview) sqlPreview.value = message.sql || '';
            setStatus('SQL preview updated.', false);
            break;
        case 'executed':
            if (sqlPreview) sqlPreview.value = message.sql || sqlPreview.value;
            setStatus('SQL executed successfully.', false);
            break;
        case 'error':
            setStatus(message.text || 'Unknown error.', true);
            break;
    }
});

function updateFormVisibility(): void {
    const selectedVariant = grantVariant?.value ?? '';
    const isGrant = action?.value === 'GRANT';

    toggleSections(objectSections, selectedVariant === 'object');
    toggleSections(adminSections, selectedVariant === 'admin');
    toggleSections(rawSections, selectedVariant === 'raw');
    grantOptionRow?.classList.toggle('hidden', !isGrant);

    updatePrincipalControls();
}

function updatePrincipalControls(): void {
    const hidePrincipal =
        grantVariant?.value === 'raw' || principalType?.value === 'PUBLIC';

    principalLabel?.classList.toggle('hidden', hidePrincipal);
    principalPickerLabel?.classList.toggle('hidden', hidePrincipal);

    if (hidePrincipal) {
        if (principal) principal.value = '';
        if (principalPicker) principalPicker.value = '';
    }
}

function toggleSections(sectionNodeList: NodeListOf<Element>, visible: boolean): void {
    sectionNodeList.forEach(node => {
        node.classList.toggle('hidden', !visible);
    });
}

function buildPayload(): PermissionPayload {
    return {
        action: action?.value,
        grantVariant: grantVariant?.value,
        objectPrivileges: objectPrivileges?.value,
        objectTarget: objectTarget?.value,
        objectTypeClause: objectTypeClause?.value,
        adminPrivileges: adminPrivileges?.value,
        adminScope: adminScope?.value,
        principalType: principalType?.value,
        principal: principal?.value,
        customSql: customSql?.value,
        withGrantOption: Boolean(withGrantOption?.checked),
    };
}

function renderPrincipals(): void {
    if (!principalPicker || !principalTableBody) return;

    if (!principals.length) {
        principalPicker.innerHTML = '<option value="">No principal data found</option>';
        principalTableBody.innerHTML =
            '<tr><td colspan="2" class="empty">No principal data found.</td></tr>';
        return;
    }

    principalPicker.innerHTML = [
        '<option value="">Select user/group...</option>',
        ...principals.map(
            item =>
                `<option value="${escapeHtml(item.NAME || '')}">${escapeHtml(item.NAME || '')} (${escapeHtml(item.TYPE || '')})</option>`,
        ),
    ].join('');

    principalTableBody.innerHTML = principals
        .slice(0, 400)
        .map(
            item => `
                <tr>
                    <td>${escapeHtml(item.NAME || '')}</td>
                    <td>${escapeHtml(item.TYPE || '')}</td>
                </tr>
            `,
        )
        .join('');
}

function setLoading(loading: boolean): void {
    if (refreshBtn) refreshBtn.disabled = loading;
    if (previewBtn) previewBtn.disabled = loading;
    if (executeBtn) executeBtn.disabled = loading;
}

function setStatus(text: string, isError: boolean): void {
    if (!statusMessage) return;
    statusMessage.textContent = text;
    statusMessage.classList.toggle('error', isError);
}

updateFormVisibility();
postToHost({ command: 'loadData' });
