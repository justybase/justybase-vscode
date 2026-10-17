/** Export canonical SQL fixtures; regular unit tests never need a sibling checkout. */
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const corpus = path.resolve(process.env.JUSTYBASE_SQL_CONFORMANCE_PATH || path.join(root, '..', 'JustyBase.SqlConformance'));
const dialects = ['netezza', 'db2', 'mysql', 'mssql', 'postgresql', 'oracle', 'duckdb', 'sqlite', 'access', 'clickhouse'];
const args = [path.join(corpus, 'scripts', 'snapshot.py'), '--corpus-root', corpus,
    '--output', path.join(root, 'src', '__tests__', 'sqlParser', 'fixtures', 'sqlConformance'),
    ...dialects.flatMap(dialect => ['--dialect', dialect]),
    ...(process.argv.includes('--check') ? ['--check'] : [])];
const result = spawnSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), args,
    { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
