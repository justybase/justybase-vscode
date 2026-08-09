/**
 * Minimal xlsx sheet-name discovery without external dependencies.
 * An .xlsx file is a ZIP; sheet definitions live in xl/workbook.xml.
 * Falls back to an empty list when the archive or workbook.xml is missing
 * (callers then default to the first sheet via read_xlsx(path)).
 */

import * as fs from 'fs';
import * as zlib from 'node:zlib';

interface ZipEntry {
    name: string;
    method: number;
    compSize: number;
    dataStart: number;
}

function listZipEntries(buffer: Buffer): ZipEntry[] {
    const entries: ZipEntry[] = [];
    let offset = 0;
    while (offset + 30 <= buffer.length) {
        if (buffer.readUInt32LE(offset) !== 0x04034b50) {
            break;
        }
        const method = buffer.readUInt16LE(offset + 8);
        const compSize = buffer.readUInt32LE(offset + 18);
        const nameLength = buffer.readUInt16LE(offset + 26);
        const extraLength = buffer.readUInt16LE(offset + 28);
        const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
        const dataStart = offset + 30 + nameLength + extraLength;
        entries.push({ name, method, compSize, dataStart });
        offset = dataStart + compSize;
    }
    return entries;
}

function readEntryText(buffer: Buffer, entry: ZipEntry): string {
    const data = buffer.subarray(entry.dataStart, entry.dataStart + entry.compSize);
    if (entry.method === 0) {
        return data.toString('utf8');
    }
    if (entry.method === 8) {
        return zlib.inflateRawSync(data).toString('utf8');
    }
    return '';
}

function decodeXmlEntities(value: string): string {
    return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, entity => {
        const body = entity.slice(1, -1);
        switch (body.toLowerCase()) {
            case 'amp': return '&';
            case 'lt': return '<';
            case 'gt': return '>';
            case 'quot': return '"';
            case 'apos': return '\'';
            default: {
                const codePoint = body.toLowerCase().startsWith('#x')
                    ? Number.parseInt(body.slice(2), 16)
                    : Number.parseInt(body.slice(1), 10);
                if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10FFFF) {
                    return entity;
                }
                try {
                    return String.fromCodePoint(codePoint);
                } catch {
                    return entity;
                }
            }
        }
    });
}

/** Sheet names in document order, or [] when they cannot be determined. */
export function listXlsxSheetNames(filePath: string): string[] {
    try {
        const buffer = fs.readFileSync(filePath);
        const entries = listZipEntries(buffer);
        const workbook = entries.find(entry => entry.name === 'xl/workbook.xml');
        if (!workbook) {
            return [];
        }
        const xml = readEntryText(buffer, workbook);
        const names: string[] = [];
        const pattern = /<sheet\b[^>]*\bname="([^"]+)"/g;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(xml)) !== null) {
            const name = decodeXmlEntities(match[1]).trim();
            if (name) {
                names.push(name);
            }
        }
        return names;
    } catch {
        return [];
    }
}
