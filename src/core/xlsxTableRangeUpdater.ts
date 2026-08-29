import * as fs from "fs";
import * as path from "path";

interface ZipEntryLike {
    entryName: string;
    getData(): Buffer;
}

interface AdmZipLike {
    getEntry(entryName: string): ZipEntryLike | undefined;
    getEntries(): ZipEntryLike[];
    readAsText(entryName: string): string;
    deleteFile(entryName: string): void;
    updateFile(entry: ZipEntryLike, content: Buffer): void;
    writeZip(filePath: string): void;
}

type AdmZipConstructor = new (filePath: string) => AdmZipLike;

const AdmZip = require("adm-zip") as AdmZipConstructor;

const WORKBOOK_RELATIONSHIP_TYPE =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const TABLE_RELATIONSHIP_TYPE =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/table";
const CALCULATION_CHAIN_RELATIONSHIP_TYPE =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain";
const STRICT_RELATIONSHIP_PREFIX =
    "http://purl.oclc.org/ooxml/officeDocument/relationships/";
const TRANSITIONAL_RELATIONSHIP_PREFIX =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";

export interface SpreadsheetTableInfo {
    path: string;
    name?: string;
    range?: string;
    headers: string[];
}

/**
 * Remove the optional calculation-chain part from an XLSX package.
 *
 * The chain is a cache owned by Excel rather than a source of formula truth.
 * Some workbooks contain stale chain entries after their formula cells or
 * source ranges have been replaced. Excel can rebuild the chain from the
 * formulas, while retaining a stale part makes Excel show a repair warning.
 * Remove the part and both package references together so the resulting OOXML
 * package does not contain a dangling relationship or content-type override.
 */
export function removeXlsxCalcChain(filePath: string): void {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Cannot remove XLSX calculation chain; file does not exist: ${filePath}`);
    }

    const zip = new AdmZip(filePath);
    const calculationChainEntry = zip.getEntry("xl/calcChain.xml");
    let changed = false;

    const workbookRelationshipsPath = "xl/_rels/workbook.xml.rels";
    const workbookRelationshipsEntry = zip.getEntry(workbookRelationshipsPath);
    if (workbookRelationshipsEntry) {
        const relationships = zip.readAsText(workbookRelationshipsPath);
        const updatedRelationships = relationships.replace(
            /<Relationship\b[^>]*>/g,
            (tag) => isRelationshipType(
                extractAttribute(tag, "Type"),
                CALCULATION_CHAIN_RELATIONSHIP_TYPE,
            )
                ? ""
                : tag,
        );
        if (updatedRelationships !== relationships) {
            zip.updateFile(
                workbookRelationshipsEntry,
                Buffer.from(updatedRelationships, "utf8"),
            );
            changed = true;
        }
    }

    const contentTypesPath = "[Content_Types].xml";
    const contentTypesEntry = zip.getEntry(contentTypesPath);
    if (contentTypesEntry) {
        const contentTypes = zip.readAsText(contentTypesPath);
        const updatedContentTypes = contentTypes.replace(
            /<Override\b[^>]*\/?>(?:<\/Override>)?/g,
            (tag) => decodeXmlAttribute(extractAttribute(tag, "PartName")) === "/xl/calcChain.xml"
                ? ""
                : tag,
        );
        if (updatedContentTypes !== contentTypes) {
            zip.updateFile(contentTypesEntry, Buffer.from(updatedContentTypes, "utf8"));
            changed = true;
        }
    }

    if (calculationChainEntry) {
        zip.deleteFile("xl/calcChain.xml");
        changed = true;
    }
    if (changed) {
        zip.writeZip(filePath);
    }
}

/**
 * Synchronize ListObject table ranges after XlsxUpdater replaces a worksheet.
 *
 * spreadsheet-tasks correctly updates the worksheet dimension and preserves
 * the table relationship, but older workbook versions can leave the table's
 * own `ref` and `autoFilter ref` at their original row count. Excel then sees
 * the new cells outside the table. This adapter only touches table metadata;
 * all other workbook parts (charts, PivotTables, slicers and cached values)
 * remain byte-for-byte untouched.
 */
export function refreshXlsxTableRangesAfterSheetUpdate(
    filePath: string,
    sheetName: string,
    rangeOverride?: string,
): void {
    refreshSpreadsheetTableRangesAfterSheetUpdate(filePath, sheetName, rangeOverride);
}

/**
 * Return the ListObjects attached to a worksheet in either an XLSX or XLSB
 * package. XLSB stores its worksheet rows in BIFF12, but Excel still stores
 * ListObject definitions as XML table parts.
 */
export function inspectSpreadsheetTables(
    filePath: string,
    sheetName: string,
): SpreadsheetTableInfo[] {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Cannot inspect spreadsheet tables; file does not exist: ${filePath}`);
    }

    const zip = new AdmZip(filePath);
    const worksheetPath = findWorksheetPath(zip, sheetName);
    return worksheetPath ? findWorksheetTables(zip, worksheetPath) : [];
}

/**
 * Synchronize the ListObject range after a worksheet update in either XLSX or
 * XLSB. A worksheet with more than one table is rejected because a worksheet
 * dimension cannot safely describe the range of unrelated tables.
 */
export function refreshSpreadsheetTableRangesAfterSheetUpdate(
    filePath: string,
    sheetName: string,
    rangeOverride?: string,
): void {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Cannot refresh XLSX table ranges; file does not exist: ${filePath}`);
    }

    const zip = new AdmZip(filePath);
    const worksheetPath = findWorksheetPath(zip, sheetName);
    if (!worksheetPath) {
        return;
    }

    const range = rangeOverride ?? findWorksheetRange(zip, worksheetPath);
    if (!range) {
        return;
    }

    const tableRelationships = findTableRelationships(zip, worksheetPath);
    if (tableRelationships.length === 0) {
        return;
    }
    if (tableRelationships.length > 1) {
        throw new Error(
            `Cannot refresh spreadsheet sheet "${sheetName}": it contains ` +
            `${tableRelationships.length} ListObjects; update a sheet with exactly one table.`,
        );
    }

    let changed = false;
    for (const relationship of tableRelationships) {
        const tablePath = resolvePartPath(worksheetPath, relationship.target);
        const tableEntry = zip.getEntry(tablePath);
        if (!tableEntry) {
            continue;
        }

        const tableXml = zip.readAsText(tablePath);
        const updatedTableXml = updateTableRange(tableXml, range);
        if (updatedTableXml !== tableXml) {
            zip.updateFile(tableEntry, Buffer.from(updatedTableXml, "utf8"));
            changed = true;
        }
    }

    if (changed) {
        zip.writeZip(filePath);
    }
}

/**
 * Calculate the range written by spreadsheet-tasks for a header row and data
 * rows. It mirrors the updater's trailing-empty-row trimming and is needed for
 * XLSB, where the worksheet dimension is stored in a binary record.
 */
export function getSpreadsheetDataRange(
    rows: ReadonlyArray<ReadonlyArray<unknown>>,
    headers: ReadonlyArray<string>,
): string {
    let dataRowCount = rows.length;
    while (
        dataRowCount > 0 &&
        rows[dataRowCount - 1]?.every(value => value === null || value === undefined)
    ) {
        dataRowCount--;
    }

    const dataColumnCount = rows.reduce(
        (maximum, row) => Math.max(maximum, row.length),
        0,
    );
    const columnCount = Math.max(headers.length, dataColumnCount);
    const rowCount = dataRowCount + (headers.length > 0 ? 1 : 0);
    if (columnCount === 0 || rowCount === 0) {
        return "A1";
    }

    return `A1:${columnIndexToLetter(columnCount - 1)}${rowCount}`;
}

function findWorksheetPath(zip: AdmZipLike, sheetName: string): string | undefined {
    const workbookPath = findWorkbookPath(zip);
    if (!workbookPath) {
        return undefined;
    }

    if (workbookPath.endsWith(".bin")) {
        return findBinaryWorksheetPath(zip, workbookPath, sheetName);
    }

    const workbookXml = readEntryText(zip, workbookPath);
    const sheet = Array.from(
        workbookXml.matchAll(/<sheet\b[^>]*>/g),
        (match) => match[0],
    ).find((tag) => decodeXmlAttribute(extractAttribute(tag, "name")) === sheetName);
    if (!sheet) {
        return undefined;
    }

    const relationshipId = extractAttribute(sheet, "r:id");
    if (!relationshipId) {
        return undefined;
    }

    const relationshipsPath = relationshipPath(workbookPath);
    if (!zip.getEntry(relationshipsPath)) {
        return undefined;
    }
    const relationships = zip.readAsText(relationshipsPath);
    const relationship = findRelationship(relationships, relationshipId);
    return relationship ? resolvePartPath(workbookPath, relationship.target) : undefined;
}

function findWorkbookPath(zip: AdmZipLike): string | undefined {
    const rootRelationshipsEntry = zip.getEntry("_rels/.rels");
    if (!rootRelationshipsEntry) {
        return undefined;
    }

    const relationships = zip.readAsText("_rels/.rels");
    const workbookRelationship = Array.from(
        relationships.matchAll(/<Relationship\b[^>]*>/g),
        (match) => match[0],
    ).find((tag) => isRelationshipType(
        extractAttribute(tag, "Type"),
        WORKBOOK_RELATIONSHIP_TYPE,
    ));
    const target = workbookRelationship && extractAttribute(workbookRelationship, "Target");
    return target ? resolvePartPath("", target) : undefined;
}

function findBinaryWorksheetPath(
    zip: AdmZipLike,
    workbookPath: string,
    sheetName: string,
): string | undefined {
    const workbookEntry = zip.getEntry(workbookPath);
    const relationshipsPath = relationshipPath(workbookPath);
    if (!workbookEntry || !zip.getEntry(relationshipsPath)) {
        return undefined;
    }

    const targets = new Map(
        findRelationships(zip.readAsText(relationshipsPath))
            .map(relationship => [relationship.id, relationship.target]),
    );
    const workbook = workbookEntry.getData();
    let position = 0;
    while (true) {
        const record = readBinaryRecord(workbook, position);
        if (!record) {
            return undefined;
        }
        position = record.dataEnd;
        if (record.id !== 0x009c) {
            continue;
        }

        const bundle = readBinaryBundleSheet(workbook, record.dataStart, record.dataEnd);
        if (!bundle || bundle.name !== sheetName) {
            continue;
        }
        const target = targets.get(bundle.relationshipId);
        return target ? resolvePartPath(workbookPath, target) : undefined;
    }
}

function findWorksheetTables(
    zip: AdmZipLike,
    worksheetPath: string,
): SpreadsheetTableInfo[] {
    return findTableRelationships(zip, worksheetPath).map((relationship) => {
        const tablePath = resolvePartPath(worksheetPath, relationship.target);
        const tableEntry = zip.getEntry(tablePath);
        if (!tableEntry || !tablePath.endsWith(".xml")) {
            throw new Error(
                `Cannot inspect ListObject metadata at ${tablePath} for worksheet ${worksheetPath}`,
            );
        }
        return parseTableInfo(tablePath, zip.readAsText(tablePath));
    });
}

function findTableRelationships(
    zip: AdmZipLike,
    worksheetPath: string,
): Array<{ id: string; type: string; target: string }> {
    const relationshipsPath = relationshipPath(worksheetPath);
    const relationshipsEntry = zip.getEntry(relationshipsPath);
    if (!relationshipsEntry) {
        return [];
    }

    return findRelationships(zip.readAsText(relationshipsPath))
        .filter(relationship => isRelationshipType(relationship.type, TABLE_RELATIONSHIP_TYPE));
}

function findWorksheetRange(zip: AdmZipLike, worksheetPath: string): string | undefined {
    if (worksheetPath.endsWith(".bin")) {
        return undefined;
    }
    const worksheetXml = readEntryText(zip, worksheetPath);
    return extractAttribute(matchSingleTag(worksheetXml, "dimension"), "ref");
}

function parseTableInfo(tablePath: string, tableXml: string): SpreadsheetTableInfo {
    const tableTag = matchSingleTag(tableXml, "table");
    const columnsMatch = tableXml.match(/<tableColumns\b[^>]*>([\s\S]*?)<\/tableColumns>/);
    const headers = columnsMatch
        ? Array.from(
            columnsMatch[1].matchAll(/<tableColumn\b[^>]*>/g),
            match => decodeXmlAttribute(extractAttribute(match[0], "name")) ?? "",
        )
        : [];

    return {
        path: tablePath,
        name: decodeXmlAttribute(
            extractAttribute(tableTag, "name") ?? extractAttribute(tableTag, "displayName"),
        ),
        range: extractAttribute(tableTag, "ref"),
        headers,
    };
}

function findRelationships(
    relationshipsXml: string,
): Array<{ id: string; type: string; target: string }> {
    return Array.from(
        relationshipsXml.matchAll(/<Relationship\b[^>]*>/g),
        (match) => match[0],
    ).flatMap((tag) => {
        const id = extractAttribute(tag, "Id");
        const type = extractAttribute(tag, "Type");
        const target = extractAttribute(tag, "Target");
        return id && type && target
            ? [{ id, type, target: decodeXmlAttribute(target) ?? target }]
            : [];
    });
}

function readBinaryRecord(
    buffer: Buffer,
    position: number,
): { id: number; dataStart: number; dataEnd: number } | undefined {
    const id = readBinaryVlq(buffer, position);
    if (!id) {
        return undefined;
    }
    const length = readBinaryVlq(buffer, id.nextPosition);
    if (!length || length.nextPosition + length.value > buffer.length) {
        return undefined;
    }
    return {
        id: id.value,
        dataStart: length.nextPosition,
        dataEnd: length.nextPosition + length.value,
    };
}

function readBinaryVlq(
    buffer: Buffer,
    position: number,
): { value: number; nextPosition: number } | undefined {
    let value = 0;
    let shift = 0;
    let cursor = position;
    while (cursor < buffer.length && shift <= 28) {
        const byte = buffer[cursor++];
        value |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) {
            return { value, nextPosition: cursor };
        }
        shift += 7;
    }
    return undefined;
}

function readBinaryBundleSheet(
    buffer: Buffer,
    dataStart: number,
    dataEnd: number,
): { relationshipId: string; name: string } | undefined {
    if (dataStart + 12 > dataEnd) {
        return undefined;
    }

    let position = dataStart + 8;
    const relationshipLength = buffer.readUInt32LE(position);
    position += 4;
    const relationshipEnd = position + relationshipLength * 2;
    if (relationshipEnd + 4 > dataEnd) {
        return undefined;
    }
    const relationshipId = buffer.toString("utf16le", position, relationshipEnd);
    position = relationshipEnd;

    const nameLength = buffer.readUInt32LE(position);
    position += 4;
    const nameEnd = position + nameLength * 2;
    if (nameEnd > dataEnd) {
        return undefined;
    }

    return {
        relationshipId,
        name: buffer.toString("utf16le", position, nameEnd),
    };
}

function relationshipPath(partPath: string): string {
    const directory = path.posix.dirname(partPath);
    const fileName = path.posix.basename(partPath);
    return path.posix.join(directory, "_rels", `${fileName}.rels`);
}

function resolvePartPath(sourcePartPath: string, target: string): string {
    if (target.startsWith("/")) {
        return target.slice(1);
    }
    return path.posix.normalize(path.posix.join(path.posix.dirname(sourcePartPath), target));
}

function findRelationship(
    relationshipsXml: string,
    relationshipId: string,
): { type: string; target: string } | undefined {
    const relationship = findRelationships(relationshipsXml)
        .find(candidate => candidate.id === relationshipId);
    if (!relationship) {
        return undefined;
    }
    return { type: relationship.type, target: relationship.target };
}

function isRelationshipType(
    actualType: string | undefined,
    transitionalType: string,
): boolean {
    if (!actualType) {
        return false;
    }
    const relationshipName = transitionalType.slice(TRANSITIONAL_RELATIONSHIP_PREFIX.length);
    return actualType === transitionalType ||
        actualType === `${STRICT_RELATIONSHIP_PREFIX}${relationshipName}`;
}

function columnIndexToLetter(columnIndex: number): string {
    let value = columnIndex + 1;
    let result = "";
    while (value > 0) {
        const remainder = (value - 1) % 26;
        result = String.fromCharCode(65 + remainder) + result;
        value = Math.floor((value - 1) / 26);
    }
    return result;
}

function updateTableRange(tableXml: string, range: string): string {
    const tableTag = matchSingleTag(tableXml, "table");
    if (!tableTag) {
        return tableXml;
    }

    let updated = replaceAttribute(tableXml, tableTag, "ref", range);
    const autoFilterTag = matchSingleTag(updated, "autoFilter");
    if (autoFilterTag && extractAttribute(autoFilterTag, "ref")) {
        updated = replaceAttribute(updated, autoFilterTag, "ref", range);
    }
    return updated;
}

function matchSingleTag(xml: string, elementName: string): string | undefined {
    return xml.match(new RegExp(`<${elementName}\\b[^>]*>`))?.[0];
}

function extractAttribute(tag: string | undefined, attributeName: string): string | undefined {
    if (!tag) {
        return undefined;
    }
    const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return tag.match(new RegExp(`\\b${escapedName}="([^"]*)"`))?.[1];
}

function replaceAttribute(
    xml: string,
    tag: string,
    attributeName: string,
    value: string,
): string {
    const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const updatedTag = tag.replace(
        new RegExp(`(\\b${escapedName}=")[^"]*(")`),
        `$1${value}$2`,
    );
    return updatedTag === tag ? xml : xml.replace(tag, updatedTag);
}

function readEntryText(zip: AdmZipLike, entryName: string): string {
    const entry = zip.getEntry(entryName);
    if (!entry) {
        throw new Error(`Workbook entry is missing: ${entryName}`);
    }
    return zip.readAsText(entryName);
}

function decodeXmlAttribute(value: string | undefined): string | undefined {
    return value
        ?.replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}
