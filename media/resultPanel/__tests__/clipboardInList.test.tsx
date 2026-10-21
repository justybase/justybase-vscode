import { describe, expect, it } from '@jest/globals';
import { clipboardHtml, resolvePlainText } from '../selection/clipboard.js';

type Payload = Parameters<typeof resolvePlainText>[0];

const payload = {
    headers: [],
    matrix: [
        [{ text: '1 001', kind: 'number', numericValue: '1001', rawValue: 1001 }],
        [{ text: "O'Brien", kind: 'text', rawValue: "O'Brien" }],
    ],
    alignments: [],
    text: 'tabbed',
    html: '<table></table>',
    md: 'markdown',
} as unknown as Payload;

describe('Copy as SQL IN list', () => {
    it('renders the selection as an IN list from raw values', () => {
        expect(resolvePlainText(payload, 'inList')).toBe("IN (1001, 'O''Brien')");
    });

    it('copies plain text only, so rich editors do not paste an HTML table', () => {
        expect(clipboardHtml(payload, 'inList')).toBe('');
        expect(clipboardHtml(payload, 'tabbed')).toBe('<table></table>');
    });
});
