import { test, expect, type Page } from '@playwright/test';

type ManagerState = Record<string, unknown>;

const STATE: ManagerState = {
    tab: 'relations',
    relations: [
        {
            key: 'rel-manual',
            tables: 'CUSTOMERS → ORDERS',
            predicate: 'CUSTOMERS.CUSTOMER_ID = ORDERS.CUSTOMER_ID',
            left: { table: 'CUSTOMERS' },
            right: { table: 'ORDERS' },
            columns: [{ left: 'CUSTOMER_ID', right: 'CUSTOMER_ID' }],
            decision: 'none',
            favorite: false,
            scoreAdjustment: 0,
            tier: '0_0_',
            rankLabel: 'Configured manual relation (0_0_)',
            sources: [{ kind: 'configured', label: 'justybase.sql.joinRelations' }],
            explanation: ['configured in justybase.sql.joinRelations (tier 0_0_, manual)'],
            configured: true,
            overrideIds: {},
        },
        {
            key: 'rel-confirmed',
            tables: 'USERS → ORDERS',
            predicate: 'USERS.USER_ID = ORDERS.OWNER_ID',
            left: { table: 'USERS' },
            right: { table: 'ORDERS' },
            columns: [{ left: 'USER_ID', right: 'OWNER_ID' }],
            decision: 'confirmed',
            favorite: false,
            scoreAdjustment: 0,
            tier: '0_1_',
            rankLabel: 'Confirmed by user (0_1_)',
            sources: [{ kind: 'confirmed', label: 'Confirmed', detail: 'Tier 0_1_' }],
            explanation: ['explicit per-relation confirmation (tier 0_1_)'],
            configured: false,
            overrideIds: { confirm: 'rel-confirm-1' },
        },
        {
            key: 'rel-favorite',
            tables: 'PRODUCTS → SUPPLIERS',
            predicate: 'PRODUCTS.SUPPLIER_ID = SUPPLIERS.ID',
            left: { table: 'PRODUCTS' },
            right: { table: 'SUPPLIERS' },
            columns: [{ left: 'SUPPLIER_ID', right: 'ID' }],
            decision: 'favorite',
            favorite: true,
            scoreAdjustment: 0,
            tier: '0_3_',
            rankLabel: 'Favorite preference (0_3_, not confirmation)',
            sources: [{ kind: 'favorite', label: 'Favorite' }],
            explanation: ['manual favorite preference (tier 0_3_; not confirmation)'],
            configured: false,
            overrideIds: { favorite: 'rel-fav-1' },
        },
        {
            key: 'rel-workspace',
            tables: 'ACCOUNTS → ORDERS',
            predicate: 'ACCOUNTS.ACCOUNT_ID = ORDERS.OWNER_ID',
            left: { table: 'ACCOUNTS' },
            right: { table: 'ORDERS' },
            columns: [{ left: 'ACCOUNT_ID', right: 'OWNER_ID' }],
            decision: 'none',
            favorite: false,
            scoreAdjustment: 0,
            tier: '0_5_',
            rankLabel: 'Workspace SQL evidence (0_5_)',
            sources: [{ kind: 'workspace', label: 'Workspace SQL', detail: '2 file(s)' }],
            explanation: ['workspace evidence is eligible: 2 file(s), 2 query(ies)'],
            workspace: { observations: 4, distinctFiles: 2, distinctQueries: 2, acceptedSelections: 2, weightedQueries: 3, belowThreshold: false },
            configured: false,
            overrideIds: {},
        },
        {
            key: 'rel-below',
            tables: 'DEPOTS → ORDERS',
            predicate: 'DEPOTS.DEPOT_ID = ORDERS.DEPOT_ID',
            left: { table: 'DEPOTS' },
            right: { table: 'ORDERS' },
            columns: [{ left: 'DEPOT_ID', right: 'DEPOT_ID' }],
            decision: 'none',
            favorite: false,
            scoreAdjustment: 0,
            tier: 'below',
            rankLabel: 'Below threshold (stored, never ranked)',
            sources: [{ kind: 'workspace', label: 'Workspace SQL' }],
            explanation: ['workspace evidence is below threshold'],
            workspace: { observations: 1, distinctFiles: 1, distinctQueries: 1, acceptedSelections: 0, weightedQueries: 1, belowThreshold: true },
            configured: false,
            overrideIds: {},
        },
        {
            key: 'rel-blocked',
            tables: 'BAD → WORSE',
            predicate: 'BAD.ID = WORSE.ID',
            left: { table: 'BAD' },
            right: { table: 'WORSE' },
            columns: [{ left: 'ID', right: 'ID' }],
            decision: 'blocked',
            favorite: false,
            scoreAdjustment: 0,
            tier: 'blocked',
            rankLabel: 'Blocked (removed before tiering)',
            sources: [{ kind: 'blocked', label: 'Blocked' }],
            explanation: ['blocked by an explicit manual decision (applied before tiering)'],
            configured: false,
            overrideIds: { block: 'rel-block-1' },
        },
    ],
    objects: [
        {
            key: 'obj-pin',
            label: 'ADMIN.CUSTOMERS',
            name: 'CUSTOMERS',
            kind: 'pin',
            pinOrder: 1,
            tier: '2_1',
            rankLabel: 'Pinned at 1 (sortText only)',
            explanation: ['manual pin order 1; crosses scope/kind, sortText only'],
            overrideId: 'obj-pin-1',
        },
        {
            key: 'obj-boost',
            label: 'ADMIN.PRODUCTS',
            name: 'PRODUCTS',
            kind: 'boost',
            band: 7,
            tier: '07',
            rankLabel: 'Boosted to band 07',
            explanation: ['manual boost band 07; inside scope/kind/match rank'],
            overrideId: 'obj-boost-1',
            usage: { select: 4, insert: 0, update: 0, delete: 0, distinctFiles: 2, distinctQueries: 4, belowThreshold: false },
        },
        {
            key: 'obj-learned',
            label: 'ADMIN.LEARNED',
            name: 'LEARNED',
            kind: 'learned',
            band: 12,
            tier: '12',
            rankLabel: 'Workspace usage band 12',
            explanation: ['workspace usage moved the band inside match rank/scope/kind'],
            usage: { select: 5, insert: 0, update: 0, delete: 0, distinctFiles: 2, distinctQueries: 5, belowThreshold: false },
        },
        {
            key: 'obj-below',
            label: 'ADMIN.SINGLE',
            name: 'SINGLE',
            kind: 'neutral',
            tier: 'below',
            rankLabel: 'Below threshold (stored, never ranked)',
            explanation: ['workspace usage is below threshold and never ranked'],
            usage: { select: 1, insert: 0, update: 0, delete: 0, distinctFiles: 1, distinctQueries: 1, belowThreshold: true },
        },
    ],
    meta: {
        indexingEnabled: true,
        personalizeEnabled: true,
        truncated: false,
        gitMode: 'all',
        filesIndexed: 5,
        lastIndexedAt: '2026-10-25T10:00:00.000Z',
        configuredCount: 1,
        counts: {
            relations: 6,
            confirmed: 1,
            blocked: 1,
            favorites: 1,
            objects: 4,
            pinned: 1,
            excluded: 0,
        },
    },
};

async function open(page: Page, options: { persisted?: unknown; state?: ManagerState } = {}): Promise<void> {
    await page.addInitScript(({ state, persisted }) => {
        (window as unknown as { __managerState: unknown }).__managerState = state;
        (window as unknown as { __managerPersisted: unknown }).__managerPersisted = persisted;
    }, { state: options.state ?? STATE, persisted: options.persisted });
    await page.goto('/test-harness/join-knowledge.html', { waitUntil: 'networkidle' });
    await page.waitForSelector('.jk-row');
}

async function posted(page: Page): Promise<Array<Record<string, unknown>>> {
    return page.evaluate(() => (window as unknown as { __posted?: Array<Record<string, unknown>> }).__posted ?? []);
}

test.describe('JOIN Knowledge manager', () => {
    test('renders every knowledge source with its rank and filters blocked relations', async ({ page }) => {
        const pageErrors: Error[] = [];
        page.on('pageerror', error => pageErrors.push(error));
        await open(page);
        expect(pageErrors).toEqual([]);
        await expect(page.locator('.jk-row')).toHaveCount(6);
        await expect(page.locator('.jk-row', { hasText: 'CUSTOMERS → ORDERS' })).toContainText('0_0_');
        await expect(page.locator('.jk-row', { hasText: 'USERS → ORDERS' })).toContainText('0_1_');
        await expect(page.locator('.jk-row', { hasText: 'PRODUCTS → SUPPLIERS' })).toContainText('0_3_');
        await expect(page.locator('.jk-row', { hasText: 'ACCOUNTS → ORDERS' })).toContainText('0_5_');
        await expect(page.locator('.jk-row', { hasText: 'DEPOTS → ORDERS' })).toContainText('below');

        await page.locator('#filter').selectOption('blocked');
        await expect(page.locator('.jk-row')).toHaveCount(1);
        await expect(page.locator('.jk-row')).toContainText('BAD → WORSE');
        await page.locator('#filter').selectOption('all');
        await expect(page.locator('.jk-row')).toHaveCount(6);
    });

    test('renders executed evidence and sends per-item and global clear actions', async ({ page }) => {
        const executedState = {
            tab: 'relations',
            relations: [{
                key: 'rel-executed',
                tables: 'USERS → ORDERS',
                predicate: 'USERS.USER_ID = ORDERS.OWNER_ID',
                left: { table: 'USERS' },
                right: { table: 'ORDERS' },
                columns: [{ left: 'USER_ID', right: 'OWNER_ID' }],
                decision: 'none',
                favorite: false,
                scoreAdjustment: 0,
                tier: '0_4_',
                rankLabel: 'Executed successfully (0_4_, observed; not semantic confirmation)',
                sources: [{ kind: 'executed', label: 'Executed successfully', detail: '2 execution(s), 2 day(s)' }],
                explanation: ['executed evidence is eligible; success is not semantic confirmation'],
                executed: { observations: 2, distinctDays: 2, belowThreshold: false },
                configured: false,
                overrideIds: {},
            }],
            objects: [{
                key: 'obj-executed',
                label: 'ADMIN.ORDERS',
                name: 'ORDERS',
                kind: 'learned',
                band: 30,
                tier: '30',
                rankLabel: 'Executed usage band 30',
                explanation: ['executed usage SELECT 2; band 30'],
                executed: {
                    usage: { select: 2, insert: 0, update: 0, delete: 0 },
                    observations: 2,
                    distinctDays: 2,
                    band: 30,
                    belowThreshold: false,
                },
            }],
            meta: {
                indexingEnabled: true,
                personalizeEnabled: true,
                truncated: false,
                gitMode: 'all',
                filesIndexed: 1,
                configuredCount: 0,
                counts: { relations: 1, confirmed: 0, blocked: 0, favorites: 0, objects: 1, pinned: 0, excluded: 0 },
                execution: {
                    relations: 1,
                    relationsBelowThreshold: 0,
                    objects: 1,
                    objectsBelowThreshold: 0,
                    truncated: false,
                    observed: 2,
                    recorded: 2,
                    duplicates: 0,
                    notDurable: 0,
                    skipped: {},
                },
            },
        };
        await open(page, { state: executedState });
        await expect(page.locator('.jk-row')).toHaveCount(1);
        await expect(page.locator('.jk-row')).toContainText('0_4_');
        await page.locator('#filter').selectOption('executed');
        await expect(page.locator('.jk-row')).toHaveCount(1);
        await page.locator('.jk-row').click();
        await expect(page.locator('#detail')).toContainText('Executed evidence');
        await page.locator('#detail').getByRole('button', { name: 'Clear executed evidence' }).click();
        let messages = await posted(page);
        expect(messages).toContainEqual(expect.objectContaining({
            type: 'clearExecutedEvidence',
            kind: 'relation',
            key: 'rel-executed',
        }));

        await page.locator('#tab-objects').click();
        await page.locator('.jk-row').click();
        await expect(page.locator('#detail')).toContainText('Executed usage');
        await page.locator('#detail').getByRole('button', { name: 'Clear executed usage' }).click();
        messages = await posted(page);
        expect(messages).toContainEqual(expect.objectContaining({
            type: 'clearExecutedEvidence',
            kind: 'object',
            key: 'obj-executed',
        }));

        await page.locator('#clear-executed').click();
        messages = await posted(page);
        expect(messages).toContainEqual(expect.objectContaining({ type: 'clearAllExecutedEvidence' }));
    });

    test('shows sources, explanation and sends confirm/undo actions for the selected relation', async ({ page }) => {
        await open(page);
        await page.locator('.jk-row', { hasText: 'USERS → ORDERS' }).click();
        await expect(page.locator('#detail')).toContainText('USERS.USER_ID = ORDERS.OWNER_ID');
        await expect(page.locator('#detail')).toContainText('Confirmed');
        await expect(page.locator('#detail')).toContainText('explicit per-relation confirmation');

        await page.getByRole('button', { name: 'Re-confirm' }).click();
        let messages = await posted(page);
        expect(messages).toContainEqual(expect.objectContaining({
            type: 'relationAction',
            action: 'confirm',
            key: 'rel-confirmed',
        }));

        await page.evaluate(() => {
            window.postMessage({
                type: 'actionResult',
                ok: true,
                message: 'Relation confirmed.',
                undo: { kind: 'relation', id: 'rel-confirm-2', label: 'Undo confirmed' },
            }, '*');
        });
        const undo = page.getByRole('button', { name: 'Undo confirmed' });
        await expect(undo).toBeVisible();
        await undo.click();
        messages = await posted(page);
        expect(messages).toContainEqual(expect.objectContaining({
            type: 'revert',
            kind: 'relation',
            id: 'rel-confirm-2',
        }));
    });

    test('lets the user favorite a JOIN suggestion directly from its list row', async ({ page }) => {
        await open(page);
        await page.getByRole('button', { name: 'Add favorite for ACCOUNTS → ORDERS' }).click();
        const messages = await posted(page);
        expect(messages).toContainEqual(expect.objectContaining({
            type: 'relationAction',
            action: 'favorite',
            key: 'rel-workspace',
        }));
    });

    test('raises and lowers a relation score from the list', async ({ page }) => {
        await open(page);
        const row = page.locator('.jk-row-wrap', { hasText: 'ACCOUNTS → ORDERS' });
        await row.getByRole('button', { name: 'Raise ranking for ACCOUNTS → ORDERS' }).click();
        await row.getByRole('button', { name: 'Lower ranking for ACCOUNTS → ORDERS' }).click();
        const messages = await posted(page);
        expect(messages).toContainEqual(expect.objectContaining({
            type: 'relationScoreAction',
            action: 'increase',
            key: 'rel-workspace',
        }));
        expect(messages).toContainEqual(expect.objectContaining({
            type: 'relationScoreAction',
            action: 'decrease',
            key: 'rel-workspace',
        }));
    });

    test('resets an active relation score from the detail view', async ({ page }) => {
        const scored = {
            ...STATE,
            relations: (STATE.relations as Array<Record<string, unknown>>).map((row) =>
                row.key === 'rel-workspace'
                    ? { ...row, scoreAdjustment: 3, overrideIds: { score: 'score-workspace' } }
                    : row,
            ),
        };
        await open(page, { state: scored });
        await page.locator('.jk-row', { hasText: 'ACCOUNTS → ORDERS' }).click();
        await expect(page.locator('#detail')).toContainText('Ranking adjustment: +3');
        await page.getByRole('button', { name: 'Reset', exact: true }).click();
        expect(await posted(page)).toContainEqual(expect.objectContaining({
            type: 'relationScoreAction',
            action: 'reset',
            key: 'rel-workspace',
        }));
    });

    test('offers a separate action to clear accepted completion evidence', async ({ page }) => {
        await open(page);
        await page.locator('.jk-row', { hasText: 'ACCOUNTS → ORDERS' }).click();
        await expect(page.locator('#detail')).toContainText('2 accepted selection(s)');
        await page.getByRole('button', { name: 'Clear accepted selections' }).click();
        expect(await posted(page)).toContainEqual(expect.objectContaining({
            type: 'deleteAcceptedEvidence',
            key: 'rel-workspace',
        }));
    });

    test('restores the tab, query, filter and selection from persisted webview state', async ({ page }) => {
        await open(page, {
            persisted: {
                tab: 'objects',
                query: 'prod',
                filter: 'workspace',
                selectedKey: 'obj-boost',
            },
        });
        await expect(page.locator('#tab-objects')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#search')).toHaveValue('prod');
        await expect(page.locator('#filter')).toHaveValue('workspace');
        await expect(page.locator('.jk-row')).toHaveCount(1);
        await expect(page.locator('#detail')).toContainText('ADMIN.PRODUCTS');
        await expect(page.locator('#detail')).toContainText('Boosted to band 07');
    });

    test('sends bulk exclude for selected objects', async ({ page }) => {
        await open(page, { persisted: { tab: 'objects', query: '', filter: 'all' } });
        await expect(page.locator('#tab-objects')).toHaveAttribute('aria-selected', 'true');
        const row = page.locator('.jk-row-wrap', { hasText: 'ADMIN.PRODUCTS' });
        await row.locator('input[type="checkbox"]').check();
        await page.getByRole('button', { name: 'Exclude selected' }).click();
        const messages = await posted(page);
        expect(messages).toContainEqual(expect.objectContaining({
            type: 'bulk',
            action: 'exclude',
            keys: ['obj-boost'],
        }));
    });

    test('submits a manual relation form without inventing identity', async ({ page }) => {
        await open(page);
        await page.getByRole('button', { name: '+ Add manual relation' }).click();
        await page.locator('#manual-left-database').fill('PROD_DB');
        await page.locator('#manual-left-schema').fill('ADMIN');
        await page.locator('#manual-left').fill('USERS');
        await page.locator('#manual-right-database').fill('PROD_DB');
        await page.locator('#manual-right-schema').fill('REPORTING');
        await page.locator('#manual-right').fill('ORDERS');
        await page.locator('#manual-columns').fill('USER_ID=OWNER_ID');
        await page.getByRole('button', { name: 'Add manual relation', exact: true }).click();
        const messages = await posted(page);
        expect(messages).toContainEqual(expect.objectContaining({
            type: 'saveManualRelation',
            relation: {
                leftDatabase: 'PROD_DB',
                leftSchema: 'ADMIN',
                rightDatabase: 'PROD_DB',
                rightSchema: 'REPORTING',
                leftTable: 'USERS',
                rightTable: 'ORDERS',
                columns: 'USER_ID=OWNER_ID',
            },
        }));
        expect((messages.at(-1) as { originalKey?: string }).originalKey).toBeUndefined();
    });

    test('disables evidence actions and explains a disabled index', async ({ page }) => {
        const disabled = {
            ...STATE,
            meta: {
                ...(STATE.meta as Record<string, unknown>),
                indexingEnabled: false,
                personalizeEnabled: false,
                counts: {
                    relations: 6,
                    confirmed: 1,
                    blocked: 1,
                    favorites: 1,
                    objects: 4,
                    pinned: 1,
                    excluded: 0,
                },
            },
        };
        await open(page, { state: disabled, persisted: { tab: 'relations', query: '', filter: 'all' } });
        await expect(page.locator('#banner')).toBeVisible();
        await expect(page.locator('#banner')).toContainText('Workspace SQL indexing is off');
        await expect(page.locator('#banner')).toContainText('personalization is off');
        await page.locator('.jk-row', { hasText: 'ACCOUNTS → ORDERS' }).click();
        await expect(page.getByRole('button', { name: 'Delete indexed SQL evidence' })).toHaveCount(0);

        await page.locator('#tab-objects').click();
        await page.locator('.jk-row', { hasText: 'ADMIN.PRODUCTS' }).click();
        await expect(page.getByRole('button', { name: 'Pin object' })).toBeDisabled();
    });
});
