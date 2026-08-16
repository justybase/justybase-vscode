import * as fs from 'node:fs';
import * as path from 'node:path';
import { JetTable } from '../../packages/access-file/src/jet/JetTable';
import { JetPageChannel } from '../../packages/access-file/src/jet/JetPageChannel';
import { jetLayoutFor } from '../../packages/access-file/src/jet/JetLayout';
import { ByteStream, JetGeneralIndexCodes } from '../../packages/access-file/src/jet/JetTextSortOrder';
import { JetRowId, JetIndexEntry, byteCodeCompare } from '../../packages/access-file/src/jet/JetIndexEntry';

const FIXTURES = path.join(__dirname, 'fixtures', 'access');

/** Parses the raw entries of an index page (leaf), mirroring IndexData.ParseIndexPage. */
function parseLeafEntries(page: Buffer, layout: ReturnType<typeof jetLayoutFor>): { bytes: Buffer; row: number; page: number }[] {
    const entryMaskLength = layout.sizeIndexEntryMask;
    const entryMaskPos = layout.offsetIndexEntryMask;
    const entryPos = entryMaskPos + entryMaskLength;
    const prefixLen = page.readUInt16LE(layout.offsetIndexCompressedByteCount);
    const mask = page.subarray(entryMaskPos, entryMaskPos + entryMaskLength);

    const entries: { bytes: Buffer; row: number; page: number }[] = [];
    let lastStart = 0;
    let parsedPrefix: Buffer | null = null;
    for (let i = 0; i < entryMaskLength; i++) {
        const byte = mask[i] ?? 0;
        for (let j = 0; j < 8; j++) {
            if ((byte & (1 << j)) !== 0) {
                const length = i * 8 + j - lastStart;
                let entryBytes: Buffer;
                if (parsedPrefix) {
                    entryBytes = Buffer.concat([parsedPrefix, page.subarray(entryPos + lastStart, entryPos + lastStart + length)]);
                } else {
                    entryBytes = Buffer.from(page.subarray(entryPos + lastStart, entryPos + lastStart + length));
                }
                if (entries.length === 0 && prefixLen > 0) {
                    parsedPrefix = Buffer.from(page.subarray(entryPos + lastStart, entryPos + lastStart + prefixLen));
                }
                const colEntryLen = entryBytes.length - 4;
                const pageNum = (entryBytes[colEntryLen]! << 16) | (entryBytes[colEntryLen + 1]! << 8) | entryBytes[colEntryLen + 2]!;
                const row = entryBytes[colEntryLen + 3]!;
                entries.push({ bytes: entryBytes.subarray(0, colEntryLen), row, page: pageNum });
                lastStart += length;
            }
        }
    }
    return entries;
}

describe('JetIndex text encoding', () => {
    it('matches the original Jackcess-encoded text entries in the Polish fixture', () => {
        const buffer = fs.readFileSync(path.join(FIXTURES, 'sample_polish.accdb'));
        const layout = jetLayoutFor('accdb2007');
        const channel = new JetPageChannel(buffer, layout);
        const table = new JetTable(channel, 'sample_table_01', 89);
        // the text index (text_col1) lives at root page 91
        const page = channel.pageAt(table.indexDatas[0]!.rootPageNumber);
        const originalEntries = parseLeafEntries(page, layout);

        expect(originalEntries.length).toBeGreaterThan(10);
        const rows = table.rowLocations().map(l => table.readRowValues(l));

        for (let i = 0; i < Math.min(rows.length, originalEntries.length); i++) {
            const row = rows[i]!;
            const entry = originalEntries[i]!;
            // encode the row's text value the way our writer would
            const bout = new ByteStream(32);
            const codes = JetGeneralIndexCodes.GenLegacy;
            codes.writeNonNullIndexTextValue(String(row[1]), bout, true);
            const encoded = Buffer.concat([Buffer.from([0x7f]), bout.getBytes(), Buffer.from([0x01, 0x00])]);
            expect(entry.bytes.equals(encoded.subarray(0, entry.bytes.length))).toBe(true);
        }
    });

    it('encodes Polish characters consistently with the code tables', () => {
        const bout = new ByteStream(64);
        JetGeneralIndexCodes.GenLegacy.writeNonNullIndexTextValue('ĄĆĘŁŃÓŚŹŻąćęłńóśźż', bout, true);
        const bytes = Buffer.from(bout.getBytes());
        // the value encoding itself starts with the first character's code
        // and contains the end-text marker; the start flag is added by the
        // column descriptor
        expect(bytes.length).toBeGreaterThan(0);
        expect(bytes.includes(0x01)).toBe(true);
        // re-encoding the same string must be deterministic
        const bout2 = new ByteStream(64);
        JetGeneralIndexCodes.GenLegacy.writeNonNullIndexTextValue('ĄĆĘŁŃÓŚŹŻąćęłńóśźż', bout2, true);
        expect(bytes.equals(Buffer.from(bout2.getBytes()))).toBe(true);
    });

    it('sorts encoded values in Access-compatible byte order', () => {
        const values = ['Apple', 'apple', 'Ą', 'Zebra', 'banan', 'Żaba'];
        const encoded = values.map(value => {
            const bout = new ByteStream(32);
            JetGeneralIndexCodes.GenLegacy.writeNonNullIndexTextValue(value, bout, true);
            return { value, bytes: Buffer.concat([Buffer.from([0x7f]), bout.getBytes(), Buffer.from([0x01, 0x00])]) };
        });
        encoded.sort((a, b) => byteCodeCompare(a.bytes, b.bytes));
        // ASCII letters sort case-insensitively in the legacy collation
        const order = encoded.map(e => e.value);
        expect(order.indexOf('apple')).toBeLessThan(order.indexOf('Zebra'));
        expect(order.indexOf('Ą')).toBeLessThan(order.indexOf('Żaba'));
    });
});

describe('JetIndexEntry', () => {
    it('serializes and parses leaf entries with row ids', () => {
        const bytes = new Uint8Array([0x7f, 0x69, 0x64]);
        const entry = new JetIndexEntry(bytes, new JetRowId(94, 3));
        expect(entry.size).toBe(7);

        const out = new Uint8Array(entry.size);
        const end = entry.write(out, 0, new Uint8Array(0));
        expect(end).toBe(7);

        const parsed = JetIndexEntry.readFromBuffer(out, 0, 7, 0);
        expect(parsed.rowId.pageNumber).toBe(94);
        expect(parsed.rowId.rowNumber).toBe(3);
        expect(parsed.getEntryBytes()).toEqual(bytes);
    });

    it('compares entries by bytes then row id', () => {
        const a = new JetIndexEntry(new Uint8Array([0x01]), new JetRowId(1, 1));
        const b = new JetIndexEntry(new Uint8Array([0x02]), new JetRowId(1, 1));
        const same = new JetIndexEntry(new Uint8Array([0x01]), new JetRowId(2, 0));
        expect(a.compareTo(b)).toBeLessThan(0);
        expect(a.compareTo(same)).toBeLessThan(0);
    });
});
