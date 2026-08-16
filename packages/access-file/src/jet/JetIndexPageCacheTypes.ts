/**
 * Shared types between JetIndexData and JetIndexPageCache (avoids the
 * import cycle between the two modules).
 */

import type { JetIndexEntry } from './JetIndexEntry';

export interface JetIndexDataPage {
    readonly pageNumber: number;
    readonly entries: JetIndexEntry[];
    readonly isEmpty: boolean;
    readonly prevPageNumber: number;
    readonly nextPageNumber: number;
    addEntry(idx: number, entry: JetIndexEntry): void;
    removeEntry(idx: number): JetIndexEntry;
}

export interface JetIndexPageCacheLike {
    setRootPageNumber(pageNumber: number): void;
    findCacheDataPage(entry: JetIndexEntry): JetIndexDataPage;
    getCacheDataPage(pageNumber: number): JetIndexDataPage | null;
    write(): void;
}

export class JetIndexPosition {
    public constructor(
        public readonly dataPage: JetIndexDataPage,
        public readonly index: number,
        public readonly entry: JetIndexEntry,
        public readonly between: boolean,
    ) {
    }

    public get nextIndex(): number {
        return this.between ? this.index : this.index + 1;
    }

    public get prevIndex(): number {
        return this.index - 1;
    }
}
