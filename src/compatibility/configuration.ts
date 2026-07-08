import * as vscode from 'vscode';

export const CURRENT_EXTENSION_NAMESPACE = 'justybase';

export interface ExtensionConfiguration {
    get<T>(key: string, defaultValue?: T): T | undefined;
    update(
        key: string,
        value: unknown,
        configurationTarget?: boolean | vscode.ConfigurationTarget | null,
        overrideInLanguage?: boolean
    ): Thenable<void>;
}

function getNamespacedSection(namespace: string, section?: string): string {
    return section ? `${namespace}.${section}` : namespace;
}

function isMissingConfigurationRegistrationError(error: unknown): boolean {
    return error instanceof Error
        && /is not a registered configuration/i.test(error.message);
}

async function tryUpdateConfiguration(
    configuration: vscode.WorkspaceConfiguration,
    key: string,
    value: unknown,
    configurationTarget?: boolean | vscode.ConfigurationTarget | null,
    overrideInLanguage?: boolean
): Promise<void> {
    if (typeof configuration.update !== 'function') {
        return;
    }

    try {
        await configuration.update(key, value, configurationTarget, overrideInLanguage);
    } catch (error) {
        if (!isMissingConfigurationRegistrationError(error)) {
            throw error;
        }
    }
}

export function getExtensionConfiguration(section?: string): ExtensionConfiguration {
    const configuration = vscode.workspace.getConfiguration(getNamespacedSection(CURRENT_EXTENSION_NAMESPACE, section));

    return {
        get<T>(key: string, defaultValue?: T): T | undefined {
            return configuration.get<T | undefined>(key) ?? defaultValue;
        },
        update(
            key: string,
            value: unknown,
            configurationTarget?: boolean | vscode.ConfigurationTarget | null,
            overrideInLanguage?: boolean
        ): Thenable<void> {
            return tryUpdateConfiguration(
                configuration,
                key,
                value,
                configurationTarget,
                overrideInLanguage
            );
        }
    };
}

export function affectsExtensionConfiguration(
    event: vscode.ConfigurationChangeEvent,
    key?: string
): boolean {
    const suffix = key ? `.${key}` : '';
    return event.affectsConfiguration(`${CURRENT_EXTENSION_NAMESPACE}${suffix}`);
}

