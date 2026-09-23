import { editValuesEqual, isBooleanEditType, isNumericEditType, parseTypedEditValue, toEditableCellText } from '../editValue.js';
import { asHtml } from '../dom.js';
import { formatCellValue, isBinaryColumnType } from '../utils.js';
import { callPanelMethod, getResultPanelWindow } from '../types.js';
import type { ResultSetWithExtras, GridColumnDef } from './types.js';

/** Attach typed, staged editing to one result grid body. */
export function setupCellEditing(
    tbody: HTMLTableSectionElement,
    columns: GridColumnDef[],
    resultSet: ResultSetWithExtras,
): void {
    tbody.addEventListener('dblclick', (e) => {
        let isEdit = false;
        try {
            isEdit = typeof getResultPanelWindow().getIsEditMode === 'function'
                ? getResultPanelWindow().getIsEditMode!()
                : false;
        } catch { /* best effort during teardown */ }
        if (!isEdit) return;

        const cellTd = asHtml(e.target)?.closest('td');
        if (!cellTd || cellTd.classList.contains('row-number-cell')) return;
        const editCellTd = cellTd;

        const cellTr = cellTd.closest('tr');
        if (!cellTr || cellTr.classList.contains('group-header') || !cellTr.dataset.index) return;

        e.stopPropagation();
        const rowIdx = parseInt(cellTr.dataset.dataRowIndex ?? cellTr.dataset.index, 10);
        if (isNaN(rowIdx)) return;
        const columnId = cellTd.dataset.columnIndex;
        const cellColumnIndex = columnId === undefined
            ? Array.from(cellTr.children).indexOf(cellTd) - 1
            : Number.parseInt(columnId, 10);
        if (!Number.isInteger(cellColumnIndex) || cellColumnIndex < 0) return;

        // Binary columns cannot be edited inline (values are base64/placeholders).
        const cellColumn = columns.find((candidate) => candidate.id === String(cellColumnIndex));
        if (isBinaryColumnType(cellColumn?.dataType)) return;

        const dataType = cellColumn?.dataType ?? '';
        const originalRow = resultSet.data[rowIdx];
        if (!originalRow) return;
        const oldVal = originalRow[cellColumnIndex];
        const isNull = oldVal === null || oldVal === undefined;
        const booleanCell = isBooleanEditType(dataType);
        const dateOnlyCell = /\bdate\b/i.test(dataType) && !/time|timestamp/i.test(dataType);
        const largeTextCell = /text|clob|json|long|\(\s*max\s*\)/i.test(dataType)
            || toEditableCellText(oldVal, dataType).length > 3000;
        const editorContainer = document.createElement('div');
        editorContainer.className = 'edit-cell-editor';
        const editableText = toEditableCellText(oldVal, dataType);
        let editor: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        if (booleanCell) {
            const select = document.createElement('select');
            select.className = 'edit-cell-input';
            for (const optionData of [
                { value: 'NULL', label: 'NULL' },
                { value: 'true', label: 'TRUE' },
                { value: 'false', label: 'FALSE' },
            ]) {
                const option = document.createElement('option');
                option.value = optionData.value;
                option.textContent = optionData.label;
                select.appendChild(option);
            }
            select.value = isNull
                ? 'NULL'
                : (oldVal === true || String(oldVal).toLowerCase() === 'true' || oldVal === 1 ? 'true' : 'false');
            editor = select;
        } else if (largeTextCell) {
            const textarea = document.createElement('textarea');
            textarea.className = 'edit-cell-input edit-cell-textarea';
            textarea.value = editableText;
            editor = textarea;
        } else {
            const input = document.createElement('input');
            input.type = dateOnlyCell ? 'date' : 'text';
            input.inputMode = isNumericEditType(dataType) ? 'decimal' : 'text';
            input.value = editableText;
            input.className = 'edit-cell-input';
            editor = input;
        }
        editor.style.width = '100%';
        editor.style.boxSizing = 'border-box';
        editor.style.backgroundColor = 'var(--vscode-input-background)';
        editor.style.color = 'var(--vscode-input-foreground)';
        editor.style.border = '1px solid var(--vscode-focusBorder)';
        editor.style.padding = '2px 4px';
        editor.style.fontSize = 'inherit';
        editor.style.fontFamily = 'inherit';

        let useNull = isNull;
        let nullButton: HTMLButtonElement | undefined;
        if (!booleanCell) {
            nullButton = document.createElement('button');
            nullButton.type = 'button';
            nullButton.className = 'edit-cell-null-toggle';
            nullButton.textContent = isNull ? 'Use value' : 'Set NULL';
            nullButton.setAttribute('aria-pressed', String(isNull));
            nullButton.onmousedown = (event) => event.preventDefault();
            nullButton.onclick = (event) => {
                event.stopPropagation();
                useNull = !useNull;
                nullButton!.textContent = useNull ? 'Use value' : 'Set NULL';
                nullButton!.setAttribute('aria-pressed', String(useNull));
                editor.disabled = useNull;
                if (!useNull) editor.focus();
            };
            editor.disabled = isNull;
            editorContainer.appendChild(nullButton);
        }
        editorContainer.appendChild(editor);
        editCellTd.innerHTML = '';
        editCellTd.appendChild(editorContainer);
        editor.focus();
        if (editor instanceof HTMLInputElement && editor.type !== 'date') editor.select();

        let finished = false;
        function restoreCell(value: unknown): void {
            editCellTd.innerHTML = '';
            const displaySpan = document.createElement('span');
            const display = value === null || value === undefined
                ? 'NULL'
                : (formatCellValue(value, dataType, cellColumn?.scale) ?? String(value));
            displaySpan.textContent = display;
            editCellTd.appendChild(displaySpan);
            editCellTd.title = display;
        }

        function commitEdit(): void {
            if (finished) return;
            const editorText = booleanCell
                ? (editor as HTMLSelectElement).value
                : (editor as HTMLInputElement | HTMLTextAreaElement).value;
            const nullValue = booleanCell ? editorText === 'NULL' : useNull;
            const parsed = parseTypedEditValue(editorText, dataType, nullValue);
            if (!parsed.valid) {
                if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) {
                    editor.setCustomValidity(parsed.message);
                    editor.reportValidity();
                }
                return;
            }
            finished = true;
            try {
                callPanelMethod('addPendingEdit', rowIdx, cellColumnIndex, oldVal, parsed.value);
            } catch { /* best effort during teardown */ }
            editCellTd.classList.toggle('cell-modified', !editValuesEqual(oldVal, parsed.value));
            restoreCell(parsed.value);
        }

        function cancelEdit(): void {
            if (finished) return;
            finished = true;
            restoreCell(oldVal);
        }

        editor.onblur = commitEdit;
        editor.onkeydown = function (ke) {
            if (ke.key === 'Enter' && (!(editor instanceof HTMLTextAreaElement) || ke.ctrlKey || ke.metaKey)) {
                ke.preventDefault();
                commitEdit();
            }
            if (ke.key === 'Escape') {
                ke.preventDefault();
                cancelEdit();
            }
        };
        editor.addEventListener('input', () => {
            if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) {
                editor.setCustomValidity('');
            }
        });
    });
}
