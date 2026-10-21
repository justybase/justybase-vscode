import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Guards the filter-vs-aggregation visual contract: both dropdowns share the
// same type scale, row rhythm, checkbox size and flat list surface.
test('filter rows match aggregation rows', async ({ page }) => {
    await page.setContent('<div id="stage"></div>');
    await page.addStyleTag({ content: readFileSync(path.resolve(__dirname, '../../media/resultPanel.css'), 'utf8') });
    await page.evaluate(() => {
        const stage = document.getElementById('stage')!;
        stage.innerHTML =
            '<div class="column-filter-dropdown" style="position:static">' +
            '<div class="filter-context-header"><span class="filter-context-title">Filter: M</span>' +
            '<span class="filter-context-subtitle">Filter values</span></div>' +
            '<div class="filter-values-container"><div class="filter-value-item">' +
            '<input type="checkbox" checked><span class="filter-value-label">April</span>' +
            '<span class="filter-value-count">300</span></div></div>' +
            '<div class="quick-filters"><button class="quick-filter-btn">Blanks</button></div>' +
            '<div class="filter-selection-buttons"><button class="filter-selection-btn">Select all</button></div>' +
            '</div>' +
            '<div class="column-aggregation-dropdown" style="position:static"><div id="agg-item" ' +
            'style="display:flex;align-items:center;padding:5px 12px;gap:8px;cursor:pointer">' +
            '<input type="checkbox" style="margin:0;cursor:pointer;accent-color:var(--vscode-focusBorder);flex-shrink:0">' +
            '<span id="agg-sym" style="font-size:13px;min-width:18px;text-align:center;opacity:0.8;flex-shrink:0">Σ</span>' +
            '<div style="display:flex;flex-direction:column;flex:1;min-width:0">' +
            '<span id="agg-label" style="font-weight:500;font-size:12px">Sum</span>' +
            '<span id="agg-desc" style="font-size:10px;opacity:0.7">Sum of all values</span>' +
            '</div></div></div>';
    });
    const parity = await page.evaluate(() => {
        const css = (sel: string, prop: string) => {
            const el = document.querySelector(sel) as HTMLElement;
            return getComputedStyle(el)[prop as 'fontSize'];
        };
        const full = (sel: string) => {
            const el = document.querySelector(sel) as HTMLElement;
            const cs = getComputedStyle(el);
            return { fontFamily: cs.fontFamily, fontSize: cs.fontSize };
        };
        const item = document.querySelector('.filter-value-item') as HTMLElement;
        const itemCs = getComputedStyle(item);
        const box = document.querySelector('.filter-value-item input[type="checkbox"]') as HTMLElement;
        const boxCs = getComputedStyle(box);
        const list = document.querySelector('.filter-values-container') as HTMLElement;
        const listCs = getComputedStyle(list);
        const chip = document.querySelector('.quick-filter-btn') as HTMLElement;
        const chipCs = getComputedStyle(chip);
        return {
            label: full('.filter-value-label'),
            count: full('.filter-value-count'),
            aggLabel: (() => { const el = document.getElementById('agg-label') as HTMLElement; const cs = getComputedStyle(el); return { fontFamily: cs.fontFamily, fontSize: cs.fontSize }; })(),
            aggDesc: (() => { const el = document.getElementById('agg-desc') as HTMLElement; const cs = getComputedStyle(el); return { fontFamily: cs.fontFamily, fontSize: cs.fontSize }; })(),
            itemPadding: itemCs.padding,
            itemGap: itemCs.gap,
            checkbox: { width: boxCs.width, height: boxCs.height, margin: boxCs.margin, accentColor: boxCs.accentColor },
            listChrome: { borderTopWidth: listCs.borderTopWidth, backgroundColor: listCs.backgroundColor },
            chip: { fontSize: chipCs.fontSize, fontFamily: chipCs.fontFamily },
            titleAccent: css('.filter-context-title', 'fontSize'),
        };
    });
    // Same mono type scale for labels (12px) and counts/descriptions (10px).
    expect(parity.label.fontSize).toBe(parity.aggLabel.fontSize);
    expect(parity.count.fontSize).toBe(parity.aggDesc.fontSize);
    expect(parity.label.fontFamily).toBe(parity.aggLabel.fontFamily);
    // Same row rhythm.
    expect(parity.itemPadding).toBe('5px 12px');
    expect(parity.itemGap).toBe('8px');
    // Same checkbox geometry as aggregation rows.
    expect(parity.checkbox.width).toBe('13px');
    expect(parity.checkbox.height).toBe('13px');
    expect(parity.checkbox.margin).toBe('0px');
    // Flat list: no box chrome, only a top separator.
    expect(parity.listChrome.borderTopWidth).toBe('1px');
    expect(parity.listChrome.backgroundColor).toContain('0, 0, 0, 0');
    // Compact 10px mono chips and context header.
    expect(parity.chip.fontSize).toBe('10px');
    expect(parity.titleAccent).toBe('10px');
});
