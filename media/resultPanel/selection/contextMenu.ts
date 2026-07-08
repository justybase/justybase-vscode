import type { TanStackTable } from '../types.js';
import { openRangeChartModal, RANGE_CHART_MENU } from '../rangeChart.js';

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
    item.textContent = 'Chart Range';
    item.style.padding = '6px 16px';
    item.style.cursor = 'pointer';
    item.style.color = 'var(--vscode-menu-foreground)';
    item.style.fontSize = '13px';
    item.style.userSelect = 'none';

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
            variantItem.textContent = variant.label;
            variantItem.style.padding = '6px 16px';
            variantItem.style.cursor = 'pointer';
            variantItem.style.color = 'var(--vscode-menu-foreground)';
            variantItem.style.fontSize = '13px';

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
            categoryItem.textContent = category.label;
            categoryItem.style.padding = '6px 16px';
            categoryItem.style.cursor = 'pointer';
            categoryItem.style.color = 'var(--vscode-menu-foreground)';
            categoryItem.style.fontSize = '13px';

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

export function createContextMenuItem(text: string, onClick: () => void): HTMLElement {
    const item = document.createElement('div');
    item.className = 'grid-context-menu-item';
    item.textContent = text;
    item.style.padding = '6px 16px';
    item.style.cursor = 'pointer';
    item.style.color = 'var(--vscode-menu-foreground)';
    item.style.fontSize = '13px';
    item.style.userSelect = 'none';

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
