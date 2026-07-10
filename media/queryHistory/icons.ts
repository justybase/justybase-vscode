/** Inline SVG icons — no codicon font dependency in webviews */

const SVG_ATTRS = 'xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"';

export function iconPlay(): string {
    return `<svg ${SVG_ATTRS}><path d="M4 2.5v11l9-5.5-9-5.5z"/></svg>`;
}

export function iconCopy(): string {
    return `<svg ${SVG_ATTRS}><path d="M4 2h7v1H4V2zm0 2h8v9H3V3h1zm1 1v7h6V4H5z"/></svg>`;
}

export function iconEdit(): string {
    return `<svg ${SVG_ATTRS}><path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5zm1 2.8L12.2 4 6 10.2V11h.8L13.3 4.3z"/></svg>`;
}

export function iconTrash(): string {
    return `<svg ${SVG_ATTRS}><path d="M5 3V2h6v1h4v1H1V3h4zm1 3h1v6H6V6zm3 0h1v6H9V6zM3 6h1v7h8V6h1v8H2V6h1z"/></svg>`;
}

export function iconStar(filled: boolean): string {
    if (filled) {
        return `<svg ${SVG_ATTRS}><path d="M8 1.5l1.8 3.7 4 .6-2.9 2.8.7 4L8 10.8 4.4 12.6l.7-4L2.2 5.8l4-.6L8 1.5z"/></svg>`;
    }
    return `<svg ${SVG_ATTRS} fill="none" stroke="currentColor" stroke-width="1.2"><path d="M8 2.2l1.5 3 3.3.5-2.4 2.3.6 3.3L8 9.8 5 11.3l.6-3.3-2.4-2.3 3.3-.5L8 2.2z"/></svg>`;
}

export function iconRefresh(): string {
    return `<svg ${SVG_ATTRS}><path d="M13.5 8A5.5 5.5 0 1 1 8 2.5V1l-3 3 3 3V5a3 3 0 1 0 3 3h1.5z"/></svg>`;
}

export function iconList(): string {
    return `<svg ${SVG_ATTRS}><path d="M2 3h12v1H2V3zm0 4h12v1H2V7zm0 4h12v1H2v-1z"/></svg>`;
}

export function iconTable(): string {
    return `<svg ${SVG_ATTRS}><path d="M1 3h14v10H1V3zm1 1v2h5V4H2zm6 0v2h6V4H8zM2 7v2h5V7H2zm6 0v2h6V7H8zM2 10v2h5v-2H2zm6 0v2h6v-2H8z"/></svg>`;
}

export function iconExport(): string {
    return `<svg ${SVG_ATTRS}><path d="M8 2v7.6l2.3-2.3.7.7L8 11.5 4 7.4l.7-.7L7 9.6V2h1zM3 12v1h10v-1H3z"/></svg>`;
}

export function iconSave(): string {
    return `<svg ${SVG_ATTRS}><path d="M3 2h8l2 2v9H3V2zm2 1v3h6V3H5zm1 7h4v2H6v-2z"/></svg>`;
}

export function iconHistory(): string {
    return `<svg ${SVG_ATTRS} width="32" height="32" viewBox="0 0 16 16"><path d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zm0 1a5 5 0 1 1 0 10A5 5 0 0 1 8 3z"/><path d="M7.5 5v3.2l2.5 1.5.5-.8L8.5 7.5V5h-1z"/></svg>`;
}

export function iconWarning(): string {
    return `<svg ${SVG_ATTRS} width="32" height="32" viewBox="0 0 16 16"><path d="M8 1.5L1 14h14L8 1.5zm0 2.3l5.2 9.2H2.8L8 3.8zM7 6h2v4H7V6zm0 5h2v1H7v-1z"/></svg>`;
}

export function iconLoading(): string {
    return `<svg ${SVG_ATTRS} width="32" height="32" viewBox="0 0 16 16" class="spin-icon"><path d="M8 2v2.5A3.5 3.5 0 1 1 4.5 8H2a6 6 0 1 0 6-6z"/></svg>`;
}

export function iconSettings(): string {
    return `<svg ${SVG_ATTRS}><path d="M8 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm7 3.5l-1.2.2-.5 1.1.8.8-1.1.5-.2 1.2h-1.5l-.2-1.2-1.1-.5.8-.8-.5-1.1L8 8V6.5l1.2-.2.5-1.1.8.8 1.1-.5.2-1.2h1.5l.2 1.2 1.1.5-.8.8.5 1.1L15 8z"/></svg>`;
}
