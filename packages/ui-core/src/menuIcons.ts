/**
 * Portable context-menu icon geometry shared by every JustyBase UI surface.
 *
 * The shapes are the familiar 24px Lucide geometries (ISC licensed), inlined so
 * web views, the shared React data grid, and future shells all draw the same
 * icons without loading external assets or depending on an icon font. Rendering
 * is view-owned: the DOM menu draws them as SVG, the React grid renders JSX.
 *
 * Every icon is stroked with `currentColor`, so it follows the menu foreground
 * and the active-row selection color provided by the host theme.
 */

export type MenuIconName =
    | 'arrow-down'
    | 'arrow-up'
    | 'bar-chart'
    | 'braces'
    | 'check-square'
    | 'circle-slash'
    | 'clipboard-copy'
    | 'code'
    | 'copy'
    | 'database'
    | 'download'
    | 'eye'
    | 'eye-off'
    | 'file-json'
    | 'file-spreadsheet'
    | 'file-text'
    | 'filter'
    | 'filter-x'
    | 'git-branch'
    | 'layers'
    | 'link'
    | 'list'
    | 'maximize'
    | 'message-square'
    | 'panel-right'
    | 'pencil'
    | 'pin'
    | 'plus'
    | 'refresh'
    | 'rows'
    | 'search'
    | 'sparkles'
    | 'star'
    | 'table'
    | 'trash'
    | 'undo'
    | 'wrench'
    | 'x'
    | 'x-circle';

type MenuIconTag = 'circle' | 'ellipse' | 'line' | 'path' | 'rect';

export interface MenuIconShape {
    readonly tag: MenuIconTag;
    readonly attrs: Readonly<Record<string, string>>;
}

export const MENU_ICON_SHAPES: Record<MenuIconName, readonly MenuIconShape[]> = {
    'arrow-down': [
        { tag: 'path', attrs: { d: 'M12 5v14' } },
        { tag: 'path', attrs: { d: 'm19 12-7 7-7-7' } },
    ],
    'arrow-up': [
        { tag: 'path', attrs: { d: 'm5 12 7-7 7 7' } },
        { tag: 'path', attrs: { d: 'M12 19V5' } },
    ],
    'bar-chart': [
        { tag: 'path', attrs: { d: 'M3 3v18h18' } },
        { tag: 'path', attrs: { d: 'M18 17V9' } },
        { tag: 'path', attrs: { d: 'M13 17V5' } },
        { tag: 'path', attrs: { d: 'M8 17v-3' } },
    ],
    braces: [
        { tag: 'path', attrs: { d: 'M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1' } },
        { tag: 'path', attrs: { d: 'M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1' } },
    ],
    'check-square': [
        { tag: 'path', attrs: { d: 'm9 11 2 2 4-4' } },
        { tag: 'path', attrs: { d: 'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11' } },
    ],
    'circle-slash': [
        { tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } },
        { tag: 'path', attrs: { d: 'm4.9 4.9 14.2 14.2' } },
    ],
    'clipboard-copy': [
        { tag: 'rect', attrs: { width: '8', height: '4', x: '8', y: '2', rx: '1', ry: '1' } },
        { tag: 'path', attrs: { d: 'M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2' } },
        { tag: 'path', attrs: { d: 'M16 4h2a2 2 0 0 1 2 2v4' } },
        { tag: 'path', attrs: { d: 'M21 14H11' } },
        { tag: 'path', attrs: { d: 'm15 10-4 4 4 4' } },
    ],
    code: [
        { tag: 'path', attrs: { d: 'm16 18 6-6-6-6' } },
        { tag: 'path', attrs: { d: 'm8 6-6 6 6 6' } },
    ],
    copy: [
        { tag: 'rect', attrs: { width: '14', height: '14', x: '8', y: '8', rx: '2', ry: '2' } },
        { tag: 'path', attrs: { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' } },
    ],
    database: [
        { tag: 'ellipse', attrs: { cx: '12', cy: '5', rx: '9', ry: '3' } },
        { tag: 'path', attrs: { d: 'M3 5v14a9 3 0 0 0 18 0V5' } },
        { tag: 'path', attrs: { d: 'M3 12a9 3 0 0 0 18 0' } },
    ],
    download: [
        { tag: 'path', attrs: { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' } },
        { tag: 'path', attrs: { d: 'm7 10 5 5 5-5' } },
        { tag: 'path', attrs: { d: 'M12 15V3' } },
    ],
    eye: [
        { tag: 'path', attrs: { d: 'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0' } },
        { tag: 'circle', attrs: { cx: '12', cy: '12', r: '3' } },
    ],
    'eye-off': [
        { tag: 'path', attrs: { d: 'M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49' } },
        { tag: 'path', attrs: { d: 'M14.084 14.158a3 3 0 0 1-4.242-4.242' } },
        { tag: 'path', attrs: { d: 'M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143' } },
        { tag: 'path', attrs: { d: 'm2 2 20 20' } },
    ],
    'file-json': [
        { tag: 'path', attrs: { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' } },
        { tag: 'path', attrs: { d: 'M14 2v4a2 2 0 0 0 2 2h4' } },
        { tag: 'path', attrs: { d: 'M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1' } },
        { tag: 'path', attrs: { d: 'M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1' } },
    ],
    'file-spreadsheet': [
        { tag: 'path', attrs: { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' } },
        { tag: 'path', attrs: { d: 'M14 2v4a2 2 0 0 0 2 2h4' } },
        { tag: 'path', attrs: { d: 'M8 13h2' } },
        { tag: 'path', attrs: { d: 'M14 13h2' } },
        { tag: 'path', attrs: { d: 'M8 17h2' } },
        { tag: 'path', attrs: { d: 'M14 17h2' } },
    ],
    'file-text': [
        { tag: 'path', attrs: { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' } },
        { tag: 'path', attrs: { d: 'M14 2v4a2 2 0 0 0 2 2h4' } },
        { tag: 'path', attrs: { d: 'M10 9H8' } },
        { tag: 'path', attrs: { d: 'M16 13H8' } },
        { tag: 'path', attrs: { d: 'M16 17H8' } },
    ],
    filter: [
        { tag: 'path', attrs: { d: 'M22 3H2l8 9.46V19l4 2v-8.54L22 3z' } },
    ],
    'filter-x': [
        { tag: 'path', attrs: { d: 'M13.013 3H2l8 9.46V19l4 2v-8.54l.9-1.055' } },
        { tag: 'path', attrs: { d: 'm22 3-5 5' } },
        { tag: 'path', attrs: { d: 'm17 3 5 5' } },
    ],
    'git-branch': [
        { tag: 'line', attrs: { x1: '6', x2: '6', y1: '3', y2: '15' } },
        { tag: 'circle', attrs: { cx: '18', cy: '6', r: '3' } },
        { tag: 'circle', attrs: { cx: '6', cy: '18', r: '3' } },
        { tag: 'path', attrs: { d: 'M18 9a9 9 0 0 1-9 9' } },
    ],
    layers: [
        { tag: 'path', attrs: { d: 'm12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z' } },
        { tag: 'path', attrs: { d: 'm22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65' } },
        { tag: 'path', attrs: { d: 'm22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65' } },
    ],
    link: [
        { tag: 'path', attrs: { d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' } },
        { tag: 'path', attrs: { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' } },
    ],
    list: [
        { tag: 'path', attrs: { d: 'M8 6h13' } },
        { tag: 'path', attrs: { d: 'M8 12h13' } },
        { tag: 'path', attrs: { d: 'M8 18h13' } },
        { tag: 'path', attrs: { d: 'M3 6h.01' } },
        { tag: 'path', attrs: { d: 'M3 12h.01' } },
        { tag: 'path', attrs: { d: 'M3 18h.01' } },
    ],
    maximize: [
        { tag: 'path', attrs: { d: 'M8 3H5a2 2 0 0 0-2 2v3' } },
        { tag: 'path', attrs: { d: 'M21 8V5a2 2 0 0 0-2-2h-3' } },
        { tag: 'path', attrs: { d: 'M3 16v3a2 2 0 0 0 2 2h3' } },
        { tag: 'path', attrs: { d: 'M16 21h3a2 2 0 0 0 2-2v-3' } },
    ],
    'message-square': [
        { tag: 'path', attrs: { d: 'M22 17a2 2 0 0 1-2 2H6l-4 4V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z' } },
    ],
    'panel-right': [
        { tag: 'rect', attrs: { width: '18', height: '18', x: '3', y: '3', rx: '2' } },
        { tag: 'path', attrs: { d: 'M15 3v18' } },
    ],
    pencil: [
        { tag: 'path', attrs: { d: 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z' } },
        { tag: 'path', attrs: { d: 'm15 5 4 4' } },
    ],
    pin: [
        { tag: 'path', attrs: { d: 'M12 17v5' } },
        { tag: 'path', attrs: { d: 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z' } },
    ],
    plus: [
        { tag: 'path', attrs: { d: 'M5 12h14' } },
        { tag: 'path', attrs: { d: 'M12 5v14' } },
    ],
    refresh: [
        { tag: 'path', attrs: { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' } },
        { tag: 'path', attrs: { d: 'M21 3v5h-5' } },
        { tag: 'path', attrs: { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' } },
        { tag: 'path', attrs: { d: 'M8 16H3v5' } },
    ],
    rows: [
        { tag: 'rect', attrs: { width: '18', height: '18', x: '3', y: '3', rx: '2' } },
        { tag: 'path', attrs: { d: 'M21 9H3' } },
        { tag: 'path', attrs: { d: 'M21 15H3' } },
    ],
    search: [
        { tag: 'circle', attrs: { cx: '11', cy: '11', r: '8' } },
        { tag: 'path', attrs: { d: 'm21 21-4.3-4.3' } },
    ],
    sparkles: [
        { tag: 'path', attrs: { d: 'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z' } },
        { tag: 'path', attrs: { d: 'M20 3v4' } },
        { tag: 'path', attrs: { d: 'M22 5h-4' } },
    ],
    star: [
        { tag: 'path', attrs: { d: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14l-5-4.87 6.91-1.01L12 2z' } },
    ],
    table: [
        { tag: 'path', attrs: { d: 'M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18' } },
    ],
    trash: [
        { tag: 'path', attrs: { d: 'M3 6h18' } },
        { tag: 'path', attrs: { d: 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6' } },
        { tag: 'path', attrs: { d: 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2' } },
        { tag: 'line', attrs: { x1: '10', x2: '10', y1: '11', y2: '17' } },
        { tag: 'line', attrs: { x1: '14', x2: '14', y1: '11', y2: '17' } },
    ],
    undo: [
        { tag: 'path', attrs: { d: 'M9 14 4 9l5-5' } },
        { tag: 'path', attrs: { d: 'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11' } },
    ],
    wrench: [
        { tag: 'path', attrs: { d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z' } },
    ],
    x: [
        { tag: 'path', attrs: { d: 'M18 6 6 18' } },
        { tag: 'path', attrs: { d: 'm6 6 12 12' } },
    ],
    'x-circle': [
        { tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } },
        { tag: 'path', attrs: { d: 'm15 9-6 6' } },
        { tag: 'path', attrs: { d: 'm9 9 6 6' } },
    ],
};
