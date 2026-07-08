import type {
    DatabaseConnectionFieldSchema,
    DatabaseConnectionFormSchema,
    DatabaseConnectionOptionValue
} from '../contracts/database';

export interface StandardConnectionFieldOptions {
    defaultPort?: number;
    hostPlaceholder?: string;
    databaseLabel?: string;
    databasePlaceholder?: string;
    databaseDescription?: string;
    databaseDefaultValue?: DatabaseConnectionOptionValue;
    databaseStorage?: 'topLevel' | 'options';
    userLabel?: string;
    userPlaceholder?: string;
    passwordPlaceholder?: string;
}

export function createStandardConnectionFields(
    options: StandardConnectionFieldOptions = {}
): DatabaseConnectionFieldSchema[] {
    return [
        {
            key: 'host',
            label: 'Host',
            type: 'text',
            required: true,
            placeholder: options.hostPlaceholder ?? 'Hostname or IP',
            layout: 'half'
        },
        {
            key: 'port',
            label: 'Port',
            type: 'number',
            required: true,
            defaultValue: options.defaultPort,
            min: 1,
            max: 65535,
            layout: 'half'
        },
        {
            key: 'database',
            label: options.databaseLabel ?? 'Database',
            type: 'text',
            storage: options.databaseStorage,
            required: true,
            defaultValue: options.databaseDefaultValue,
            placeholder: options.databasePlaceholder ?? 'Database name',
            description: options.databaseDescription,
            layout: 'full'
        },
        {
            key: 'user',
            label: options.userLabel ?? 'User',
            type: 'text',
            required: true,
            placeholder: options.userPlaceholder ?? 'Username',
            layout: 'half'
        },
        {
            key: 'password',
            label: 'Password',
            type: 'password',
            placeholder: options.passwordPlaceholder ?? 'Password',
            layout: 'half'
        }
    ];
}

export function createStandardConnectionForm(
    options: StandardConnectionFieldOptions = {}
): DatabaseConnectionFormSchema {
    return {
        fields: createStandardConnectionFields(options)
    };
}
