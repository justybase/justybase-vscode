import type * as vscode from 'vscode';
import type { ConnectionManager } from '../../core/connectionManager';
import type { MetadataCache } from '../../metadataCache';
import { MetadataProvider } from '../../providers/providers/metadataProvider';

export interface ImportTargetCatalog {
    availableDatabases: string[];
    availableSchemas: string[];
}

function completionItemLabel(item: { label?: string | { label: string } }): string {
    const label = item.label;
    if (!label) {
        return '';
    }
    return typeof label === 'string' ? label : label.label;
}

export class ImportTargetCatalogService {
    private readonly metadataProvider: MetadataProvider;

    public constructor(
        context: vscode.ExtensionContext,
        connectionManager: ConnectionManager,
        metadataCache: MetadataCache,
    ) {
        this.metadataProvider = new MetadataProvider(context, metadataCache, connectionManager);
    }

    public async loadCatalog(
        connectionName: string | undefined,
        databaseName?: string,
    ): Promise<ImportTargetCatalog> {
        if (!connectionName) {
            return { availableDatabases: [], availableSchemas: [] };
        }

        const databaseItems = await this.metadataProvider.getDatabases(connectionName);
        const availableDatabases = databaseItems
            .map((item) => completionItemLabel(item))
            .filter((label) => label.length > 0);

        const schemaDatabase = databaseName || availableDatabases[0];
        if (!schemaDatabase) {
            return { availableDatabases, availableSchemas: [] };
        }

        const schemaItems = await this.metadataProvider.getSchemas(connectionName, schemaDatabase);
        const availableSchemas = schemaItems
            .map((item) => completionItemLabel(item))
            .filter((label) => label.length > 0);

        return { availableDatabases, availableSchemas };
    }
}
