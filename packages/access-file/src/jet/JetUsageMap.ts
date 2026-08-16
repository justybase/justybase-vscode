/**
 * Usage map reader/writer (port of UsageMap from JustyBase.UCanAccessCs).
 *
 * The global usage map (page 1, row 0) tracks free pages: an on bit means
 * the page is free/unused.  Out-of-range pages are "assumed on" (free), so
 * appending pages at the end of the file requires no map update unless the
 * new page falls inside the current map range.
 *
 * Per-table maps (owned pages and free-space pages) are stored as rows on a
 * data page referenced from the table definition page (row number + page
 * number in 4 bytes).  New data pages must be added to the owned-pages map
 * (mdb-reader and Jackcess enumerate table pages through it).
 */

import { AccessFileError } from '../accessFileSession';
import { JET_PAGE_TYPES, OFFSET_MASK } from './JetLayout';
import type { JetLayout } from './JetLayout';
import type { JetPageChannel } from './JetPageChannel';

const MAP_TYPE_INLINE = 0x00;
const MAP_TYPE_REFERENCE = 0x01;

function readUInt3(buffer: Buffer, offset: number): number {
    return buffer[offset]! | (buffer[offset + 1]! << 8) | (buffer[offset + 2]! << 16);
}

function rowStartFor(page: Buffer, layout: JetLayout, rowNum: number): number {
    return page.readUInt16LE(layout.offsetRowStart + layout.sizeRowLocation * rowNum) & OFFSET_MASK;
}

function rowEndFor(page: Buffer, layout: JetLayout, rowNum: number): number {
    return rowNum === 0
        ? layout.pageSize
        : rowStartFor(page, layout, rowNum - 1);
}

interface MapContext {
    readonly channel: JetPageChannel;
    readonly layout: JetLayout;
    /** page that holds the map declaration row */
    readonly tablePageNum: number;
    /** offset of the map declaration row within the table page */
    readonly rowStart: number;
    /** end of the map declaration row */
    readonly rowEnd: number;
    /** true for the global usage map (page 1, row 0) */
    readonly isGlobal: boolean;
}

export class JetUsageMap {
    private readonly _pages = new Set<number>();
    private _startPage = 0;
    private _isReference: boolean;
    private readonly _referenceMapPages: number[] = [];

    private constructor(private readonly _context: MapContext) {
        this._isReference = false;
    }

    /**
     * Reads the map whose declaration row lives at the given offset of the
     * given table-definition page (4 bytes: row number + page number).
     */
    public static read(
        channel: JetPageChannel,
        defPage: Buffer,
        position: number,
    ): JetUsageMap {
        const rowNum = defPage[position] ?? 0;
        const pageNum = readUInt3(defPage, position + 1);
        if (pageNum <= 0) {
            throw new AccessFileError(`Invalid usage map page number ${pageNum}.`);
        }
        const map = new JetUsageMap({
            channel,
            layout: channel.layout,
            tablePageNum: pageNum,
            rowStart: rowStartFor(channel.pageAt(pageNum), channel.layout, rowNum),
            rowEnd: rowEndFor(channel.pageAt(pageNum), channel.layout, rowNum),
            isGlobal: false,
        });
        map.init();
        return map;
    }

    /** Reads the global usage map (always at page 1, row 0). */
    public static readGlobal(channel: JetPageChannel): JetUsageMap {
        const map = new JetUsageMap({
            channel,
            layout: channel.layout,
            tablePageNum: 1,
            rowStart: rowStartFor(channel.pageAt(1), channel.layout, 0),
            rowEnd: rowEndFor(channel.pageAt(1), channel.layout, 0),
            isGlobal: true,
        });
        map.init();
        return map;
    }

    private get tablePage(): Buffer {
        return this._context.channel.pageAt(this._context.tablePageNum);
    }

    private init(): void {
        const buffer = this.tablePage;
        const mapType = buffer[this._context.rowStart] ?? 0;
        if (mapType === MAP_TYPE_INLINE) {
            this._isReference = false;
            this.initInline();
        } else if (mapType === MAP_TYPE_REFERENCE) {
            this._isReference = true;
            this.initReference();
        } else {
            throw new AccessFileError(`Unrecognized usage map type ${mapType}.`);
        }
    }

    private initInline(): void {
        const { layout, rowStart, rowEnd } = this._context;
        const startOffset = rowStart + layout.offsetUsageMapStart;
        const maxInlinePages = (rowEnd - startOffset) * 8;
        const startPage = this.tablePage.readUInt32LE(rowStart + 1);
        this._startPage = startPage;
        this.processMap(this.tablePage, startOffset, rowEnd, 0, startPage + maxInlinePages);
    }

    private initReference(): void {
        const { layout, rowStart, rowEnd } = this._context;
        const maxPagesPerMapPage = (layout.pageSize - layout.offsetUsageMapPageData) * 8;
        const numUsagePages = Math.floor((rowEnd - rowStart - 1) / 4);
        this._startPage = 0;
        for (let index = 0; index < numUsagePages; index++) {
            const mapPageNum = this.tablePage.readUInt32LE(
                rowStart + layout.offsetReferenceMapPageNumbers + index * 4,
            );
            if (mapPageNum > 0) {
                const page = this._context.channel.pageAt(mapPageNum);
                if (page[0] !== JET_PAGE_TYPES.USAGE_MAP) {
                    throw new AccessFileError(
                        `Looking for usage map at page ${mapPageNum}, but page type is ${page[0]}.`,
                    );
                }
                this.processMap(
                    page,
                    layout.offsetUsageMapPageData,
                    layout.pageSize,
                    maxPagesPerMapPage * index,
                    maxPagesPerMapPage * (index + 1),
                );
                this._referenceMapPages.push(mapPageNum);
            }
        }
    }

    private processMap(
        buffer: Buffer,
        start: number,
        end: number,
        bufferStartPage: number,
        rangeEndPage: number,
    ): void {
        let byteCount = 0;
        for (let offset = start; offset < end; offset++) {
            const byte = buffer[offset] ?? 0;
            if (byte !== 0) {
                for (let bit = 0; bit < 8; bit++) {
                    if ((byte & (1 << bit)) !== 0) {
                        const pageNumber = this._startPage + byteCount * 8 + bit + bufferStartPage;
                        if (pageNumber >= rangeEndPage) {
                            throw new AccessFileError(
                                `Found page number ${pageNumber} in usage map outside of expected range.`,
                            );
                        }
                        this._pages.add(pageNumber);
                    }
                }
            }
            byteCount++;
        }
    }

    public containsPageNumber(pageNumber: number): boolean {
        return this._pages.has(pageNumber);
    }

    public addPageNumber(pageNumber: number): void {
        this.addOrRemovePageNumber(pageNumber, true);
    }

    public removePageNumber(pageNumber: number): void {
        this.addOrRemovePageNumber(pageNumber, false);
    }

    public cursor(): Iterable<number> {
        return this._pages.values();
    }

    private addOrRemovePageNumber(pageNumber: number, add: boolean): void {
        if (this._context.isGlobal && !add) {
            // Out-of-range pages are assumed on (free); only handle in-range
            // pages so a removal never shifts the global map window.
            if (pageNumber < this._startPage
                || pageNumber >= this._startPage + this.maxMapRange()) {
                return;
            }
        }

        if (this._isReference) {
            this.updateReferenceMap(pageNumber, add);
            return;
        }

        if (!this._context.isGlobal && !this.inInlineRange(pageNumber)) {
            throw new AccessFileError(`Page number ${pageNumber} is out of the inline usage map range.`);
        }
        const relative = pageNumber - this._startPage;
        if (relative < 0 || relative >= this.maxInlinePages()) {
            // Global map: out-of-range adds are no-ops (bits assumed on).
            if (this._context.isGlobal) {
                return;
            }
            throw new AccessFileError(`Page number ${pageNumber} is out of the inline usage map range.`);
        }
        this.updateMapInPlace(this.tablePage, this.inlineDataStart(), relative, pageNumber, add);
    }

    private updateReferenceMap(pageNumber: number, add: boolean): void {
        const { layout, rowStart } = this._context;
        const maxPagesPerMapPage = (layout.pageSize - layout.offsetUsageMapPageData) * 8;
        const pageIndex = Math.floor(pageNumber / maxPagesPerMapPage);
        while (pageIndex >= this._referenceMapPages.length) {
            // Growing a reference global map allocates the map page before
            // its range exists.  Defer clearing its global bit until after
            // the new reference is registered to avoid recursive allocation.
            const mapPageNum = this._context.channel.allocateNewPage(this._context.isGlobal ? false : true);
            const page = this._context.channel.pageAt(mapPageNum);
            page.fill(0);
            page[0] = JET_PAGE_TYPES.USAGE_MAP;
            page[1] = 0x01;
            const refOffset = rowStart + layout.offsetReferenceMapPageNumbers
                + this._referenceMapPages.length * 4;
            this.tablePage.writeUInt32LE(mapPageNum, refOffset);
            this._referenceMapPages.push(mapPageNum);
            if (this._context.isGlobal) {
                this.removePageNumber(mapPageNum);
            }
        }
        const mapPageNum = this._referenceMapPages[pageIndex];
        if (mapPageNum === undefined) {
            throw new AccessFileError(`Missing usage map reference page for page ${pageNumber}.`);
        }
        const mapPage = this._context.channel.pageAt(mapPageNum);
        const relative = pageNumber - maxPagesPerMapPage * pageIndex;
        this.updateMapInPlace(mapPage, layout.offsetUsageMapPageData, relative, pageNumber, add);
    }

    private updateMapInPlace(
        buffer: Buffer,
        dataStart: number,
        relative: number,
        absolutePageNumber: number,
        add: boolean,
    ): void {
        const offset = dataStart + Math.floor(relative / 8);
        const bitmask = 1 << (relative % 8);
        const current = buffer[offset] ?? 0;
        buffer[offset] = add ? (current | bitmask) : (current & ~bitmask);
        if (add) {
            this._pages.add(absolutePageNumber);
        } else {
            this._pages.delete(absolutePageNumber);
        }
    }

    private inlineDataStart(): number {
        return this._context.rowStart + this._context.layout.offsetUsageMapStart;
    }

    private maxInlinePages(): number {
        return (this._context.rowEnd - this.inlineDataStart()) * 8;
    }

    private maxMapRange(): number {
        return this._isReference
            ? (this._context.layout.pageSize - this._context.layout.offsetUsageMapPageData) * 8
                * this._referenceMapPages.length
            : this.maxInlinePages();
    }

    private inInlineRange(pageNumber: number): boolean {
        return pageNumber >= this._startPage
            && pageNumber < this._startPage + this.maxInlinePages();
    }
}
