/**
 * Access cross-check: writes an Access file with the TypeScript
 * direct-mutation engine and verifies the result with the Java Jackcess
 * reader (io.github.spannm.jackcess — the original file-format library the
 * C# port and the TypeScript writer are modeled on).
 *
 * Used by the optional `access-java-crosscheck` CI job; run locally with:
 *   node scripts/access-java-crosscheck.cjs
 *
 * Requires a JDK 11+; when neither `java` nor `JAVA_HOME` is available the
 * check is skipped with a non-zero-friendly message (exit 0).
 */

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const VERIFY_DIR = path.join(REPO_ROOT, 'tools', 'access-java-verify');
const FIXTURE = path.join(REPO_ROOT, 'src', '__tests__', 'fixtures', 'access', 'functionsV2003.mdb');

function findJava() {
    if (process.env.JAVA_HOME) {
        const candidate = path.join(process.env.JAVA_HOME, 'bin', 'java');
        if (fs.existsSync(candidate)) return candidate;
    }
    const probe = spawnSync('java', ['-version'], { encoding: 'utf8' });
    return probe.status === 0 ? 'java' : null;
}

function findBash() {
    if (process.platform !== 'win32') return 'bash';
    const candidates = [
        path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return 'bash';
}

function bashPath(value) {
    // Git Bash accepts C:/... paths; raw backslashes are escape sequences there.
    return process.platform === 'win32' ? value.replace(/\\/g, '/') : value;
}

function run(cmd, args, options = {}) {
    const result = spawnSync(cmd, args, { encoding: 'utf8', ...options });
    if (result.status !== 0) {
        throw new Error(`${cmd} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
    }
    return result.stdout;
}

async function main() {
    const java = findJava();
    if (!java) {
        console.log('SKIP access-java-crosscheck: no JDK 11+ found (java / JAVA_HOME).');
        return;
    }
    if (!fs.existsSync(path.join(VERIFY_DIR, 'DumpFile.java'))) {
        throw new Error(`Missing ${path.join(VERIFY_DIR, 'DumpFile.java')}`);
    }
    const bash = findBash();
    run(bash, [bashPath(path.join(VERIFY_DIR, 'bootstrap.sh'))]);

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'access-java-crosscheck-'));
    try {
        const file = path.join(work, 'written.mdb');
        fs.copyFileSync(FIXTURE, file);

        const writer = require(path.join(REPO_ROOT, 'packages', 'access-file', 'dist', 'jet', 'JetWriter.js'));
        const { JetTable } = require(path.join(REPO_ROOT, 'packages', 'access-file', 'dist', 'jet', 'JetTable.js'));
        const { JetPageChannel } = require(path.join(REPO_ROOT, 'packages', 'access-file', 'dist', 'jet', 'JetPageChannel.js'));
        const { jetLayoutFor } = require(path.join(REPO_ROOT, 'packages', 'access-file', 'dist', 'jet', 'JetLayout.js'));

        const open = () => {
            const buffer = fs.readFileSync(file);
            const channel = new JetPageChannel(buffer, jetLayoutFor('jet4'));
            const table = new JetTable(channel, 't_funcs', 50);
            return { table, rows: table.rowLocations().map(l => table.readRowValues(l)) };
        };
        const snapshot = rows => ({
            definition: { name: 't_funcs', columns: [], rowCount: rows.length, isSystem: false },
            rows: rows.map(r => [...r]),
        });

        let { rows } = open();
        const bigText = 'J'.repeat(4500) + ' tail';
        await writer.writeAccessSnapshotChanges(file, 'jet4',
            [snapshot(rows)],
            [snapshot([[rows[0][0], bigText, rows[0][2], rows[0][3]]])]);
        ({ rows } = open());
        await writer.writeAccessSnapshotChanges(file, 'jet4',
            [snapshot(rows)],
            [snapshot([...rows.map(r => [...r]), [777, 'drugi wiersz', -1.5, new Date('2021-03-04T05:06:07Z')]])]);

        const out = run(bash, [bashPath(path.join(VERIFY_DIR, 'run.sh')), bashPath(file)]);
        const lines = out.split('\n');
        const tableLine = lines.find(line => line.startsWith('t_funcs\t'));
        if (!tableLine || !tableLine.startsWith('t_funcs\t2')) {
            throw new Error(`Unexpected Jackcess dump: ${out}`);
        }
        const data = lines.filter(line => line.startsWith('1234\t') || line.startsWith('777\t'));
        if (data.length !== 2 || !data.some(line => line.startsWith('777\t') && line.includes('drugi wiersz'))) {
            throw new Error(`Missing written rows in Jackcess dump:\n${out}`);
        }
        if (!out.includes('J'.repeat(4500) + ' tail')) {
            throw new Error('LVAL chain value missing from Jackcess dump.');
        }
        console.log('OK access-java-crosscheck: Jackcess read back the written rows and LVAL chain.');
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
