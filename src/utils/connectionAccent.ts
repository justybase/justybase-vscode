import * as vscode from 'vscode';

export interface ConnectionAccentOption {
    id: string;
    label: string;
    badge: string;
    previewColor: string;
    themeColorId: string;
}

export const CONNECTION_ACCENT_BADGE = '●';
export const CONNECTION_ACCENT_URI_SCHEME = 'netezza-connection-accent';

const CONNECTION_ACCENT_OPTIONS: readonly ConnectionAccentOption[] = Object.freeze([
    {
        id: 'red',
        label: 'Red',
        badge: '🔴',
        previewColor: '#f14c4c',
        themeColorId: 'charts.red'
    },
    {
        id: 'orange',
        label: 'Orange',
        badge: '🟠',
        previewColor: '#d18616',
        themeColorId: 'charts.orange'
    },
    {
        id: 'yellow',
        label: 'Yellow',
        badge: '🟡',
        previewColor: '#cca700',
        themeColorId: 'charts.yellow'
    },
    {
        id: 'green',
        label: 'Green',
        badge: '🟢',
        previewColor: '#388a34',
        themeColorId: 'charts.green'
    },
    {
        id: 'blue',
        label: 'Blue',
        badge: '🔵',
        previewColor: '#3794ff',
        themeColorId: 'charts.blue'
    },
    {
        id: 'purple',
        label: 'Purple',
        badge: '🟣',
        previewColor: '#b180d7',
        themeColorId: 'charts.purple'
    }
]);

const CONNECTION_ACCENT_OPTIONS_BY_ID = new Map(
    CONNECTION_ACCENT_OPTIONS.map(option => [option.id, option])
);

export function getConnectionAccentOptions(): readonly ConnectionAccentOption[] {
    return CONNECTION_ACCENT_OPTIONS;
}

export function normalizeConnectionAccentColor(accentColor?: string): string | undefined {
    if (!accentColor) {
        return undefined;
    }

    const normalizedColor = accentColor.trim().toLowerCase();
    if (!normalizedColor) {
        return undefined;
    }

    return CONNECTION_ACCENT_OPTIONS_BY_ID.has(normalizedColor) ? normalizedColor : undefined;
}

export function getConnectionAccentOption(accentColor?: string): ConnectionAccentOption | undefined {
    const normalizedColor = normalizeConnectionAccentColor(accentColor);
    return normalizedColor ? CONNECTION_ACCENT_OPTIONS_BY_ID.get(normalizedColor) : undefined;
}

export function getConnectionAccentBadge(accentColor?: string): string | undefined {
    return getConnectionAccentOption(accentColor)?.badge;
}

export function getConnectionAccentThemeColor(accentColor?: string): vscode.ThemeColor | undefined {
    const option = getConnectionAccentOption(accentColor);
    return option ? new vscode.ThemeColor(option.themeColorId) : undefined;
}

export function getConnectionAccentResourceUri(connectionName: string): vscode.Uri {
    return vscode.Uri.parse(`${CONNECTION_ACCENT_URI_SCHEME}:/${encodeURIComponent(connectionName)}`);
}

export function getConnectionNameFromAccentResourceUri(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== CONNECTION_ACCENT_URI_SCHEME) {
        return undefined;
    }

    const encodedName = uri.path.replace(/^\/+/, '');
    return encodedName ? decodeURIComponent(encodedName) : undefined;
}
