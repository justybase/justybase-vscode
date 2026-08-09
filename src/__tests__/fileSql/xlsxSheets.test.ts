import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'node:zlib';
import { listXlsxSheetNames } from '../../../extensions/duckdb/src/xlsxSheets';

function buildZipEntry(name: string, content: string): Buffer {
    const data = zlib.deflateRawSync(Buffer.from(content, 'utf8'));
    const nameBuf = Buffer.from(name, 'utf8');
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    return Buffer.concat([localHeader, nameBuf, data]);
}

function buildXlsx(sheets: string[]): Buffer {
    const files: Buffer[] = [];
    files.push(buildZipEntry('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'));
    const rels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>';
    files.push(buildZipEntry('_rels/.rels', rels));
    const workbookXml = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets>${sheets.map(sheet => `<sheet name="${sheet}"/>`).join('')}</sheets></workbook>`;
    files.push(buildZipEntry('xl/workbook.xml', workbookXml));
    files.push(buildZipEntry('xl/_rels/workbook.xml.rels', rels));
    sheets.forEach((_, index) => {
        files.push(buildZipEntry(`xl/worksheets/sheet${index + 1}.xml`, '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>'));
    });
    return Buffer.concat(files);
}

describe('xlsxSheets', () => {
    let tempDir: string;

    beforeAll(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsx-sheets-'));
    });

    afterAll(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('reads sheet names in document order', () => {
        const filePath = path.join(tempDir, 'multi.xlsx');
        fs.writeFileSync(filePath, buildXlsx(['Sales', 'Inventory', 'Raw Data']));
        expect(listXlsxSheetNames(filePath)).toEqual(['Sales', 'Inventory', 'Raw Data']);
    });

    it('decodes XML entities in sheet names', () => {
        const filePath = path.join(tempDir, 'escaped-names.xlsx');
        fs.writeFileSync(filePath, buildXlsx(['Sales &amp; Tax', 'Q&#x22;4 &#39;24']));
        expect(listXlsxSheetNames(filePath)).toEqual(['Sales & Tax', 'Q"4 \'24']);
    });

    it('returns an empty list for a single-sheet archive without workbook.xml', () => {
        const filePath = path.join(tempDir, 'minimal.xlsx');
        // Only the worksheet entry — no workbook.xml (like some generators).
        fs.writeFileSync(filePath, buildZipEntry('xl/worksheets/sheet1.xml', '<worksheet/>'));
        expect(listXlsxSheetNames(filePath)).toEqual([]);
    });

    it('returns an empty list for non-archive files', () => {
        const filePath = path.join(tempDir, 'not.xlsx');
        fs.writeFileSync(filePath, 'plain text');
        expect(listXlsxSheetNames(filePath)).toEqual([]);
    });

    it('returns an empty list for missing files', () => {
        expect(listXlsxSheetNames(path.join(tempDir, 'missing.xlsx'))).toEqual([]);
    });
});
