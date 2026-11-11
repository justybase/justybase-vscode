/**
 * DOM renderer for the portable context-menu icon geometry in
 * `@justybase/ui-core`; the React data grid renders the same shapes as JSX.
 */
import { MENU_ICON_SHAPES, type MenuIconName } from '@justybase/ui-core/menuIcons';

export type { MenuIconName } from '@justybase/ui-core/menuIcons';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * Builds a decorative icon element for a context-menu row. The returned span is
 * `aria-hidden`; menu rows keep their accessible name from the label text.
 */
export function createMenuIcon(name: MenuIconName, className: string): HTMLSpanElement {
    const slot = document.createElement('span');
    slot.className = className;
    slot.setAttribute('aria-hidden', 'true');

    const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('focusable', 'false');

    for (const shape of MENU_ICON_SHAPES[name]) {
        const node = document.createElementNS(SVG_NAMESPACE, shape.tag);
        for (const [attribute, value] of Object.entries(shape.attrs)) {
            node.setAttribute(attribute, value);
        }
        svg.appendChild(node);
    }

    slot.appendChild(svg);
    return slot;
}
