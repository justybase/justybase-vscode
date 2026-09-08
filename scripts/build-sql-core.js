const esbuild = require('esbuild');
const { execFileSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const packageRoot = path.join(root, 'packages/sql-core');
const outputRoot = path.join(packageRoot, 'dist');
fs.mkdirSync(outputRoot, { recursive: true });
fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });

const entries = [
  ['root', 'index'],
  ['validation', 'validation'],
  ['quality', 'quality/index'],
  ['baseParser', 'parser/BaseSqlParser'],
  ['comparisonRules', 'parser/queryClauseComparisonRules'],
  ['parser', 'netezza/parser'],
  ['lexer', 'netezza/lexer'],
  ['identifierPattern', 'netezza/identifierPattern'],
  ['sourceScan', 'sourceScan'],
];

// All public entries must share Chevrotain tokens and parser classes. Bundling
// each subpath separately would create distinct instances of those objects.
esbuild.buildSync({
  stdin: {
    contents: entries.map(([name, source]) => `export * as ${name} from ${JSON.stringify(`./src/${source}`)};`).join('\n'),
    resolveDir: packageRoot,
    sourcefile: 'package-entries.ts',
    loader: 'ts',
  },
  bundle: true,
  platform: 'neutral',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(outputRoot, 'shared.js'),
  external: ['@justybase/contracts'],
  sourcemap: true,
});
const namespaces = require(path.join(outputRoot, 'shared.js'));
for (const [name, source] of entries) {
  const output = path.join(outputRoot, `${source}.js`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const shared = './' + path.relative(path.dirname(output), path.join(outputRoot, 'shared.js')).split(path.sep).join('/');
  const exports = Object.keys(namespaces[name]).filter(key => key !== '__esModule');
  const getters = exports.map(key => `Object.defineProperty(exports, ${JSON.stringify(key)}, { enumerable: true, get: function () { return entry[${JSON.stringify(key)}]; } });`);
  fs.writeFileSync(output, [`const entry = require(${JSON.stringify(shared)}).${name};`, ...getters, ''].join('\n'));
}

execFileSync(
  process.execPath,
  [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(packageRoot, 'tsconfig.build.json')],
  { cwd: root, stdio: 'inherit' },
);

const declarationFiles = [];
const collectDeclarations = directory => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectDeclarations(entryPath);
    else if (entry.name.endsWith('.d.ts')) declarationFiles.push(entryPath);
  }
};
collectDeclarations(outputRoot);
const forbiddenDeclarationImport = /(?:from\s+|import\s*\(\s*)["'](?:\.\.\/\.\.\/\.\.\/src\/|vscode(?:["'/])|vscode-languageserver(?:["'/])|node:[^"']*|@justybase\/(?:netezza-driver|spreadsheet-tasks)(?:["'/]))/u;
for (const declarationPath of declarationFiles) {
  const declaration = fs.readFileSync(declarationPath, 'utf8');
  if (forbiddenDeclarationImport.test(declaration)) {
    throw new Error(`Generated sql-core declaration contains a product/platform import: ${path.relative(root, declarationPath)}`);
  }
}
const publicDeclaration = fs.readFileSync(path.join(outputRoot, 'index.d.ts'), 'utf8');
const exportedDeclarationChecks = [
  ['validation', 'validation/semanticValidator.d.ts', 'NetezzaSqlSemanticValidator'],
  ['quality', 'quality/engine.d.ts', 'QualityEngineCore'],
  ['statements', 'statements.d.ts', 'splitSqlStatements'],
];
for (const [subpath, declarationRelativePath, exportName] of exportedDeclarationChecks) {
  if (!publicDeclaration.includes(`export * from "./${subpath}"`)) {
    throw new Error(`Generated sql-core declaration is missing the public ${subpath} export.`);
  }
  const declarationPath = path.join(outputRoot, declarationRelativePath);
  const declaration = fs.readFileSync(declarationPath, 'utf8');
  if (!declaration.includes(exportName)) {
    throw new Error(`Generated sql-core declaration is missing ${exportName}.`);
  }
}
