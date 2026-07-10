import type { QueryHistoryParameterDto } from './hostContracts.js';
import { iconPlay, iconSettings } from './icons.js';
import { escapeHtml } from './utils.js';

export interface ParameterDialogOptions {
    parameters: QueryHistoryParameterDto[];
    onRun: (values: QueryHistoryParameterDto[]) => void;
    onCancel?: () => void;
}

export function showParameterDialog(options: ParameterDialogOptions): void {
    const { parameters, onRun, onCancel } = options;

    const existingModal = document.querySelector('.parameter-modal');
    if (existingModal instanceof HTMLElement) {
        existingModal.remove();
    }

    const modal = document.createElement('div');
    modal.className = 'parameter-modal';
    modal.innerHTML = `
        <div class="parameter-modal-content">
            <h3>${iconSettings()} Quick Rerun with Parameters</h3>
            <p>This query contains ${parameters.length} parameter(s). Enter values below:</p>
            <div class="parameter-list">
                ${parameters
                    .map(
                        (param, idx) => `
                    <div class="parameter-item">
                        <label for="param-${idx}">${escapeHtml(param.name)}${param.required ? ' *' : ''}</label>
                        <input type="text" id="param-${idx}" name="${escapeHtml(param.name)}"
                               placeholder="${escapeHtml(param.defaultValue || 'Enter value...')}"
                               ${param.required ? 'required' : ''}>
                    </div>
                `,
                    )
                    .join('')}
            </div>
            <div class="parameter-actions">
                <button id="cancelParamsBtn" class="secondary">Cancel</button>
                <button id="runWithParamsBtn" class="primary">${iconPlay()} Run Query</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    document.getElementById('cancelParamsBtn')?.addEventListener('click', () => {
        modal.remove();
        onCancel?.();
    });

    document.getElementById('runWithParamsBtn')?.addEventListener('click', () => {
        const values: QueryHistoryParameterDto[] = [];

        for (let index = 0; index < parameters.length; index += 1) {
            const input = document.getElementById(`param-${index}`) as HTMLInputElement | null;
            if (input) {
                values.push({
                    ...parameters[index],
                    value: input.value,
                });
            }
        }

        onRun(values);
        modal.remove();
    });
}
