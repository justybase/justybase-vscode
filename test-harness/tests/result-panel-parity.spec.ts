import { test, expect, type Page } from '@playwright/test';

async function settleLayout(page: Page): Promise<void> {
  await page.addStyleTag({ content: '* { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

test('column filter dialog stays inside a short result panel', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto('/test-harness/shared-data-grid.html?profile=panel', { waitUntil: 'networkidle' });
  const panel = page.locator('#shared-ui-root');
  await expect(panel.locator('.ui-result-grid')).toBeVisible();
  await panel.getByRole('button', { name: 'Open filter for AMOUNT' }).click();
  const dialog = panel.getByRole('dialog', { name: 'Filter AMOUNT' });
  await expect(dialog).toBeVisible();
  const apply = dialog.getByRole('button', { name: 'Apply' });
  await expect(apply).toBeVisible();
  const box = await apply.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(420);
});

test('columns sidebar finder scrolls the grid to a searched result column', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 600 });
  await page.goto('/test-harness/shared-data-grid.html?profile=panel', { waitUntil: 'networkidle' });
  const panel = page.locator('#shared-ui-root');
  await expect(panel.locator('.ui-result-grid')).toBeVisible();
  const scroller = panel.locator('.ui-data-grid-scroll');
  await panel.getByRole('button', { name: 'Toggle column sidebar' }).click();
  const finder = panel.getByRole('textbox', { name: 'Find column' });

  await finder.fill('payload');
  await finder.press('Enter');

  await expect.poll(async () => scroller.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  const payloadHeader = panel.getByRole('columnheader', { name: /PAYLOAD/ });
  await expect(payloadHeader).toBeVisible();
  await expect(payloadHeader.locator('.ui-data-grid-column-highlight')).toHaveCount(1);
  await expect(finder).toHaveValue('payload');
});

test('columns sidebar jump reveals a partially hidden column while grouped', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 600 });
  await page.goto('/test-harness/shared-data-grid.html?profile=panel', { waitUntil: 'networkidle' });
  const panel = page.locator('#shared-ui-root');
  await expect(panel.locator('.ui-result-grid')).toBeVisible();
  await panel.getByRole('button', { name: 'Group by ID' }).click();
  await expect(panel.locator('.ui-data-grid-group-row').first()).toBeVisible();
  const scroller = panel.locator('.ui-data-grid-scroll');
  await panel.getByRole('button', { name: 'Toggle column sidebar' }).click();
  await settleLayout(page);

  // Park the last column a few pixels past the right edge, as a user would
  // when the target column is only slightly out of view.
  const initialLeft = await scroller.evaluate(element => {
    const header = [...element.querySelectorAll<HTMLTableCellElement>('.ui-data-grid thead th')]
      .find(cell => (cell.textContent ?? '').includes('PAYLOAD'))!;
    const contentLeft = header.getBoundingClientRect().left - element.getBoundingClientRect().left + element.scrollLeft;
    element.scrollLeft = Math.max(0, contentLeft + header.getBoundingClientRect().width - element.clientWidth - 20);
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
    return element.scrollLeft;
  });
  await expect.poll(async () => scroller.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  const finder = panel.getByRole('textbox', { name: 'Find column' });
  await finder.fill('payload');
  await finder.press('Enter');
  await expect.poll(async () => scroller.evaluate(element => element.scrollLeft)).toBeGreaterThan(initialLeft);

  // The reserved scrollbar gutter must not keep the final column hidden.
  const fullyVisible = await scroller.evaluate(element => {
    const header = [...element.querySelectorAll<HTMLTableCellElement>('.ui-data-grid thead th')]
      .find(cell => (cell.textContent ?? '').includes('PAYLOAD'))!;
    return header.getBoundingClientRect().right <= element.getBoundingClientRect().left + element.clientWidth + 1;
  });
  expect(fullyVisible).toBe(true);
  await expect(panel.getByRole('columnheader', { name: /PAYLOAD/ }).locator('.ui-data-grid-column-highlight')).toHaveCount(1);
});

test('columns sidebar jump uses painted column geometry when layout widths drift', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 600 });
  await page.goto('/test-harness/shared-data-grid.html?profile=panel', { waitUntil: 'networkidle' });
  const panel = page.locator('#shared-ui-root');
  await expect(panel.locator('.ui-result-grid')).toBeVisible();
  const scroller = panel.locator('.ui-data-grid-scroll');
  await panel.getByRole('button', { name: 'Toggle column sidebar' }).click();
  await settleLayout(page);
  const initialLeft = await scroller.evaluate(element => {
    const header = [...element.querySelectorAll<HTMLTableCellElement>('.ui-data-grid thead th')]
      .find(cell => (cell.textContent ?? '').includes('EVENT_AT'))!;
    const contentLeft = header.getBoundingClientRect().left - element.getBoundingClientRect().left + element.scrollLeft;
    element.scrollLeft = Math.max(0, contentLeft + header.getBoundingClientRect().width - element.clientWidth - 20);
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
    return element.scrollLeft;
  });
  await expect.poll(async () => scroller.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  const finder = panel.getByRole('textbox', { name: 'Find column' });
  await finder.fill('event_at');
  await finder.press('Enter');
  await expect.poll(async () => scroller.evaluate(element => element.scrollLeft)).toBeGreaterThan(initialLeft);
  const fullyVisible = await scroller.evaluate(element => {
    const header = [...element.querySelectorAll<HTMLTableCellElement>('.ui-data-grid thead th')]
      .find(cell => (cell.textContent ?? '').includes('EVENT_AT'))!;
    return header.getBoundingClientRect().right <= element.getBoundingClientRect().left + element.clientWidth + 1;
  });
  expect(fullyVisible).toBe(true);
});

test('columns sidebar jump mounts and fully reveals a windowed column', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 600 });
  await page.goto('/test-harness/shared-data-grid.html?profile=panel-wide', { waitUntil: 'networkidle' });
  const panel = page.locator('#shared-ui-root');
  await expect(panel.locator('.ui-result-grid')).toBeVisible();
  // DETAILS sits outside the mounted column window at scrollLeft 0 and its
  // long values make the painted column much wider than the layout estimate.
  await expect(panel.getByRole('columnheader', { name: /DETAILS/ })).toHaveCount(0);
  const scroller = panel.locator('.ui-data-grid-scroll');
  await panel.getByRole('button', { name: 'Toggle column sidebar' }).click();
  await settleLayout(page);
  const finder = panel.getByRole('textbox', { name: 'Find column' });
  await finder.fill('details');
  await finder.press('Enter');
  await expect(panel.getByRole('columnheader', { name: /DETAILS/ })).toHaveCount(1);
  const fullyVisible = (): Promise<boolean> => scroller.evaluate(element => {
    const header = [...element.querySelectorAll<HTMLTableCellElement>('.ui-data-grid thead th')]
      .find(cell => (cell.textContent ?? '').includes('DETAILS'));
    return header !== undefined
      && header.getBoundingClientRect().right <= element.getBoundingClientRect().left + element.clientWidth + 1;
  });
  await expect.poll(fullyVisible).toBe(true);
  await expect.poll(async () => scroller.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
});

test('columns sidebar reorders result columns by dragging', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 600 });
  await page.goto('/test-harness/shared-data-grid.html?profile=panel', { waitUntil: 'networkidle' });
  const panel = page.locator('#shared-ui-root');
  await expect(panel.locator('.ui-result-grid')).toBeVisible();
  await panel.getByRole('button', { name: 'Toggle column sidebar' }).click();
  const items = panel.locator('.ui-column-sidebar-list li');
  await expect(items).toHaveCount(8);
  await expect(items.nth(0)).toContainText('ID');

  await items.nth(2).dragTo(items.nth(0));
  await expect(items.nth(0)).toContainText('NAME');
  await expect(panel.locator('.ui-data-grid thead th').nth(1)).toContainText('NAME');
});

test('shared result panel keeps Excel-style filtering, grouping and inline editing', async ({ page }) => {
  await page.goto('/test-harness/shared-data-grid.html?profile=panel', { waitUntil: 'networkidle' });
  const panel = page.locator('#shared-ui-root');
  await expect(panel.locator('.ui-result-grid')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Edit data' })).toBeEnabled();
  await expect(panel.getByRole('tab', { name: 'Logs' })).toBeVisible();
  await settleLayout(page);
  await expect(panel).toHaveScreenshot('shared-result-panel.png');

  // The header packs its actions into the measured width instead of reserving
  // an empty trailing grid track for an element that never renders.
  const idHeaderMetrics = await panel.locator('.ui-data-grid thead th').nth(1).evaluate(th => {
    const content = th.querySelector<HTMLElement>('.ui-data-grid-header-content');
    const group = th.querySelector<HTMLElement>('.ui-data-grid-group-action');
    if (!content || !group) return null;
    return {
      trackCount: getComputedStyle(content).gridTemplateColumns.trim().split(/\s+/u).length,
      trailingGap: Math.round(content.getBoundingClientRect().right - group.getBoundingClientRect().right),
    };
  });
  expect(idHeaderMetrics).not.toBeNull();
  expect(idHeaderMetrics!.trackCount).toBe(6);
  expect(idHeaderMetrics!.trailingGap).toBeLessThan(20);

  // The Logs tab keeps its identity and clears logs instead of exposing edit controls.
  await panel.getByRole('tab', { name: 'Logs' }).click();
  await expect(panel.getByRole('button', { name: 'Clear Logs' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Edit data' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Columns' })).toHaveCount(0);
  await expect(panel.getByRole('textbox', { name: 'Filter results' })).toHaveCount(0);
  await expect(panel.getByRole('log', { name: 'Query log' })).toContainText('Shared panel fixture ready');
  await expect(panel.locator('.log-run[data-status="success"]')).toContainText('SUCCESS');
  await expect(panel.locator('.log-run[data-status="error"]')).toContainText('relation "MISSING" does not exist');
  await expect(panel).toHaveScreenshot('shared-result-logs.png');
  await panel.getByRole('tab', { name: 'Result 2' }).click();

  // Pinned columns stay at the left edge while the rest of the grid scrolls.
  await panel.getByRole('button', { name: 'Pin ID' }).click();
  await expect(panel.locator('.ui-data-grid thead th.ui-data-grid-pinned').first()).toContainText('ID');
  await panel.locator('.ui-data-grid-scroll').evaluate(element => {
    element.scrollLeft = 420;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await expect.poll(async () => panel.locator('.ui-data-grid thead th.ui-data-grid-pinned').first().evaluate(element => Math.round(element.getBoundingClientRect().left))).toBeLessThan(80);
  await panel.getByRole('button', { name: 'Unpin ID' }).click();

  // Excel-style footer aggregates are calculated from the filtered loaded rows.
  await panel.getByRole('button', { name: 'Open filter for AMOUNT' }).click();
  const aggregationDialog = panel.getByRole('dialog', { name: 'Filter AMOUNT' });
  await expect(aggregationDialog).toBeVisible();
  await aggregationDialog.getByRole('tab', { name: 'Summary' }).click();
  await aggregationDialog.getByRole('checkbox', { name: /Sum/ }).check();
  await aggregationDialog.getByRole('button', { name: 'Done' }).click();
  const aggregateRow = panel.locator('.ui-data-grid-aggregation-row-bottom').first();
  await expect(aggregateRow).toContainText('Σ');
  await expect(aggregateRow).toContainText('50,454.74');
  await settleLayout(page);
  await expect(panel).toHaveScreenshot('shared-result-aggregation.png');
  await panel.getByRole('button', { name: 'Open filter for AMOUNT' }).click();
  await panel.getByRole('tab', { name: 'Summary' }).click();
  await panel.getByRole('checkbox', { name: /Sum/ }).uncheck();
  await panel.getByRole('button', { name: 'Done' }).click();
  await expect(panel.locator('.ui-data-grid-aggregation-row')).toHaveCount(0);

  // Cell selection is projected to the host status bar as selection statistics.
  await panel.locator('td[data-column-index="0"]').first().click();
  await expect.poll(async () => page.evaluate(() => {
    const messages = (window as unknown as { __postedMessages?: Array<{ command: string; stats?: unknown }> }).__postedMessages ?? [];
    return messages.filter(message => message.command === 'selectionStatsChanged').at(-1)?.stats ?? null;
  })).toMatchObject({ cellCount: 1, type: 'numeric', sum: 1 });

  // Ctrl+click keeps a discontiguous selection and the status bar summarizes
  // only the toggled cells (legacy grid behaviour).
  const firstIdCell = panel.locator('td[data-column-index="0"]').nth(0);
  const secondIdCell = panel.locator('td[data-column-index="0"]').nth(1);
  await firstIdCell.click();
  await secondIdCell.click({ modifiers: ['Control'] });
  await expect(firstIdCell).toHaveClass(/ui-data-grid-cell-selected/);
  await expect(secondIdCell).toHaveClass(/ui-data-grid-cell-selected/);
  await expect.poll(async () => page.evaluate(() => {
    const messages = (window as unknown as { __postedMessages?: Array<{ command: string; stats?: unknown }> }).__postedMessages ?? [];
    return messages.filter(message => message.command === 'selectionStatsChanged').at(-1)?.stats ?? null;
  })).toMatchObject({ cellCount: 2, type: 'numeric', sum: 3 });

  // Double-click outside edit mode inserts a SQL-ready value into the active
  // editor, matching the legacy result grid.
  const insertedMessage = () => page.evaluate(() => {
    const messages = (window as unknown as { __postedMessages?: Array<Record<string, unknown>> }).__postedMessages ?? [];
    return messages.filter(message => message.command === 'insertCellContent').at(-1) ?? null;
  });
  await panel.locator('td[data-column-index="0"]').first().dblclick();
  await expect.poll(insertedMessage).toMatchObject({ text: '1', dataType: 'INTEGER', sqlText: '1' });
  await panel.getByRole('cell', { name: 'needle-start customer-000000' }).dblclick();
  await expect.poll(insertedMessage).toMatchObject({
    text: 'needle-start customer-000000',
    dataType: 'VARCHAR(160)',
    sqlText: "'needle-start customer-000000'",
  });

  // Excel-style filter from the column header, with typed operators.
  await panel.getByRole('button', { name: 'Open filter for NAME' }).click();
  const dialog = panel.getByRole('dialog', { name: 'Filter NAME' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Filter condition for NAME' }).selectOption('contains');
  await dialog.getByRole('textbox', { name: 'Filter value for NAME' }).fill('needle');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(panel.getByRole('cell', { name: 'needle-start customer-000000' })).toBeVisible();
  await expect(panel.getByRole('cell', { name: 'customer-000001' })).toHaveCount(0);

  await panel.getByRole('button', { name: 'Open filter for NAME' }).click();
  await panel.getByRole('button', { name: 'Clear filter' }).click();
  await expect(panel.getByRole('cell', { name: 'customer-000001' })).toBeVisible();

  // The toolbar Sort/Group shortcuts were removed; sorting and grouping stay
  // available from the column headers and the grouping panel.
  await expect(panel.getByRole('button', { name: 'Sort', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Group', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Group by ID' }).click();
  await expect(panel.locator('.ui-data-grid-group-panel')).toContainText('ID');
  await expect(panel.locator('.ui-data-grid-group-row').first()).toBeVisible();
  const groupToggle = panel.locator('.ui-data-grid-group-toggle').first();
  const groupMarker = groupToggle.locator('.ui-data-grid-group-marker');
  const groupLabel = groupToggle.locator('.ui-data-grid-group-label');
  await groupToggle.hover();
  expect(await groupToggle.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('none');
  const toggleBox = await groupToggle.boundingBox();
  const markerBox = await groupMarker.boundingBox();
  const labelBox = await groupLabel.boundingBox();
  expect(toggleBox).not.toBeNull();
  expect(markerBox).not.toBeNull();
  expect(labelBox).not.toBeNull();
  // The chevron sits at the left edge of the band and the label follows it, so
  // the whole name is part of the button rather than a separate inert text run.
  expect(markerBox!.x - toggleBox!.x).toBeLessThan(6);
  expect(Math.abs(markerBox!.y + markerBox!.height / 2 - (toggleBox!.y + toggleBox!.height / 2))).toBeLessThan(2);
  expect(labelBox!.x).toBeGreaterThanOrEqual(markerBox!.x + markerBox!.width - 1);
  expect(labelBox!.width).toBeGreaterThan(20);
  expect(toggleBox!.width).toBeGreaterThan(labelBox!.width);
  // Clicking the visible name (not just the arrow) expands the band.
  await groupLabel.click();
  await expect(groupToggle).toHaveAttribute('aria-expanded', 'true');
  await groupLabel.click();
  await expect(groupToggle).toHaveAttribute('aria-expanded', 'false');
  // Group bands stay anchored to the left edge while data scrolls sideways.
  const groupCell = panel.locator('.ui-data-grid-group-cell').first();
  const groupContent = panel.locator('.ui-data-grid-group-content').first();
  await panel.locator('.ui-data-grid-scroll').evaluate(element => {
    element.scrollLeft = 640;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await expect.poll(async () => Math.round((await groupContent.boundingBox())?.x ?? -999)).toBeGreaterThanOrEqual(0);
  const contentBox = await groupContent.boundingBox();
  expect(contentBox).not.toBeNull();
  expect(contentBox!.x).toBeLessThan(160);
  await expect(groupContent).toBeInViewport();
  await expect(groupCell).toContainText('ID');
  await panel.locator('.ui-data-grid-scroll').evaluate(element => {
    element.scrollLeft = 0;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await panel.getByRole('button', { name: 'Remove grouping ID' }).click();
  await expect(panel.locator('.ui-data-grid-group-row')).toHaveCount(0);

  // Keyboard copy and the toolbar Copy button both publish the rich + plain
  // representations so the receiving application can choose HTML, Markdown or
  // tabbed text (the legacy multi-format clipboard contract).
  await page.evaluate(() => {
    const target = window as unknown as { __clipboardWrites: Array<Record<string, string>> };
    target.__clipboardWrites = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        write: async (items: ClipboardItems) => {
          const entry: Record<string, string> = {};
          for (const item of items) {
            for (const type of item.types) {
              entry[type] = await (await item.getType(type)).text();
            }
          }
          target.__clipboardWrites.push(entry);
        },
        writeText: async (text: string) => {
          target.__clipboardWrites.push({ text });
        },
      },
    });
  });
  await panel.locator('td[data-column-index="0"]').first().click();
  await page.keyboard.press('Control+c');
  await expect.poll(async () => page.evaluate(() => {
    const writes = (window as unknown as { __clipboardWrites?: Array<Record<string, string>> }).__clipboardWrites ?? [];
    return Object.keys(writes.at(-1) ?? {});
  })).toEqual(['text/html', 'text/plain']);
  const keyboardCopy = await page.evaluate(() => {
    const writes = (window as unknown as { __clipboardWrites?: Array<Record<string, string>> }).__clipboardWrites ?? [];
    return writes.at(-1) ?? {};
  });
  expect(keyboardCopy['text/html']).toContain('<table');
  expect(keyboardCopy['text/plain']).toContain('| ID |');

  await panel.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect.poll(async () => page.evaluate(() => {
    const writes = (window as unknown as { __clipboardWrites?: Array<Record<string, string>> }).__clipboardWrites ?? [];
    return writes.length;
  })).toBeGreaterThan(1);
  const buttonCopy = await page.evaluate(() => {
    const writes = (window as unknown as { __clipboardWrites?: Array<Record<string, string>> }).__clipboardWrites ?? [];
    return writes.at(-1) ?? {};
  });
  expect(buttonCopy['text/html']).toContain('<table');
  expect(buttonCopy['text/plain']).toContain('| ID | AMOUNT |');

  // Plain-only formats must not smuggle an HTML table to rich editors.
  await panel.locator('td[data-column-index="0"]').first().click({ button: 'right' });
  await panel.getByRole('menuitem', { name: 'Copy row as JSON' }).click();
  await expect.poll(async () => page.evaluate(() => {
    const writes = (window as unknown as { __clipboardWrites?: Array<Record<string, string>> }).__clipboardWrites ?? [];
    return Object.keys(writes.at(-1) ?? {});
  })).toEqual(['text']);
  const jsonCopy = await page.evaluate(() => {
    const writes = (window as unknown as { __clipboardWrites?: Array<Record<string, string>> }).__clipboardWrites ?? [];
    return writes.at(-1) ?? {};
  });
  expect(jsonCopy.text?.trimStart().startsWith('[')).toBe(true);

  // Inline editing stages a change and can discard it without touching the host.
  await panel.getByRole('button', { name: 'Edit data' }).click();
  await panel.getByRole('cell', { name: 'needle-start customer-000000' }).dblclick();
  const editor = panel.getByRole('textbox', { name: 'Edit NAME' });
  await editor.fill('edited-customer');
  await editor.press('Enter');
  await expect(panel.getByRole('button', { name: 'Save 1 change' })).toBeEnabled();
  await panel.getByRole('button', { name: 'Discard' }).click();
  await expect(panel.getByRole('cell', { name: 'needle-start customer-000000' })).toBeVisible();
});

test('layout switcher renders range charts with chart-type controls', async ({ page }) => {
  await page.goto('/test-harness/shared-data-grid.html?profile=panel', { waitUntil: 'networkidle' });
  const panel = page.locator('#shared-ui-root');
  await expect(panel.locator('.ui-result-grid')).toBeVisible();
  // A 2x2+ grid selection narrows the chart to that range, like the legacy
  // toolbar action. ID and AMOUNT are both numeric, so three selected rows
  // become three synthetic categories and two series.
  await panel.locator('td[data-column-index="0"]').nth(0).click();
  await panel.locator('td[data-column-index="1"]').nth(2).click({ modifiers: ['Shift'] });
  await panel.getByRole('button', { name: 'Analyze' }).click();
  await panel.getByRole('menuitemradio', { name: 'Charts', exact: true }).click();
  const charts = panel.getByRole('region', { name: 'Charts' });
  await expect(charts).toBeVisible();
  await expect(charts.locator('.ui-range-chart-title')).toContainText('3 categories · 2 series');
  await expect(charts.getByRole('combobox', { name: 'Chart type' })).toHaveValue('column-grouped');
  await expect(charts.getByRole('combobox', { name: 'Chart category' })).toBeVisible();
  await expect(charts.locator('.ui-range-chart-canvas canvas')).toBeVisible();
  await charts.getByRole('combobox', { name: 'Chart type' }).selectOption('line');
  await expect(charts.locator('.ui-range-chart-canvas canvas')).toBeVisible();
  await panel.getByRole('button', { name: 'Table' }).click();
  await expect(panel.locator('.ui-data-grid')).toBeVisible();
});

test('layout switcher renders Mini Charts for numeric columns', async ({ page }) => {
  await page.goto('/test-harness/shared-data-grid.html?profile=panel', { waitUntil: 'networkidle' });
  const panel = page.locator('#shared-ui-root');
  await expect(panel.locator('.ui-result-grid')).toBeVisible();
  await panel.getByRole('button', { name: 'Analyze' }).click();
  await panel.getByRole('menuitemradio', { name: 'Mini Charts' }).click();
  const charts = panel.getByRole('region', { name: 'Mini Charts' });
  await expect(charts).toBeVisible();
  await expect(charts.locator('.ui-mini-chart-card')).toHaveCount(4);
  await expect(charts).toContainText('AMOUNT');
  await expect(charts.locator('.ui-mini-chart-sparkline path')).toHaveCount(4);
  await panel.getByRole('button', { name: 'Table' }).click();
  await expect(panel.locator('.ui-data-grid')).toBeVisible();
});

test('layout switcher renders the Diff view against another result set', async ({ page }) => {
  await page.goto('/test-harness/shared-data-grid.html?profile=panel&baseline', { waitUntil: 'networkidle' });
  const panel = page.locator('#shared-ui-root');
  await expect(panel.locator('.ui-result-grid')).toBeVisible();
  await panel.getByRole('button', { name: 'Analyze' }).click();
  await panel.getByRole('menuitemradio', { name: 'Diff' }).click();
  const diff = panel.getByRole('region', { name: 'Diff Results' });
  await expect(diff).toBeVisible();
  await expect(diff.getByRole('combobox', { name: 'Diff baseline' })).toContainText('Result 3');
  await expect(diff.locator('.ui-diff-summary')).toContainText('Changed: 1');
  await expect(diff.locator('.ui-diff-cell-before').first()).toContainText('-999.99');
  await expect(diff.locator('.ui-diff-cell-after').first()).toContainText('726.82');
});

test('layout switcher mounts the Explore view with its tabs and column cards', async ({ page }) => {
  await page.goto('/test-harness/shared-data-grid.html?profile=panel', { waitUntil: 'networkidle' });
  const panel = page.locator('#shared-ui-root');
  await expect(panel.locator('.ui-result-grid')).toBeVisible();
  await panel.getByRole('button', { name: 'Analyze' }).click();
  await panel.getByRole('menuitemradio', { name: 'Explore' }).click();
  const explore = panel.locator('.explore-view');
  await expect(explore).toBeVisible();
  await expect(explore.getByRole('tab', { name: 'Columns' })).toBeVisible();
  await expect(explore.getByRole('tab', { name: 'Pivot' })).toBeVisible();
  await expect(explore.getByRole('tab', { name: 'Charts' })).toBeVisible();
  await expect(explore.locator('.explore-column-card')).toHaveCount(8);
  await explore.getByRole('tab', { name: 'Pivot' }).click();
  await expect(explore.locator('.explore-tab-config')).toBeVisible();
  // Reusable SQL from the active result enables the server-side actions
  // instead of falling back to sample-only exploration.
  const runPivot = explore.getByRole('button', { name: 'Run Pivot' });
  await expect(runPivot).toBeEnabled();
  await runPivot.click();
  const pivotRequest = await page.evaluate(async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const found = ((window as unknown as { __postedMessages?: Array<Record<string, unknown>> }).__postedMessages ?? [])
        .find(message => message.command === 'requestExploreOperation'
          && (message.operation as { kind?: string } | undefined)?.kind === 'pivot');
      if (found) return found as { sourceUri?: string; resultSetIndex?: number };
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return null;
  });
  expect(pivotRequest?.resultSetIndex).toBe(1);
  expect(pivotRequest?.sourceUri).toBeTruthy();
});

test('layout switcher restores the Analytical view', async ({ page }) => {
  await page.goto('/test-harness/shared-data-grid.html?profile=panel', { waitUntil: 'networkidle' });
  const panel = page.locator('#shared-ui-root');
  await expect(panel.locator('.ui-result-grid')).toBeVisible();
  await panel.getByRole('button', { name: 'Analyze' }).click();
  await panel.getByRole('menuitemradio', { name: 'Analytical' }).click();
  const analytical = panel.getByRole('region', { name: 'Analytical view' });
  await expect(analytical).toBeVisible();
  await expect(analytical).toContainText('Groups compared with the whole result');
  await analytical.getByRole('combobox', { name: 'Analytical group column', exact: true }).selectOption({ label: 'CATEGORY' });
  await expect(analytical.locator('.ui-analytical-status')).toContainText('5 groups');
  await expect(analytical.locator('.ui-analytical-groups tbody tr')).toHaveCount(5);
  await analytical.getByRole('combobox', { name: 'Analytical group column 2' }).selectOption({ label: 'ACTIVE' });
  await expect(analytical.locator('.ui-analytical-status')).toContainText('10 groups');
  await expect(analytical.locator('.ui-analytical-groups tbody tr')).toHaveCount(10);
  await analytical.locator('.ui-analytical-groups tbody tr').first().click();
  await expect(analytical.locator('.ui-analytical-detail-title')).toContainText('rows');
  await expect(analytical.locator('.ui-analytical-detail table')).toContainText('AMOUNT');
  await panel.getByRole('button', { name: 'Table' }).click();
  await expect(panel.locator('.ui-data-grid')).toBeVisible();
});

test('Pivot dialog explains and configures the matrix before running', async ({ page }) => {
  await page.goto('/test-harness/shared-data-grid.html?profile=panel', { waitUntil: 'networkidle' });
  const panel = page.locator('#shared-ui-root');
  await expect(panel.locator('.ui-result-grid')).toBeVisible();
  await panel.getByRole('button', { name: 'Pivot' }).click();
  const dialog = panel.getByRole('dialog', { name: 'Create pivot' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Rows become the first column');
  // ID is the first dimension, ACTIVE has the lowest cardinality, AMOUNT is the
  // first numeric measure; the second raw column (NAME) must not be pivoted.
  await expect(dialog.getByRole('combobox', { name: 'Pivot rows' })).toHaveValue('0');
  await expect(dialog.getByRole('combobox', { name: 'Pivot columns' })).toHaveValue('5');
  await expect(dialog.getByRole('combobox', { name: 'Pivot values' })).toHaveValue('1');
  await expect(dialog.getByRole('combobox', { name: 'Pivot aggregation' })).toHaveValue('sum');
  await dialog.getByRole('button', { name: 'Create pivot' }).click();
  const request = await page.evaluate(async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const found = ((window as unknown as { __postedMessages: Array<Record<string, unknown>> }).__postedMessages)
        .find(message => message.command === 'requestDatabaseGrouping');
      if (found) return found as {
        requestId: number;
        sourceUri: string;
        resultSetIndex: number;
        grouping: {
          groupByColumns: Array<{ columnIndex: number }>;
          functions: Array<{ fn: string; columnIndex?: number; alias?: string }>;
          orderBy?: Array<{ columnIndex: number; desc: boolean }>;
          limit?: number;
        };
      };
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return null;
  });
  expect(request).not.toBeNull();
  expect(request?.grouping.groupByColumns.map(column => column.columnIndex)).toEqual([0, 5]);
  expect(request?.grouping.functions).toEqual([{ fn: 'sum', columnIndex: 1, alias: 'SUM_AMOUNT' }]);
  // A pivot must be ordered by its dimensions, not by the aggregate; the
  // extra requested row lets the host report a capped matrix as partial.
  expect(request?.grouping.orderBy).toEqual([
    { columnIndex: 0, desc: false },
    { columnIndex: 1, desc: false },
  ]);
  expect(request?.grouping.limit).toBe(10001);
  await page.evaluate(item => {
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        command: 'databaseGroupingResult',
        requestId: item.requestId,
        sourceUri: item.sourceUri,
        resultSetIndex: item.resultSetIndex,
        columns: [
          { name: 'ID', type: 'INTEGER' },
          { name: 'ACTIVE', type: 'BOOLEAN' },
          { name: 'SUM_AMOUNT', type: 'NUMERIC(18,2)' },
          { name: 'ROW_COUNT_PERCENTAGE', type: 'DOUBLE' },
        ],
        rows: [[1, true, 10.5, 1], [1, false, 20.5, 1], [2, true, 30.5, 1]],
        totalRows: 3,
      },
    }));
  }, request!);
  const analysis = panel.locator('.ui-result-analysis');
  await expect(analysis).toContainText('Pivot result');
  await expect(analysis).toContainText('Sum of AMOUNT');
  await expect(analysis).toContainText('2 rows · 2 pivot values');
  await expect(analysis).toContainText('30.50');
  await expect(analysis.locator('.ui-data-grid-group-panel')).toHaveCount(0);

  // Pivot is a layout: it replaces the source table instead of stacking a
  // second grid above it, and the table-only toolbar actions disappear.
  await expect(panel.locator('.ui-result-main-split > .ui-result-analysis')).toBeVisible();
  const pivotBox = await analysis.boundingBox();
  expect(pivotBox?.height ?? 0).toBeGreaterThan(400);
  await expect(panel.locator('.ui-result-main-split > .ui-result-grid')).toHaveCount(0);
  await expect(panel.locator('.ui-data-grid')).toHaveCount(1);
  await expect(panel.getByRole('button', { name: 'Edit data' })).toHaveCount(0);
  await expect(panel.getByRole('textbox', { name: 'Filter results' })).toHaveCount(0);

  // The pivot grid is a normal in-memory result: sorting and filtering the
  // matrix work instead of rendering controls that silently do nothing.
  await analysis.getByRole('textbox', { name: 'Filter ID' }).fill('2');
  await expect(analysis.getByRole('cell', { name: '1' })).toHaveCount(0);
  await expect(analysis.getByRole('cell', { name: '2' })).toBeVisible();
  await analysis.getByRole('textbox', { name: 'Filter ID' }).fill('');
  await analysis.getByRole('button', { name: 'Close result analysis' }).click();
  await expect(panel.locator('.ui-result-grid')).toBeVisible();
});

test('Row View compares several selected rows vertically', async ({ page }) => {
  await page.goto('/test-harness/shared-data-grid.html?profile=panel', { waitUntil: 'networkidle' });
  const panel = page.locator('#shared-ui-root');
  await expect(panel.locator('.ui-result-grid')).toBeVisible();
  await panel.getByRole('button', { name: 'Select row 1', exact: true }).click();
  await panel.getByRole('button', { name: 'Select row 3', exact: true }).click({ modifiers: ['Shift'] });
  await panel.getByRole('button', { name: 'Row View' }).click();

  const rowView = panel.locator('.ui-row-view-panel');
  await expect(rowView).toBeVisible();
  await expect(rowView).toContainText('Row Details & Comparison');
  await expect(rowView).toContainText('Row 1');
  await expect(rowView).toContainText('Row 3');
  const amountSection = rowView.locator('.row-view-section').filter({ hasText: 'AMOUNT' });
  await expect(amountSection).toHaveClass(/diff/);
  await expect(amountSection).toContainText('-153.82');
  await expect(amountSection).toContainText('726.82');
  await expect(amountSection).toContainText('-171.96');
  await expect(rowView.locator('.row-view-section').filter({ hasText: 'ID' })).toHaveClass(/diff/);
  await settleLayout(page);
  await expect(panel).toHaveScreenshot('shared-result-row-view.png');

  await rowView.getByRole('button', { name: 'Close row view' }).click();
  await expect(rowView).toHaveCount(0);
});

test('dragging a header reveals the grouping drop strip', async ({ page }) => {
  await page.goto('/test-harness/shared-data-grid.html?profile=panel', { waitUntil: 'networkidle' });
  const panel = page.locator('#shared-ui-root');
  const handle = panel.locator('.ui-data-grid-drag-handle').first();
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  if (!box) throw new Error('header drag handle is not laid out');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 24, box.y + box.height / 2 + 12, { steps: 6 });
  await expect(panel.locator('.ui-data-grid-group-panel-dragging')).toBeVisible();
  await expect(panel.locator('.ui-data-grid-group-panel')).toContainText('Drop the column here to group');
  const strip = await panel.locator('.ui-data-grid-group-panel').boundingBox();
  if (!strip) throw new Error('grouping drop strip is not laid out');
  // Moving onto the revealed strip makes it the active drop target.
  await page.mouse.move(strip.x + strip.width / 2, strip.y + strip.height / 2, { steps: 3 });
  await page.mouse.up();
  await expect(panel.locator('.ui-data-grid-group-panel')).toContainText('Group by');
  await expect(panel.locator('.ui-data-grid-group-chip')).toContainText('ID');
});

test('shared-only shell keeps the row gutter compact and drops legacy scaffolding', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto('/test-harness/shared-result-panel.html', { waitUntil: 'networkidle' });
  const panel = page.locator('#shared-ui-root');
  await expect(panel.locator('.ui-result-grid')).toBeVisible();
  await expect(panel.getByRole('toolbar', { name: 'Result view controls' })).toBeVisible();
  await expect(page.locator('#layoutWrapper')).toHaveCount(0);
  await expect(page.locator('#globalFilter')).toHaveCount(0);
  await expect(page.locator('link[href*="resultPanel.css"]')).toHaveCount(0);

  const metrics = await page.evaluate(() => {
    const gutter = document.querySelector<HTMLElement>('.ui-data-grid thead .ui-data-grid-row-number');
    const toolbar = document.querySelector<HTMLElement>('.ui-result-toolbar');
    const table = document.querySelector<HTMLElement>('.ui-data-grid');
    const root = document.getElementById('shared-ui-root');
    const rect = (element: HTMLElement | null) => element ? element.getBoundingClientRect() : null;
    const gutterRect = rect(gutter);
    const toolbarRect = rect(toolbar);
    const tableRect = rect(table);
    const rootRect = rect(root);
    return {
      gutterWidth: gutterRect?.width ?? -1,
      toolbarLeft: toolbarRect?.left ?? -1,
      tableLeft: tableRect?.left ?? -1,
      rootLeft: rootRect?.left ?? -1,
      bodyPaddingLeft: getComputedStyle(document.body).paddingLeft,
    };
  });
  // The fixed-width row gutter must not absorb the table's spare width: that
  // used to leave a wide empty strip between the panel edge and the row
  // numbers. The trailing fill column owns the slack instead.
  expect(metrics.gutterWidth).toBeGreaterThan(0);
  expect(metrics.gutterWidth).toBeLessThanOrEqual(56);
  expect(metrics.bodyPaddingLeft).toBe('0px');
  expect(Math.abs(metrics.toolbarLeft - metrics.tableLeft)).toBeLessThan(2);
  expect(Math.abs(metrics.toolbarLeft - metrics.rootLeft)).toBeLessThan(2);
  expect(Math.abs(metrics.tableLeft - metrics.rootLeft)).toBeLessThan(2);
});
