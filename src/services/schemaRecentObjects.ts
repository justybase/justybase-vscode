import * as vscode from 'vscode';
import type { SchemaSearchResultItem } from '../contracts/webviews/schemaSearchContracts';

const STORAGE_KEY = 'netezza.schemaRecentObjects';
const MAX_RECENTS = 20;

export interface RecentSchemaObject {
    connectionName: string;
    database: string;
    schema: string;
    name: string;
    objType: string;
    parent?: string;
    timestamp: number;
}

export class SchemaRecentObjectsService {
    constructor(private readonly context: vscode.ExtensionContext) {}

    add(item: Omit<RecentSchemaObject, 'timestamp'>): void {
        const recents = this.getAll();
        const key = this.buildKey(item);
        const filtered = recents.filter((entry) => this.buildKey(entry) !== key);
        filtered.unshift({
            ...item,
            timestamp: Date.now(),
        });
        void this.context.globalState.update(STORAGE_KEY, filtered.slice(0, MAX_RECENTS));
    }

    addFromSearchResult(result: SchemaSearchResultItem, connectionName: string): void {
        if (!result.NAME?.trim()) {
            return;
        }

        this.add({
            connectionName: result.connectionName || connectionName,
            database: result.DATABASE || '',
            schema: result.SCHEMA || '',
            name: result.NAME,
            objType: result.TYPE || 'TABLE',
            parent: result.PARENT || undefined,
        });
    }

    getRecents(connectionName?: string): RecentSchemaObject[] {
        const normalizedConnection = connectionName?.trim().toUpperCase();
        const recents = this.getAll();
        if (!normalizedConnection) {
            return recents;
        }

        return recents.filter(
            (entry) => entry.connectionName.toUpperCase() === normalizedConnection,
        );
    }

    toSearchResultItem(recent: RecentSchemaObject): SchemaSearchResultItem {
        return {
            NAME: recent.name,
            SCHEMA: recent.schema,
            DATABASE: recent.database,
            TYPE: recent.objType,
            PARENT: recent.parent || '',
            DESCRIPTION: 'Recent object',
            MATCH_TYPE: 'RECENT',
            connectionName: recent.connectionName,
        };
    }

    private getAll(): RecentSchemaObject[] {
        return this.context.globalState.get<RecentSchemaObject[]>(STORAGE_KEY, []) ?? [];
    }

    private buildKey(item: Omit<RecentSchemaObject, 'timestamp'>): string {
        return [
            item.connectionName,
            item.database,
            item.schema,
            item.name,
            item.objType,
            item.parent || '',
        ].join('|').toUpperCase();
    }
}
