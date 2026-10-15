#!/usr/bin/env node
/** Export canonical PostgreSQL cases. Runtime tests never require this checkout. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const corpus = path.resolve(process.env.JUSTYBASE_SQL_CONFORMANCE_PATH || path.join(root, '..', 'JustyBase.SqlConformance'));
const out = path.join(root, 'src/__tests__/sqlParser/fixtures');
const cases = [];
function walk(folder) {
  for (const file of fs.readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, file.name);
    if (file.isDirectory()) walk(full);
    else if (file.name.endsWith('.jsonl')) {
      for (const line of fs.readFileSync(full, 'utf8').split(/\r?\n/).filter(Boolean)) {
        const value = JSON.parse(line);
        if (value.dialect === 'postgresql' || (value.dialect === 'common' && value.appliesTo.includes('postgresql'))) cases.push(value);
      }
    }
  }
}
walk(path.join(corpus, 'dialects/postgresql'));
walk(path.join(corpus, 'dialects/common'));
cases.sort((a, b) => a.id.localeCompare(b.id));
if (new Set(cases.map(c => c.id)).size !== cases.length) throw Error('Duplicate corpus IDs');
const parsers = cases.filter(c => c.contract === 'parser');
const editors = cases.filter(c => c.contract !== 'parser');
const fixtures = Object.fromEntries([...new Set(editors.map(c => c.metadataFixture).filter(Boolean))].sort().map(id => [id, JSON.parse(fs.readFileSync(path.join(corpus, 'fixtures/metadata', id + '.json'), 'utf8'))]));
const contentHash = crypto.createHash('sha256').update(JSON.stringify({ parsers, editors, fixtures })).digest('hex');
const provenance = {
  corpusRevision: execFileSync('git', ['-C', corpus, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  corpusVersion: JSON.parse(fs.readFileSync(path.join(corpus, 'manifest.json'), 'utf8')).corpusVersion,
  contentHash,
  caseCount: cases.length,
};
for (const [name, value] of Object.entries({ postgresqlConformance: parsers, postgresqlEditorConformance: editors, postgresqlMetadataFixtures: fixtures, postgresqlConformanceProvenance: provenance })) {
  const file = path.join(out, name + '.json');
  const text = JSON.stringify(value, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) throw Error('Stale snapshot: ' + name);
  } else fs.writeFileSync(file, text);
}
console.log('PostgreSQL conformance: ' + cases.length + ' cases, sha256 ' + contentHash);
