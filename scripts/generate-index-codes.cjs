/**
 * Generates JetIndexCodesData.ts from the Jackcess index-code resource
 * tables (Apache-2.0) cloned into tools/access-ddl-compare/.clone.
 *
 * Usage: node scripts/generate-index-codes.cjs
 *
 * The generator emits raw code lines as string arrays; the runtime parser
 * (JetTextSortOrder.ts) interprets them exactly like the C#/Jackcess
 * GeneralLegacyIndexCodes.ParseCodes.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const RESOURCES = path.join(REPO_ROOT, 'tools', 'access-ddl-compare', '.clone', 'src', 'UCanAccess.File', 'Resources');
const OUT = path.join(REPO_ROOT, 'packages', 'access-file', 'src', 'jet', 'JetIndexCodesData.ts');

const FILES = [
    ['CODES_GEN_LEG', 'index_codes_genleg.txt'],
    ['CODES_EXT_GEN_LEG', 'index_codes_ext_genleg.txt'],
    ['CODES_GEN', 'index_codes_gen.txt'],
    ['CODES_EXT_GEN', 'index_codes_ext_gen.txt'],
    ['CODES_GEN_97', 'index_codes_gen_97.txt'],
    ['MAPPINGS_EXT_GEN_97', 'index_mappings_ext_gen_97.txt'],
];

function readLines(file) {
    const text = fs.readFileSync(path.join(RESOURCES, file), 'utf8');
    const lines = text.split(/\r?\n/);
    // trailing empty line from the final newline
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
        lines.pop();
    }
    return lines;
}

function emitStringArray(name, lines) {
    const escaped = lines.map(line => JSON.stringify(line));
    return `export const ${name}: readonly string[] = [\n    ${escaped.join(',\n    ')},\n];\n`;
}

let output = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Index code tables ported from the Jackcess project (Apache-2.0):
 * https://github.com/spannm/jackcess (Resources/index_codes_*.txt),
 * mirrored through JustyBase.UCanAccessCs.
 *
 * Regenerate with: node scripts/generate-index-codes.cjs
 */

`;

for (const [name, file] of FILES) {
    if (!fs.existsSync(path.join(RESOURCES, file))) {
        console.error(`Missing resource ${file} (clone the port into tools/access-ddl-compare/.clone first)`);
        process.exit(1);
    }
    const lines = readLines(file);
    output += emitStringArray(name, lines);
    console.log(`${file}: ${lines.length} lines`);
}

fs.writeFileSync(OUT, output);
console.log(`Wrote ${OUT}`);
