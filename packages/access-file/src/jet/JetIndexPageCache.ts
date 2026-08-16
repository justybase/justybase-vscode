/**
 * Manager of the index pages for an IndexData (port of IndexPageCache from
 * JustyBase.UCanAccessCs / Jackcess).
 */

import { AccessFileError } from '../accessFileSession';
import type { JetLayout } from './JetLayout';
import { JET_PAGE_TYPES } from './JetLayout';
import {
    FIRST_ENTRY,
    JetIndexEntry,
    JetIndexNodeEntry,
} from './JetIndexEntry';
import type { JetIndexData } from './JetIndexData';
import { INVALID_INDEX_PAGE_NUMBER } from './JetIndexData';
import type { JetIndexDataPage, JetIndexPageCacheLike } from './JetIndexPageCacheTypes';

export class JetIndexDataPageModel {
    public isLeaf = false;
    public prevPageNumber = INVALID_INDEX_PAGE_NUMBER;
    public nextPageNumber = INVALID_INDEX_PAGE_NUMBER;
    public childTailPageNumber = INVALID_INDEX_PAGE_NUMBER;
    public entries: JetIndexEntry[] = [];
    public entryPrefix: Uint8Array = new Uint8Array(0);
    public totalEntrySize = 0;
    public pageNumber: number;

    public constructor(pageNumber: number) {
        this.pageNumber = pageNumber;
    }

    public get isEmpty(): boolean {
        return this.entries.length === 0;
    }

    /** the size of the entries when compressed by the shared entry prefix */
    public get compressedEntrySize(): number {
        return this.totalEntrySize - this.entryPrefix.length * (this.entries.length - 1);
    }
}

/**
 * A view of an index page's entries which combines the normal entries and the
 * tail entry into one collection.
 */
class EntryListView {
    private readonly _extra: JetIndexDataPageModel;
    private _childTailEntry: JetIndexEntry | null;

    public constructor(_main: JetIndexDataPageModel, extra: JetIndexDataPageModel, getChildTailEntry: () => JetIndexEntry | null) {
        this._extra = extra;
        this._childTailEntry = getChildTailEntry();
    }

    public get entries(): JetIndexEntry[] {
        return this._extra.entries;
    }

    public get count(): number {
        return this._extra.entries.length + (this._childTailEntry !== null ? 1 : 0);
    }

    public get isEmpty(): boolean {
        return this.count === 0;
    }

    public getLast(): JetIndexEntry {
        return this._childTailEntry ?? this._extra.entries[this._extra.entries.length - 1] ?? FIRST_ENTRY;
    }

    public add(idx: number, newEntry: JetIndexEntry): void {
        this._extra.entries.splice(idx, 0, newEntry);
    }

    public set(idx: number, newEntry: JetIndexEntry): JetIndexEntry {
        if (idx === this._extra.entries.length) {
            const old = this._childTailEntry!;
            this._childTailEntry = newEntry;
            return old;
        }
        const old = this._extra.entries[idx]!;
        this._extra.entries[idx] = newEntry;
        return old;
    }

    public remove(idx: number): JetIndexEntry {
        if (idx === this._extra.entries.length) {
            const old = this._childTailEntry!;
            this._childTailEntry = null;
            return old;
        }
        return this._extra.entries.splice(idx, 1)[0]!;
    }

    public demoteTail(): JetIndexEntry {
        const tail = this._childTailEntry!;
        this._childTailEntry = null;
        this._extra.entries.push(tail);
        return tail;
    }

    public promoteTail(): JetIndexEntry {
        const last = this._extra.entries[this._extra.entries.length - 1]!;
        this._extra.entries.pop();
        this._childTailEntry = last;
        return last;
    }

    /** binary search over the combined entries + tail view (Java Collections.binarySearch semantics) */
    public find(entry: JetIndexEntry): number {
        let low = 0;
        let high = this.count - 1;
        while (low <= high) {
            const mid = (low + high) >> 1;
            const cmp = this.at(mid).compareTo(entry);
            if (cmp < 0) {
                low = mid + 1;
            } else if (cmp > 0) {
                high = mid - 1;
            } else {
                return mid;
            }
        }
        return -(low + 1);
    }

    private at(idx: number): JetIndexEntry {
        if (idx === this._extra.entries.length) {
            return this._childTailEntry!;
        }
        return this._extra.entries[idx]!;
    }
}

interface MutableCachePage extends JetIndexDataPage {
    readonly model: JetIndexDataPageModel;
    readonly view: EntryListView;
    modified: boolean;
}

export class JetIndexPageCache implements JetIndexPageCacheLike {
    private readonly _indexData: JetIndexData;
    private _rootPage: MutableCachePage | null = null;
    private readonly _dataPages = new Map<number, MutableCachePage>();
    private readonly _modifiedPages: MutableCachePage[] = [];

    public constructor(indexData: JetIndexData) {
        this._indexData = indexData;
    }

    private get layout(): JetLayout {
        return this._indexData.table.layout;
    }

    public setRootPageNumber(pageNumber: number): void {
        const page = this.getDataPage(pageNumber)!;
        this._rootPage = page;
    }

    /** writes any outstanding changes for this index to the file */
    public write(): void {
        this.handleEmptyPages();
        this.preparePagesForWriting();
        this.writeDataPages();
    }

    public findCacheDataPage(entry: JetIndexEntry): JetIndexDataPage {
        let curPage = this._rootPage!;
        while (true) {
            if (curPage.model.isLeaf) {
                return curPage;
            }
            let idx = curPage.view.find(entry);
            if (idx < 0) {
                idx = missingIndexToInsertionPoint(idx);
                if (idx === curPage.view.count) {
                    idx--;
                }
            }
            const nodeEntry = this.viewEntryAt(curPage, idx);
            const childPageNumber = nodeEntry.subPageNumber;
            if (childPageNumber === null || childPageNumber === undefined) {
                throw new AccessFileError('Index node entry has no sub page number.');
            }
            curPage = this.getDataPage(childPageNumber)!;
        }
    }

    public getCacheDataPage(pageNumber: number): JetIndexDataPage | null {
        const page = this.getDataPage(pageNumber);
        return page ?? null;
    }

    private viewEntryAt(page: MutableCachePage, idx: number): JetIndexEntry {
        const normal = page.model.entries;
        if (idx >= normal.length) {
            // tail entry: computed from the tail page's last entry
            const tailPageNumber = page.model.childTailPageNumber;
            if (tailPageNumber === INVALID_INDEX_PAGE_NUMBER) {
                throw new AccessFileError('Missing child tail entry.');
            }
            const tailPage = this.getDataPage(tailPageNumber)!;
            const tailEntry = tailPage.view.getLast();
            return tailEntry.asNodeEntry(tailPageNumber);
        }
        return normal[idx]!;
    }

    private handleEmptyPages(): void {
        for (let index = this._modifiedPages.length - 1; index >= 0; index--) {
            const cacheDataPage = this._modifiedPages[index]!;
            if (cacheDataPage.view.isEmpty) {
                if (cacheDataPage.model.pageNumber !== this._rootPage?.model.pageNumber) {
                    this.deleteDataPage(cacheDataPage);
                } else {
                    this.writeDataPage(cacheDataPage);
                }
                this._modifiedPages.splice(index, 1);
            }
        }
    }

    private preparePagesForWriting(): void {
        const maxPageEntrySize = this._indexData.maxPageEntrySize;
        let splitPages: boolean;
        do {
            splitPages = false;
            for (let index = 0; index < this._modifiedPages.length; index++) {
                const cacheDataPage = this._modifiedPages[index]!;
                const dpMain = cacheDataPage.model;

                if (!dpMain.isLeaf) {
                    const size = cacheDataPage.view.count;
                    if (dpMain.childTailPageNumber !== INVALID_INDEX_PAGE_NUMBER) {
                        if (size === 1) {
                            this.demoteTail(cacheDataPage);
                        }
                    } else if (size > 1) {
                        const lastEntry = cacheDataPage.view.getLast();
                        const lastChildPageNumber = lastEntry.subPageNumber;
                        if (lastChildPageNumber !== null && lastChildPageNumber !== undefined) {
                            const lastChild = this.getDataPage(lastChildPageNumber)!;
                            if (lastChild.model.isLeaf) {
                                this.promoteTail(cacheDataPage, lastChild);
                            }
                        }
                    }
                }

                if (dpMain.totalEntrySize > maxPageEntrySize) {
                    this.updateEntryPrefix(cacheDataPage);
                    if (cacheDataPage.model.compressedEntrySize > maxPageEntrySize) {
                        splitPages = true;
                        this.splitDataPage(cacheDataPage);
                    }
                }
            }
        } while (splitPages);
    }

    private writeDataPages(): void {
        for (const cacheDataPage of this._modifiedPages) {
            if (cacheDataPage.view.isEmpty) {
                throw new AccessFileError('Unexpected empty index page.');
            }
            this.writeDataPage(cacheDataPage);
        }
        this._modifiedPages.length = 0;
    }

    private getDataPage(pageNumber: number): MutableCachePage | null {
        const existing = this._dataPages.get(pageNumber);
        if (existing) {
            return existing;
        }
        if (pageNumber > INVALID_INDEX_PAGE_NUMBER) {
            const page = this.readDataPage(pageNumber);
            this._dataPages.set(pageNumber, page);
            return page;
        }
        return null;
    }

    private readDataPage(pageNumber: number): MutableCachePage {
        const model = new JetIndexDataPageModel(pageNumber);
        this.readDataPageInto(model);
        return this.wrapModel(model);
    }

    private wrapModel(model: JetIndexDataPageModel): MutableCachePage {
        const wrappedPage: MutableCachePage = {
            model,
            modified: false,
            view: new EntryListView(model, model, () => {
                const tailPageNumber = model.childTailPageNumber;
                if (tailPageNumber === INVALID_INDEX_PAGE_NUMBER) {
                    return null;
                }
                const tailPage = this.getDataPage(tailPageNumber);
                if (!tailPage) return null;
                const tailEntry = tailPage.view.getLast();
                return tailEntry.asNodeEntry(tailPageNumber);
            }),
            get pageNumber() {
                return model.pageNumber;
            },
            get entries() {
                return model.entries;
            },
            get isEmpty() {
                return model.entries.length === 0;
            },
            get prevPageNumber() {
                return model.prevPageNumber;
            },
            get nextPageNumber() {
                return model.nextPageNumber;
            },
            addEntry: (idx: number, entry: JetIndexEntry): void => {
                this.updateEntry(wrappedPage, idx, entry, 'add');
            },
            removeEntry: (idx: number): JetIndexEntry => this.updateEntry(wrappedPage, idx, null, 'remove')!,
        };
        return wrappedPage;
    }

    /** reads an index page, populating the given page model */
    private readDataPageInto(dataPage: JetIndexDataPageModel): void {
        const layout = this.layout;
        const buffer = this._indexData.table.channel.pageAt(dataPage.pageNumber);
        this.parseIndexPage(buffer, dataPage);
        dataPage.prevPageNumber = buffer.readUInt32LE(layout.offsetPrevIndexPage);
        dataPage.nextPageNumber = buffer.readUInt32LE(layout.offsetNextIndexPage);
        dataPage.childTailPageNumber = buffer.readUInt32LE(layout.offsetChildTailIndexPage);
    }

    private parseIndexPage(buffer: Buffer, dataPage: JetIndexDataPageModel): void {
        const layout = this.layout;
        const pageType = buffer[0] ?? 0;
        if (pageType === JET_PAGE_TYPES.INDEX_LEAF) {
            dataPage.isLeaf = true;
        } else if (pageType === JET_PAGE_TYPES.INDEX_NODE) {
            dataPage.isLeaf = false;
        } else {
            throw new AccessFileError(`Unexpected index page type ${pageType}`);
        }

        const entryPrefixLength = buffer.readUInt16LE(layout.offsetIndexCompressedByteCount);
        const entryMaskLength = layout.sizeIndexEntryMask;
        const entryMaskPos = layout.offsetIndexEntryMask;
        const entryPos = entryMaskPos + entryMaskLength;

        let lastStart = 0;
        let totalEntrySize = 0;
        let parsedPrefix: Uint8Array | null = null;
        const entries: JetIndexEntry[] = [];
        let prevEntry = FIRST_ENTRY;
        const entryMask = buffer.subarray(entryMaskPos, entryMaskPos + entryMaskLength);
        for (let index = 0; index < entryMaskLength; index++) {
            const entryMaskByte = entryMask[index] ?? 0;
            for (let bit = 0; bit < 8; bit++) {
                if ((entryMaskByte & (1 << bit)) !== 0) {
                    const length = index * 8 + bit - lastStart;
                    let curEntryBuf: Uint8Array;
                    if (parsedPrefix !== null) {
                        curEntryBuf = new Uint8Array(length + parsedPrefix.length);
                        curEntryBuf.set(parsedPrefix, 0);
                        curEntryBuf.set(buffer.subarray(entryPos + lastStart, entryPos + lastStart + length), parsedPrefix.length);
                    } else {
                        curEntryBuf = Uint8Array.from(buffer.subarray(entryPos + lastStart, entryPos + lastStart + length));
                    }
                    totalEntrySize += curEntryBuf.length;

                    const entry = dataPage.isLeaf
                        ? JetIndexEntry.readFromBuffer(curEntryBuf, 0, curEntryBuf.length, 0)
                        : JetIndexNodeEntry.readFromBuffer(curEntryBuf, 0, curEntryBuf.length);
                    if (prevEntry.compareTo(entry) >= 0) {
                        throw new AccessFileError('Unexpected order in index entries');
                    }
                    entries.push(entry);
                    if (entries.length === 1 && entryPrefixLength > 0) {
                        parsedPrefix = Uint8Array.from(buffer.subarray(entryPos + lastStart, entryPos + lastStart + entryPrefixLength));
                    }
                    lastStart += length;
                    prevEntry = entry;
                }
            }
        }

        dataPage.entries = entries;
        dataPage.entryPrefix = parsedPrefix ?? new Uint8Array(0);
        dataPage.totalEntrySize = totalEntrySize;
    }

    private writeDataPage(cacheDataPage: MutableCachePage): void {
        const layout = this.layout;
        const model = cacheDataPage.model;
        const buffer = Buffer.alloc(layout.pageSize);

        buffer[0] = model.isLeaf ? JET_PAGE_TYPES.INDEX_LEAF : JET_PAGE_TYPES.INDEX_NODE;
        buffer[1] = 0x01;
        buffer.writeUInt32LE(this._indexData.table.definitionPage, 4);
        buffer.writeUInt32LE(0, 8);
        buffer.writeUInt32LE(model.prevPageNumber, layout.offsetPrevIndexPage);
        buffer.writeUInt32LE(model.nextPageNumber, layout.offsetNextIndexPage);
        buffer.writeUInt32LE(model.childTailPageNumber, layout.offsetChildTailIndexPage);

        const entryPrefix = model.entryPrefix;
        buffer.writeUInt16LE(entryPrefix.length, layout.offsetIndexCompressedByteCount);
        buffer[layout.offsetIndexCompressedByteCount + 2] = 0;

        const entryMask = new Uint8Array(layout.sizeIndexEntryMask);
        let totalSize = entryPrefix.length;
        for (const entry of model.entries) {
            totalSize += entry.size - entryPrefix.length;
            const idx = Math.floor(totalSize / 8);
            if (idx >= entryMask.length) {
                throw new AccessFileError('index entry mask overflow');
            }
            entryMask[idx] = (entryMask[idx] ?? 0) | (1 << (totalSize % 8));
        }
        Buffer.from(entryMask).copy(buffer, layout.offsetIndexEntryMask, 0, entryMask.length);

        let pos = layout.offsetIndexEntryMask + layout.sizeIndexEntryMask;
        Buffer.from(entryPrefix).copy(buffer, pos, 0, entryPrefix.length);
        pos += entryPrefix.length;

        for (const entry of model.entries) {
            const entryBytes = new Uint8Array(entry.size);
            const endPos = entry.write(entryBytes, 0, entryPrefix);
            Buffer.from(entryBytes.subarray(0, endPos)).copy(buffer, pos, 0, endPos);
            pos += endPos;
        }

        buffer.writeUInt16LE(layout.pageSize - pos, 2);

        buffer.copy(this._indexData.table.channel.pageAt(model.pageNumber), 0, 0, layout.pageSize);
        cacheDataPage.modified = false;
    }

    private deleteDataPage(cacheDataPage: MutableCachePage): void {
        this._indexData.table.channel.deallocatePage(cacheDataPage.model.pageNumber);
        this._dataPages.delete(cacheDataPage.model.pageNumber);
        cacheDataPage.modified = false;
    }

    private updateEntry(cacheDataPage: MutableCachePage, idx: number, newEntry: JetIndexEntry | null, upType: 'add' | 'remove' | 'replace'): JetIndexEntry | null {
        const dpMain = cacheDataPage.model;
        const dpView = cacheDataPage.view;

        // load the parent page before modifying entries (the parent may use ours)
        const parentDataPage = dpMain.pageNumber !== this._rootPage?.model.pageNumber
            ? this.findParentPage(dpMain.pageNumber)
            : null;

        const oldLastEntry = dpView.getLast();
        let oldEntry: JetIndexEntry | null = null;
        let entrySizeDiff = 0;

        switch (upType) {
            case 'add':
                dpView.add(idx, newEntry!);
                entrySizeDiff += newEntry!.size;
                break;
            case 'replace':
                oldEntry = dpView.set(idx, newEntry!);
                entrySizeDiff += newEntry!.size - oldEntry.size;
                break;
            case 'remove':
                oldEntry = dpView.remove(idx);
                entrySizeDiff -= oldEntry.size;
                break;
        }

        const updateLast = oldLastEntry !== dpView.getLast();
        if (!updateLast || dpMain.childTailPageNumber === INVALID_INDEX_PAGE_NUMBER) {
            dpMain.totalEntrySize += entrySizeDiff;
            this.setModified(cacheDataPage);
            dpMain.entryPrefix = new Uint8Array(0);
        }

        if (dpView.isEmpty) {
            this.removeDataPage(parentDataPage, cacheDataPage, oldLastEntry);
            return oldEntry;
        }

        if (!updateLast || dpMain.pageNumber === this._rootPage?.model.pageNumber) {
            return oldEntry;
        }

        this.replaceParentEntry(parentDataPage!, cacheDataPage, oldLastEntry);
        return oldEntry;
    }

    private findParentPage(childPageNumber: number): MutableCachePage | null {
        // search the tree top-down for the page whose entries point at the child
        let curPage = this._rootPage!;
        while (true) {
            if (curPage.model.isLeaf) {
                return null;
            }
            for (let index = 0; index < curPage.view.count; index++) {
                const entry = this.viewEntryAt(curPage, index);
                if (entry.subPageNumber === childPageNumber) {
                    return curPage;
                }
            }
            // descend into the child matching the last entry
            const lastEntry = curPage.view.getLast();
            const childPage = lastEntry.subPageNumber;
            if (childPage === null || childPage === undefined) {
                return null;
            }
            curPage = this.getDataPage(childPage)!;
        }
    }

    private removeDataPage(parentDataPage: MutableCachePage | null, cacheDataPage: MutableCachePage, oldLastEntry: JetIndexEntry): void {
        const dpMain = cacheDataPage.model;
        if (dpMain.childTailPageNumber !== INVALID_INDEX_PAGE_NUMBER) {
            throw new AccessFileError('Still has child tail?');
        }
        if (dpMain.totalEntrySize !== 0) {
            throw new AccessFileError('Empty page but size is not 0?');
        }
        if (dpMain.pageNumber === this._rootPage?.model.pageNumber) {
            dpMain.entryPrefix = new Uint8Array(0);
            dpMain.isLeaf = true;
            return;
        }
        this.updateParentEntry(parentDataPage!, cacheDataPage, oldLastEntry, null, 'remove');
        this.removeFromPeers(cacheDataPage);
    }

    private removeFromPeers(cacheDataPage: MutableCachePage): void {
        const dpMain = cacheDataPage.model;
        const prevPageNumber = dpMain.prevPageNumber;
        const nextPageNumber = dpMain.nextPageNumber;
        const prevMain = prevPageNumber !== INVALID_INDEX_PAGE_NUMBER ? this.getDataPage(prevPageNumber) : null;
        if (prevMain) {
            this.setModified(prevMain);
            prevMain.model.nextPageNumber = nextPageNumber;
        }
        const nextMain = nextPageNumber !== INVALID_INDEX_PAGE_NUMBER ? this.getDataPage(nextPageNumber) : null;
        if (nextMain) {
            this.setModified(nextMain);
            nextMain.model.prevPageNumber = prevPageNumber;
        }
    }

    private addParentEntry(parentDataPage: MutableCachePage, childDataPage: MutableCachePage): void {
        this.updateParentEntry(parentDataPage, childDataPage, null, childDataPage.view.getLast(), 'add');
    }

    private replaceParentEntry(parentDataPage: MutableCachePage, childDataPage: MutableCachePage, oldEntry: JetIndexEntry): void {
        this.updateParentEntry(parentDataPage, childDataPage, oldEntry, childDataPage.view.getLast(), 'replace');
    }

    private updateParentEntry(parentDataPage: MutableCachePage, childDataPage: MutableCachePage, oldEntry: JetIndexEntry | null, newEntry: JetIndexEntry | null, upType: 'add' | 'remove' | 'replace'): void {
        const childMain = childDataPage.model;

        if (childMain.childTailPageNumber !== INVALID_INDEX_PAGE_NUMBER && upType !== 'remove') {
            this.updateParentTail(parentDataPage, childDataPage, upType);
        }

        const oldNode = oldEntry !== null ? oldEntry.asNodeEntry(childMain.pageNumber) : null;
        const newNode = newEntry !== null ? newEntry.asNodeEntry(childMain.pageNumber) : null;

        let expectFound = true;
        let idx = 0;
        switch (upType) {
            case 'add':
                expectFound = false;
                idx = parentDataPage.view.find(newNode!);
                break;
            case 'replace':
            case 'remove':
                idx = parentDataPage.view.find(oldNode!);
                break;
        }

        if (idx < 0) {
            if (expectFound) {
                throw new AccessFileError('Could not find child entry in parent index page.');
            }
            idx = missingIndexToInsertionPoint(idx);
        } else if (!expectFound) {
            throw new AccessFileError('Unexpectedly found child entry in parent index page.');
        }
        this.updateEntry(parentDataPage, idx, newNode, upType);

        if (childMain.childTailPageNumber !== INVALID_INDEX_PAGE_NUMBER && upType === 'remove') {
            this.updateParentTail(parentDataPage, childDataPage, upType);
        }
    }

    private updateParentTail(parentDataPage: MutableCachePage, childDataPage: MutableCachePage, upType: 'add' | 'remove' | 'replace'): void {
        const parentMain = parentDataPage.model;
        const newChildTailPageNumber = upType === 'remove' ? INVALID_INDEX_PAGE_NUMBER : childDataPage.model.pageNumber;
        if (parentMain.childTailPageNumber !== newChildTailPageNumber) {
            this.setModified(parentDataPage);
            parentMain.childTailPageNumber = newChildTailPageNumber;
        }
    }

    private splitDataPage(origDataPage: MutableCachePage): void {
        const origMain = origDataPage.model;
        this.setModified(origDataPage);

        const numEntries = origMain.entries.length;
        if (numEntries < 2) {
            throw new AccessFileError('Cannot split page with less than 2 entries.');
        }

        let splitTarget = origDataPage;
        if (origMain.pageNumber === this._rootPage?.model.pageNumber) {
            const nested = this.nestRootDataPage(origDataPage);
            splitTarget = nested;
        }

        const parentMain = this.findParentPage(splitTarget.model.pageNumber)!;
        const parentDataPage = parentMain;

        // move the first half of the entries to a new page
        const newDataPage = this.allocateNewCacheDataPage(parentMain.model.pageNumber, splitTarget.model.isLeaf);
        const newMain = newDataPage.model;
        const half = Math.ceil(numEntries / 2);
        for (let index = 0; index < half; index++) {
            const headEntry = splitTarget.model.entries[index]!;
            newMain.totalEntrySize += headEntry.size;
            newMain.entries.push(headEntry);
        }
        splitTarget.model.entries.splice(0, half);
        splitTarget.model.entryPrefix = new Uint8Array(0);
        splitTarget.model.totalEntrySize -= newMain.totalEntrySize;

        // insert the new page between the old page and any previous page
        this.addToPeersBefore(newDataPage, splitTarget);

        if (!newMain.isLeaf) {
            this.reparentChildren(newDataPage);
            const lastEntry = newMain.entries[newMain.entries.length - 1]!;
            const childMain = this.getDataPage(lastEntry.subPageNumber!);
            if (childMain && !childMain.model.isLeaf) {
                this.separateFromNextPeer(childMain);
            }
        }

        this.addParentEntry(parentDataPage, newDataPage);
    }

    private nestRootDataPage(rootDataPage: MutableCachePage): MutableCachePage {
        const rootMain = rootDataPage.model;
        const newDataPage = this.allocateNewCacheDataPage(rootMain.pageNumber, rootMain.isLeaf);
        const newMain = newDataPage.model;

        newMain.childTailPageNumber = rootMain.childTailPageNumber;
        newMain.entries = rootMain.entries;
        newMain.entryPrefix = rootMain.entryPrefix;
        newMain.totalEntrySize = rootMain.totalEntrySize;

        if (!newMain.isLeaf) {
            this.reparentChildren(newDataPage);
        }

        rootMain.isLeaf = false;
        rootMain.childTailPageNumber = INVALID_INDEX_PAGE_NUMBER;
        rootMain.entries = [];
        rootMain.entryPrefix = new Uint8Array(0);
        rootMain.totalEntrySize = 0;

        this.addParentEntry(rootDataPage, newDataPage);
        return newDataPage;
    }

    private allocateNewCacheDataPage(_parentPageNumber: number, isLeaf: boolean): MutableCachePage {
        const pageNumber = this._indexData.table.channel.allocateNewPage();
        const model = new JetIndexDataPageModel(pageNumber);
        model.isLeaf = isLeaf;
        model.prevPageNumber = INVALID_INDEX_PAGE_NUMBER;
        model.nextPageNumber = INVALID_INDEX_PAGE_NUMBER;
        model.childTailPageNumber = INVALID_INDEX_PAGE_NUMBER;
        const page = this.wrapModel(model);
        this._dataPages.set(pageNumber, page);
        this._indexData.addOwnedPage(pageNumber);
        this.setModified(page);
        return page;
    }

    private addToPeersBefore(newDataPage: MutableCachePage, origDataPage: MutableCachePage): void {
        const origMain = origDataPage.model;
        const newMain = newDataPage.model;
        const prevMain = origMain.prevPageNumber !== INVALID_INDEX_PAGE_NUMBER ? this.getDataPage(origMain.prevPageNumber) : null;

        newMain.nextPageNumber = origMain.pageNumber;
        newMain.prevPageNumber = origMain.prevPageNumber;
        origMain.prevPageNumber = newMain.pageNumber;

        if (prevMain) {
            this.setModified(prevMain);
            prevMain.model.nextPageNumber = newMain.pageNumber;
        }
    }

    private separateFromNextPeer(cacheDataPage: MutableCachePage): void {
        const dpMain = cacheDataPage.model;
        this.setModified(cacheDataPage);
        const nextMain = dpMain.nextPageNumber !== INVALID_INDEX_PAGE_NUMBER ? this.getDataPage(dpMain.nextPageNumber) : null;
        if (nextMain) {
            this.setModified(nextMain);
            nextMain.model.prevPageNumber = INVALID_INDEX_PAGE_NUMBER;
        }
        dpMain.nextPageNumber = INVALID_INDEX_PAGE_NUMBER;
    }

    private reparentChildren(cacheDataPage: MutableCachePage): void {
        for (const entry of cacheDataPage.model.entries) {
            const childPageNumber = entry.subPageNumber;
            if (childPageNumber === null || childPageNumber === undefined) {
                continue;
            }
            const child = this._dataPages.get(childPageNumber);
            if (child) {
                // parent page numbers are not persisted; nothing to do
            }
        }
    }

    private demoteTail(cacheDataPage: MutableCachePage): void {
        const dpMain = cacheDataPage.model;
        this.setModified(cacheDataPage);
        const tailMain = dpMain.childTailPageNumber !== INVALID_INDEX_PAGE_NUMBER ? this.getDataPage(dpMain.childTailPageNumber) : null;
        if (!tailMain) {
            throw new AccessFileError('Missing child tail page.');
        }
        this.updateParentTail(cacheDataPage, tailMain, 'remove');
        const tailEntry = cacheDataPage.view.demoteTail();
        dpMain.totalEntrySize += tailEntry.size;
        dpMain.entryPrefix = new Uint8Array(0);
    }

    private promoteTail(cacheDataPage: MutableCachePage, lastMain: MutableCachePage): void {
        const dpMain = cacheDataPage.model;
        this.setModified(cacheDataPage);
        this.updateParentTail(cacheDataPage, lastMain, 'add');
        const lastEntry = cacheDataPage.view.promoteTail();
        dpMain.totalEntrySize -= lastEntry.size;
        dpMain.entryPrefix = new Uint8Array(0);
    }

    private updateEntryPrefix(cacheDataPage: MutableCachePage): void {
        if (cacheDataPage.model.entryPrefix.length === 0 && cacheDataPage.model.entries.length > 0) {
            cacheDataPage.model.entryPrefix = findCommonPrefix(
                cacheDataPage.model.entries[0]!,
                cacheDataPage.model.entries[cacheDataPage.model.entries.length - 1]!,
            );
        }
    }

    private setModified(cacheDataPage: MutableCachePage): void {
        if (!cacheDataPage.modified) {
            this._modifiedPages.push(cacheDataPage);
            cacheDataPage.modified = true;
        }
    }
}

function missingIndexToInsertionPoint(idx: number): number {
    return -(idx + 1);
}

function findCommonPrefix(e1: JetIndexEntry, e2: JetIndexEntry): Uint8Array {
    const b1 = e1.getEntryBytes() ?? new Uint8Array(0);
    const b2 = e2.getEntryBytes() ?? new Uint8Array(0);
    const maxLen = Math.min(b1.length, b2.length);
    let len = 0;
    while (len < maxLen && b1[len] === b2[len]) {
        len++;
    }
    return len === 0 ? new Uint8Array(0) : b1.slice(0, len);
}
