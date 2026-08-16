/**
 * Page-addressed view over an in-memory Access database buffer
 * (port of the PageChannel from JustyBase.UCanAccessCs).
 *
 * The whole file is held in one buffer (the staged copy is already in
 * memory before any mutation), so page reads/writes are plain buffer
 * operations.  Allocating a page grows the underlying buffer in place
 * (over-allocated capacity with a logical size) so previously obtained
 * page views stay valid while pages are appended.
 */

import { AccessFileError } from '../accessFileSession';
import { JET_PAGE_TYPES } from './JetLayout';
import type { JetLayout } from './JetLayout';
import { JetUsageMap } from './JetUsageMap';

const MAX_DATABASE_SIZE = 2 * 1024 * 1024 * 1024;

export interface MutablePage {
    readonly pageNumber: number;
    readonly buffer: Buffer;
}

export class JetPageChannel {
    private readonly _pages: Buffer[];
    private _globalUsageMap?: JetUsageMap;

    public constructor(
        initial: Buffer,
        private readonly _layout: JetLayout,
        private readonly _onAllocate?: (pageNumber: number) => void,
    ) {
        if (initial.length % _layout.pageSize !== 0) {
            throw new AccessFileError(`Access file size ${initial.length} is not a page multiple.`);
        }
        // Keep each page in its own allocation.  A contiguous buffer cannot
        // grow without invalidating every Buffer view returned by pageAt().
        // Long-value chains retain views to earlier pages while allocating
        // later pages, so those views must remain stable for the lifetime of
        // the channel.
        this._pages = Array.from(
            { length: initial.length / _layout.pageSize },
            (_, pageNumber) => Buffer.from(initial.subarray(
                pageNumber * _layout.pageSize,
                (pageNumber + 1) * _layout.pageSize,
            )),
        );
    }

    public get layout(): JetLayout {
        return this._layout;
    }

    public get pageCount(): number {
        return this._pages.length;
    }

    /** The logical database buffer assembled from the stable page views. */
    public get buffer(): Buffer {
        return Buffer.concat(this._pages, this._pages.length * this._layout.pageSize);
    }

    public pageNumberToOffset(pageNumber: number): number {
        return pageNumber * this._layout.pageSize;
    }

    public pageAt(pageNumber: number): Buffer {
        const page = this._pages[pageNumber];
        if (!Number.isInteger(pageNumber) || pageNumber < 0 || !page) {
            throw new AccessFileError(`Access page ${pageNumber} is outside the file.`);
        }
        return page;
    }

    public pageType(pageNumber: number): number {
        return this.pageAt(pageNumber)[0] ?? JET_PAGE_TYPES.INVALID;
    }

    /**
     * Allocates a page and returns its number.  Freed pages are reused before
     * extending the file, which is important for replacing chained LVALs.
     * The returned page is zeroed (its type is INVALID until the caller fills
     * it).
     */
    public allocateNewPage(markGlobalUsage = true): number {
        for (const pageNumber of this.globalUsageMap.cursor()) {
            if (pageNumber <= 1 || pageNumber >= this._pages.length) {
                continue;
            }
            const page = this._pages[pageNumber];
            if (!page || page[0] !== JET_PAGE_TYPES.INVALID) {
                continue;
            }
            page.fill(0);
            if (markGlobalUsage) {
                this.globalUsageMap.removePageNumber(pageNumber);
            }
            this._onAllocate?.(pageNumber);
            return pageNumber;
        }

        if ((this._pages.length + 1) * this._layout.pageSize > MAX_DATABASE_SIZE) {
            throw new AccessFileError('Database is at maximum size.');
        }
        const pageNumber = this._pages.length;
        this._pages.push(Buffer.alloc(this._layout.pageSize));
        // In the global map, a set bit means free.  Newly allocated pages
        // must be cleared immediately so a concurrent Access writer cannot
        // reuse them.
        if (markGlobalUsage) {
            this.globalUsageMap.removePageNumber(pageNumber);
        }
        this._onAllocate?.(pageNumber);
        return pageNumber;
    }

    /**
     * Marks a previously allocated page as free by zeroing its header.
     * (The global usage map tracks free pages; the caller updates it.)
     */
    public deallocatePage(pageNumber: number): void {
        if (pageNumber <= 1) {
            throw new AccessFileError(`Cannot deallocate reserved page ${pageNumber}.`);
        }
        const page = this.pageAt(pageNumber);
        page.fill(0);
        this.globalUsageMap.addPageNumber(pageNumber);
    }

    private get globalUsageMap(): JetUsageMap {
        return this._globalUsageMap ??= JetUsageMap.readGlobal(this);
    }

    public newDataPage(tableDefPageNumber: number): MutablePage {
        const pageNumber = this.allocateNewPage();
        const page = this.pageAt(pageNumber);
        page[0] = JET_PAGE_TYPES.DATA;
        page[1] = 0x01;
        page.writeUInt16LE(this._layout.dataPageInitialFreeSpace, this._layout.offsetFreeSpace);
        page.writeUInt32LE(tableDefPageNumber, 4);
        page.writeUInt32LE(0, 8);
        page.writeUInt16LE(0, this._layout.offsetNumRowsOnDataPage);
        return { pageNumber, buffer: page };
    }

    public newLongValuePage(): MutablePage {
        const pageNumber = this.allocateNewPage();
        const page = this.pageAt(pageNumber);
        page[0] = JET_PAGE_TYPES.DATA;
        page[1] = 0x01;
        page.writeUInt16LE(this._layout.dataPageInitialFreeSpace, this._layout.offsetFreeSpace);
        // LVAL marker, so page-scans can tell long-value pages apart from
        // ordinary data pages (mirrors the marker written by Jackcess).
        page[4] = 0x4c;
        page[5] = 0x56;
        page[6] = 0x41;
        page[7] = 0x4c;
        page.writeUInt16LE(0, this._layout.offsetNumRowsOnDataPage);
        return { pageNumber, buffer: page };
    }
}
