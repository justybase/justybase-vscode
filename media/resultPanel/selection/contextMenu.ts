import type { TanStackTable } from '../types.js';
import { openRangeChartModal, RANGE_CHART_MENU } from '../rangeChart.js';
import { createMenuIcon, type MenuIconName } from '../../shared/menuIcons.js';

const ICON_CLASS = 'grid-context-menu-icon';
const LABEL_CLASS = 'grid-context-menu-label';

function styleMenuItem(item: HTMLElement): void {
    item.style.padding = '4px 10px';
    item.style.cursor = 'pointer';
    item.style.color = 'var(--vscode-menu-foreground)';
    item.style.fontSize = '12px';
    item.style.userSelect = 'none';
}

/** Icon slot plus label; a missing icon still reserves the column so rows align. */
function fillMenuRow(item: HTMLElement, text: string, icon: MenuIconName | undefined): void {
    if (icon) {
        item.appendChild(createMenuIcon(icon, ICON_CLASS));
    } else {
        const placeholder = document.createElement('span');
        placeholder.className = `${ICON_CLASS} ${ICON_CLASS}-empty`;
        placeholder.setAttribute('aria-hidden', 'true');
        item.appendChild(placeholder);
    }
    const label = document.createElement('span');
    label.className = LABEL_CLASS;
    label.textContent = text;
    item.appendChild(label);
}

export function removeOpenSubmenus() {
    document.querySelectorAll('.grid-context-submenu').forEach((submenu) => {
        submenu.remove();
    });
}

export function positionSubmenu(submenu: HTMLElement, anchorRect: DOMRect): void {
    submenu.style.top = anchorRect.top + 'px';
    submenu.style.left = (anchorRect.right + 2) + 'px';
    submenu.style.maxHeight = '';
    submenu.style.overflowY = '';

    let submenuRect = submenu.getBoundingClientRect();
    if (submenuRect.right > window.innerWidth) {
        submenu.style.left = Math.max(8, anchorRect.left - submenuRect.width - 2) + 'px';
    }

    submenuRect = submenu.getBoundingClientRect();
    if (submenuRect.left < 8) {
        submenu.style.left = '8px';
    }

    if (submenuRect.bottom > window.innerHeight) {
        submenu.style.top = Math.max(8, window.innerHeight - submenuRect.height - 8) + 'px';
    }

    submenuRect = submenu.getBoundingClientRect();
    if (submenuRect.top < 8) {
        submenu.style.top = '8px';
        submenu.style.maxHeight = (window.innerHeight - 16) + 'px';
        submenu.style.overflowY = 'auto';
    }
}

export function createChartRangeSubmenuItem(
    tableRef: TanStackTable,
    selectedCellsRef: Set<string>,
    parentMenu: HTMLElement,
): HTMLElement {
    const item = document.createElement('div');
    item.className = 'grid-context-menu-item has-submenu';
    fillMenuRow(item, 'Chart Range', 'bar-chart');
    styleMenuItem(item);

    let categorySubmenu: HTMLElement | null = null;
    let activeVariantSubmenu: HTMLElement | null = null;

    function closeChartRangeSubmenus() {
        if (activeVariantSubmenu) {
            activeVariantSubmenu.remove();
            activeVariantSubmenu = null;
        }
        if (categorySubmenu) {
            categorySubmenu.remove();
            categorySubmenu = null;
        }
    }

    function openVariantSubmenu(
        categoryItem: HTMLElement,
        variants: Array<{ label: string; spec: Parameters<typeof openRangeChartModal>[2] }>,
    ): void {
        if (activeVariantSubmenu) {
            activeVariantSubmenu.remove();
            activeVariantSubmenu = null;
        }

        activeVariantSubmenu = document.createElement('div');
        const variantSubmenu = activeVariantSubmenu;
        variantSubmenu.className = 'grid-context-submenu grid-context-submenu-variant';

        variants.forEach((variant: { label: string; spec: Parameters<typeof openRangeChartModal>[2] }) => {
            const variantItem = document.createElement('div');
            variantItem.className = 'grid-context-menu-item';
            fillMenuRow(variantItem, variant.label, undefined);
            styleMenuItem(variantItem);

            variantItem.addEventListener('mouseover', () => {
                variantItem.style.backgroundColor = 'var(--vscode-menu-selectionBackground)';
            });
            variantItem.addEventListener('mouseout', () => {
                variantItem.style.backgroundColor = 'transparent';
            });
            variantItem.addEventListener('click', (event) => {
                event.stopPropagation();
                parentMenu.remove();
                closeChartRangeSubmenus();
                removeOpenSubmenus();
                openRangeChartModal(tableRef, selectedCellsRef, variant.spec);
            });

            variantSubmenu.appendChild(variantItem);
        });

        document.body.appendChild(variantSubmenu);
        positionSubmenu(variantSubmenu, categoryItem.getBoundingClientRect());
    }

    function ensureCategorySubmenu() {
        if (categorySubmenu && categorySubmenu.isConnected) {
            return categorySubmenu;
        }

        closeChartRangeSubmenus();
        removeOpenSubmenus();

        categorySubmenu = document.createElement('div');
        const categoryMenu = categorySubmenu;
        categoryMenu.className = 'grid-context-submenu grid-context-submenu-category';

        RANGE_CHART_MENU.forEach((category) => {
            const categoryItem = document.createElement('div');
            categoryItem.className = 'grid-context-menu-item has-submenu';
            fillMenuRow(categoryItem, category.label, undefined);
            styleMenuItem(categoryItem);

            categoryItem.addEventListener('mouseover', () => {
                categoryItem.style.backgroundColor = 'var(--vscode-menu-selectionBackground)';
                openVariantSubmenu(categoryItem, category.items);
            });
            categoryItem.addEventListener('mouseout', () => {
                categoryItem.style.backgroundColor = 'transparent';
            });

            categoryMenu.appendChild(categoryItem);
        });

        document.body.appendChild(categoryMenu);
        positionSubmenu(categoryMenu, item.getBoundingClientRect());
        return categoryMenu;
    }

    item.addEventListener('mouseover', () => {
        item.style.backgroundColor = 'var(--vscode-menu-selectionBackground)';
        ensureCategorySubmenu();
    });

    item.addEventListener('mouseout', () => {
        item.style.backgroundColor = 'transparent';
    });

    return item;
}

export function createContextMenuItem(text: string, onClick: () => void, icon?: MenuIconName): HTMLElement {
    const item = document.createElement('div');
    item.className = 'grid-context-menu-item';
    fillMenuRow(item, text, icon);
    styleMenuItem(item);

    item.addEventListener('mouseover', () => {
        item.style.backgroundColor = 'var(--vscode-menu-selectionBackground)';
    });
    item.addEventListener('mouseout', () => {
        item.style.backgroundColor = 'transparent';
    });
    item.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
    });

    return item;
}

export interface ContextSubmenuEntry {
    label: string;
    icon?: MenuIconName;
    onClick: () => void;
}

/** Hover submenu with plain entries; picking one closes the parent menu. */
export function createSubmenuItem(text: string, entries: ContextSubmenuEntry[], parentMenu: HTMLElement, icon?: MenuIconName): HTMLElement {
    const item = document.createElement('div');
    item.className = 'grid-context-menu-item has-submenu';
    fillMenuRow(item, text, icon);
    styleMenuItem(item);

    function openSubmenu(): void {
        removeOpenSubmenus();
        const submenu = document.createElement('div');
        submenu.className = 'grid-context-submenu';
        entries.forEach(entry => {
            submenu.appendChild(createContextMenuItem(entry.label, () => {
                parentMenu.remove();
                removeOpenSubmenus();
                entry.onClick();
            }, entry.icon));
        });
        document.body.appendChild(submenu);
        positionSubmenu(submenu, item.getBoundingClientRect());
    }

    item.addEventListener('mouseover', () => {
        item.style.backgroundColor = 'var(--vscode-menu-selectionBackground)';
        openSubmenu();
    });
    item.addEventListener('mouseout', () => {
        item.style.backgroundColor = 'transparent';
    });
    item.addEventListener('click', (event) => {
        event.stopPropagation();
        openSubmenu();
    });
    return item;
}
