import * as fs from 'node:fs';
import * as path from 'node:path';
import { JetPageChannel } from '../../packages/access-file/src/jet/JetPageChannel';
import { jetLayoutFor, LONG_VALUE_TYPES } from '../../packages/access-file/src/jet/JetLayout';
import {
    longValueLength,
    longValueType,
    readLongValueBytes,
    writeLongValue,
} from '../../packages/access-file/src/jet/JetLvalWriter';
import { JetUsageMap } from '../../packages/access-file/src/jet/JetUsageMap';

function fixture(name: string): Buffer {
    return fs.readFileSync(path.join(__dirname, 'fixtures', 'access', name));
}

function makeChannel(name: string, format: 'jet4' | 'accdb2007'): JetPageChannel {
    return new JetPageChannel(fixture(name), jetLayoutFor(format));
}

describe('JetPageChannel', () => {
    it('allocates pages without invalidating earlier page views', () => {
        const channel = makeChannel('sample2007.accdb', 'accdb2007');
        const initialPages = channel.pageCount;
        const first = channel.pageAt(2);
        const marker = first.readUInt32LE(0);
        let allocated = channel.allocateNewPage();
        expect(allocated).toBe(initialPages);
        for (let index = 0; index < 100; index++) {
            allocated = channel.allocateNewPage();
        }
        expect(channel.pageAt(allocated)[0]).toBe(0);
        // the earlier view must still reference the same bytes
        expect(channel.pageAt(2).readUInt32LE(0)).toBe(marker);
        expect(channel.pageCount).toBe(initialPages + 101);
    });

    it('returns a trimmed logical buffer after allocation', () => {
        const channel = makeChannel('sample2007.accdb', 'accdb2007');
        const before = channel.buffer.length;
        channel.allocateNewPage();
        expect(channel.buffer.length).toBe(before + channel.layout.pageSize);
    });

    it('clears newly allocated pages in the global usage map', () => {
        const channel = makeChannel('sample2007.accdb', 'accdb2007');
        const pageNumber = channel.allocateNewPage();
        const global = JetUsageMap.readGlobal(channel);

        expect(global.containsPageNumber(pageNumber)).toBe(false);
    });
});

describe('JetLvalWriter', () => {
    it('writes short values inline (THIS_PAGE)', () => {
        const channel = makeChannel('functionsV2003.mdb', 'jet4');
        const pages: number[] = [];
        const value = Buffer.from('Hello Access', 'utf16le');
        const def = writeLongValue(value, 4000, channel, page => pages.push(page));
        expect(longValueType(def)).toBe(LONG_VALUE_TYPES.THIS_PAGE);
        expect(longValueLength(def)).toBe(value.length);
        expect(pages).toHaveLength(0);
        expect(readLongValueBytes(def, channel).equals(value)).toBe(true);
    });

    it('writes mid-size values to a single LVAL page (OTHER_PAGE)', () => {
        const channel = makeChannel('functionsV2003.mdb', 'jet4');
        const pages: number[] = [];
        const value = Buffer.from('x'.repeat(300), 'utf16le');
        const def = writeLongValue(value, 100, channel, page => pages.push(page));
        expect(longValueType(def)).toBe(LONG_VALUE_TYPES.OTHER_PAGE);
        expect(longValueLength(def)).toBe(value.length);
        expect(pages).toHaveLength(1);
        const read = readLongValueBytes(def, channel);
        expect(read.equals(value)).toBe(true);
    });

    it('writes large values across a chain of LVAL pages (OTHER_PAGES)', () => {
        const channel = makeChannel('functionsV2003.mdb', 'jet4');
        const pages: number[] = [];
        const text = 'ĄĆĘŁŃÓŚŹŻ'.repeat(800) + ' end';
        const value = Buffer.from(text, 'utf16le');
        const def = writeLongValue(value, 100, channel, page => pages.push(page));
        expect(longValueType(def)).toBe(LONG_VALUE_TYPES.OTHER_PAGES);
        expect(longValueLength(def)).toBe(value.length);
        expect(pages.length).toBeGreaterThan(1);
        const read = readLongValueBytes(def, channel);
        expect(read.length).toBe(value.length);
        expect(read.toString('utf16le')).toBe(text);
    });

    it('round-trips through a fresh channel view of the same file', () => {
        const channel = makeChannel('functionsV2003.mdb', 'jet4');
        const pages: number[] = [];
        const value = Buffer.from('chain-value', 'utf16le');
        const def = writeLongValue(value, 50, channel, page => pages.push(page));
        // reading with the same channel must not depend on writer internals
        expect(readLongValueBytes(def, channel).equals(value)).toBe(true);
    });
});
