import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

interface Keybinding {
    command: string;
    key: string;
    mac?: string;
    when?: string;
}

const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as {
    contributes: { keybindings: Keybinding[] };
};
const historySearch = manifest.contributes.keybindings.filter(binding => binding.command === 'netezza.searchQueryHistory');

describe('query history search keybindings', () => {
    it('binds Ctrl+R / Cmd+R only in SQL editors and the Query History view', () => {
        const ctrlR = historySearch.filter(binding => binding.key === 'ctrl+r');

        expect(ctrlR.map(binding => binding.mac)).toEqual(['cmd+r', 'cmd+r']);
        expect(ctrlR.map(binding => binding.when)).toEqual([
            expect.stringMatching(/^editorTextFocus && .*resourceLangId == sql\b/),
            'focusedView == netezza.queryHistory',
        ]);
    });

    it('keeps Ctrl+Alt+R as the alternative shortcut', () => {
        expect(historySearch).toContainEqual(expect.objectContaining({ key: 'ctrl+alt+r', mac: 'cmd+alt+r' }));
    });

    it('never claims Ctrl+R globally, so Open Recent keeps working elsewhere', () => {
        const unscoped = manifest.contributes.keybindings.filter(binding => binding.key === 'ctrl+r' && !binding.when);
        expect(unscoped).toEqual([]);
    });
});
