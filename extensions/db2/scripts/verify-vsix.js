#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { inflateRawSync } = require('node:zlib');

const extensionRoot = path.resolve(__dirname, '..');
const signature = {
    endOfCentralDirectory: 0x06054b50,
    centralDirectoryEntry: 0x02014b50,
    localFileHeader: 0x04034b50,
};

function fail(message) {
    throw new Error(`Db2 VSIX verification failed: ${message}`);
}

function findEndOfCentralDirectory(buffer) {
    const minimum = Math.max(0, buffer.length - 0xffff - 22);
    for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
        if (buffer.readUInt32LE(offset) === signature.endOfCentralDirectory) {
            return offset;
        }
    }
    fail('ZIP end-of-central-directory record is missing.');
}

function listZipEntries(buffer) {
    const endOffset = findEndOfCentralDirectory(buffer);
    const entryCount = buffer.readUInt16LE(endOffset + 10);
    let offset = buffer.readUInt32LE(endOffset + 16);
    const entries = [];

    for (let index = 0; index < entryCount; index += 1) {
        if (buffer.readUInt32LE(offset) !== signature.centralDirectoryEntry) {
            fail(`Invalid central-directory entry at byte ${offset}.`);
        }
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        entries.push({
            name: buffer.toString('utf8', offset + 46, offset + 46 + nameLength),
            compressionMethod: buffer.readUInt16LE(offset + 10),
            compressedSize: buffer.readUInt32LE(offset + 20),
            uncompressedSize: buffer.readUInt32LE(offset + 24),
            localHeaderOffset: buffer.readUInt32LE(offset + 42),
        });
        offset += 46 + nameLength + extraLength + commentLength;
    }

    return entries;
}

function readZipEntry(buffer, entry) {
    const offset = entry.localHeaderOffset;
    if (buffer.readUInt32LE(offset) !== signature.localFileHeader) {
        fail(`Invalid local-file header for ${entry.name}.`);
    }

    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const dataOffset = offset + 30 + nameLength + extraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);
    let content;

    if (entry.compressionMethod === 0) {
        content = compressed;
    } else if (entry.compressionMethod === 8) {
        content = inflateRawSync(compressed);
    } else {
        fail(`Unsupported compression method ${entry.compressionMethod} for ${entry.name}.`);
    }

    if (content.length !== entry.uncompressedSize) {
        fail(`Unexpected uncompressed size for ${entry.name}.`);
    }
    return content.toString('utf8');
}

function findLatestVsix() {
    const archives = fs.readdirSync(extensionRoot)
        .filter(fileName => fileName.endsWith('.vsix'))
        .map(fileName => ({
            fileName,
            modifiedAt: fs.statSync(path.join(extensionRoot, fileName)).mtimeMs,
        }))
        .sort((left, right) => right.modifiedAt - left.modifiedAt);
    if (archives.length === 0) {
        fail('No VSIX archive was produced.');
    }
    return path.join(extensionRoot, archives[0].fileName);
}

function verifyVsix(vsixPath) {
    const entries = listZipEntries(fs.readFileSync(vsixPath));
    const normalized = entries.map(entry => ({
        ...entry,
        name: entry.name.replaceAll('\\', '/'),
    }));
    const bundleEntry = normalized.find(entry => entry.name === 'extension/dist/extension.js');
    const missingBundle = !bundleEntry;
    if (missingBundle) fail('extension/dist/extension.js is missing.');

    const forbiddenEntries = normalized
        .map(entry => entry.name)
        .filter(entry =>
            /(^|\/)node_modules\/ibm_db(\/|$)/i.test(entry)
            || /(^|\/)node_modules\/@justybase\/db2(\/|$)/i.test(entry)
            || /(^|\/)clidriver(\/|$)/i.test(entry)
            || entry.endsWith('.node'),
    );
    if (forbiddenEntries.length > 0) {
        fail(`Native/duplicate runtime files are present: ${forbiddenEntries.slice(0, 8).join(', ')}`);
    }

    const bundle = readZipEntry(fs.readFileSync(vsixPath), bundleEntry);
    if (!bundle.includes('Db2DatabaseConnection') || !bundle.includes('Db2 connection is not open.')) {
        fail('The bundled extension does not contain the @justybase/db2 connection implementation.');
    }
    if (/require\(["']@justybase\/db2\/compat["']\)/.test(bundle)) {
        fail('The @justybase/db2 runtime is external instead of bundled into extension.js.');
    }

    console.log(`Verified portable Db2 VSIX: ${path.basename(vsixPath)} (${normalized.length} files).`);
}

try {
    verifyVsix(findLatestVsix());
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
