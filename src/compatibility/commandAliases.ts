import * as vscode from 'vscode';

export async function registerCompatibilityCommandAliases(): Promise<vscode.Disposable[]> {
    // Legacy command aliasing is no longer needed since commands have not been renamed to use justybase.* namespace.
    // This function is kept for potential future use when commands are migrated.
    return [];
}

