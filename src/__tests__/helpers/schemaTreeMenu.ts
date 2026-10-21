/** Menu contribution as declared in a package.json `contributes.menus` list. */
export interface MenuContribution {
    command?: string;
    submenu?: string;
    when?: string;
    group?: string;
}

/**
 * Every entry reachable from the schema-tree context menu: `view/item/context`
 * plus the entries of each submenu it opens (recursively), so a test does not
 * depend on whether a command sits at the top level or inside "Data ▸",
 * "Structure ▸", "Maintenance ▸" or "Analysis ▸".
 */
export function schemaTreeMenuEntries(menus: Record<string, MenuContribution[] | undefined>): MenuContribution[] {
    const result: MenuContribution[] = [];
    const visited = new Set<string>();
    const visit = (menuId: string): void => {
        if (visited.has(menuId)) return;
        visited.add(menuId);
        for (const entry of menus[menuId] ?? []) {
            result.push(entry);
            if (entry.submenu) visit(entry.submenu);
        }
    };
    visit('view/item/context');
    return result;
}
