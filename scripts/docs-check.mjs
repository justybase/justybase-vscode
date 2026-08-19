import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const docsRoot = path.join(root, 'docs');
const guideRoot = path.join(docsRoot, 'guide');
const siteRoot = path.join(root, '_site');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const failures = [];
const advertisedDatabaseKinds = new Set(['netezza', 'db2', 'mssql', 'oracle', 'postgresql', 'mysql', 'access', 'duckdb', 'sqlite']);

function fail(message) { failures.push(message); }
async function exists(file) {
  try { await readFile(file); return true; } catch { return false; }
}
function unique(values) { return [...new Set(values)]; }
function regexValues(source, pattern) { return [...source.matchAll(pattern)].map(match => match[1]).filter(Boolean); }
function extractApiRoutes(source) { return [...source.matchAll(/app\.(?:get|post|put|patch|delete)(?:<[^()]*?>)?\(\s*['"`](\/[^'"`]+)['"`]/g)].map(match => match[1]); }
function extractTypeUnionValues(source, typeName) {
  const declaration = source.match(new RegExp(`${typeName}\\s*=\\s*([^;]+)`))?.[1] ?? '';
  return [...declaration.matchAll(/'([^']+)'/g)].map(match => match[1]);
}

async function filesUnder(directory, suffix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesUnder(file, suffix));
    else if (!suffix || entry.name.endsWith(suffix)) output.push(file);
  }
  return output;
}

async function manifestFiles() {
  const files = [path.join(root, 'package.json')];
  const extensionDirs = await readdir(path.join(root, 'extensions'), { withFileTypes: true });
  for (const entry of extensionDirs) {
    if (entry.isDirectory()) files.push(path.join(root, 'extensions', entry.name, 'package.json'));
  }
  return files;
}

async function catalogs() {
  const manifests = [];
  for (const file of await manifestFiles()) {
    try { manifests.push(JSON.parse(await readFile(file, 'utf8'))); } catch { /* optional directory without a manifest */ }
  }
  const commands = unique(manifests.flatMap(manifest => (manifest.contributes?.commands ?? []).map(command => command.command)).filter(Boolean));
  const settings = unique(manifests.flatMap(manifest => Object.keys(manifest.contributes?.configuration?.properties ?? {})));
  const contracts = await readFile(path.join(root, 'src/contracts/copilotTools/contracts.ts'), 'utf8');
  const registrations = await readFile(path.join(root, 'src/activation/copilotRegistration.ts'), 'utf8');
  const mcp = await readFile(path.join(root, 'src/mcp/mcpToolCatalog.ts'), 'utf8');
  const contractTools = unique(regexValues(contracts, /name:\s*'([^']+)'/g).filter(name => name.startsWith('netezza_')));
  const activeTools = unique(regexValues(registrations, /name:\s*'([^']+)'/g));
  const mcpTools = unique(regexValues(mcp, /name:\s*'([^']+)'/g));
  const api = await readFile(path.join(root, 'apps/api/src/server.ts'), 'utf8');
  const routes = unique(extractApiRoutes(api));
  const database = await readFile(path.join(root, 'packages/contracts/src/database/index.ts'), 'utf8');
  const databaseKinds = unique(regexValues(database, /\|\s*'([^']+)'/g)).filter(kind => kind !== 'string');
  const webApi = await readFile(path.join(root, 'packages/contracts/src/webApi.ts'), 'utf8');
  const formats = unique([...extractTypeUnionValues(webApi, 'QueryExportFormat'), ...extractTypeUnionValues(webApi, 'QueryFileImportFormat'), 'parquet', 'xpt']);
  return { commands, settings, contractTools, activeTools, mcpTools, routes, databaseKinds, formats };
}

function pageFile(url) {
  return path.join(siteRoot, ...url.split('/').filter(Boolean), 'index.html');
}

async function checkCatalogs(catalog) {
  const generated = {
    commands: await readFile(pageFile('guide/reference/commands/'), 'utf8'),
    settings: await readFile(pageFile('guide/reference/settings/'), 'utf8'),
    databases: await readFile(pageFile('guide/reference/database-support/'), 'utf8'),
    api: await readFile(pageFile('guide/reference/web-api/'), 'utf8'),
    formats: await readFile(pageFile('guide/user/import-export/'), 'utf8'),
  };
  for (const command of catalog.commands) if (!generated.commands.includes(command)) fail(`Missing public command in generated reference: ${command}`);
  for (const setting of catalog.settings) if (!generated.settings.includes(setting)) fail(`Missing setting in generated reference: ${setting}`);
  for (const kind of catalog.databaseKinds.filter(value => advertisedDatabaseKinds.has(value))) if (!generated.databases.includes(`>${kind}<`) && !generated.databases.includes(`\`${kind}\``)) fail(`Missing advertised DatabaseKind in generated reference: ${kind}`);
  for (const route of catalog.routes) if (!generated.api.includes(route)) fail(`Missing Web API route in generated reference: ${route}`);
  for (const format of catalog.formats) if (!generated.formats.toLowerCase().includes(format.toLowerCase())) fail(`Missing import/export format in generated reference: ${format}`);
  for (const tool of catalog.activeTools) if (!catalog.contractTools.includes(tool)) fail(`Active Copilot tool has no contract: ${tool}`);
  for (const tool of catalog.contractTools) if (!catalog.activeTools.includes(tool)) fail(`Contract tool is not registered: ${tool}`);
  for (const tool of catalog.mcpTools) if (!generated.api.includes(tool)) fail(`Missing MCP tool in generated reference: ${tool}`);
}

async function checkRequiredPages() {
  const guideFiles = [
    'guide/user/parser-lsp.md', 'guide/user/sql-quality.md', 'guide/user/performance-reliability.md',
    'guide/user/data-grid.md', 'guide/user/import-export.md', 'guide/user/schema-search.md', 'guide/user/ai-assistant.md',
    'guide/developer/performance-benchmarks.md',
  ];
  const pillars = new Map([
    ['Parser, LSP and SQL Editor', 'guide/user/parser-lsp.md'],
    ['SQL quality and diagnostics', 'guide/user/sql-quality.md'],
    ['Performance and reliability', 'guide/user/performance-reliability.md'],
    ['Data Grid and Result Exploration', 'guide/user/data-grid.md'],
    ['Import and export', 'guide/user/import-export.md'],
    ['Schema Search', 'guide/user/schema-search.md'],
    ['AI SQL Assistant', 'guide/user/ai-assistant.md'],
  ]);
  for (const [title, file] of pillars) if (!guideFiles.includes(file)) fail(`No source page registered for pillar: ${title}`);
  for (const file of guideFiles) {
    const absolute = path.join(docsRoot, file);
    if (!await exists(absolute)) fail(`Missing pillar source: ${file}`);
  }
  const landing = path.join(docsRoot, 'index.html');
  return readFile(landing, 'utf8');
}

async function checkFrontMatter() {
  const files = await filesUnder(guideRoot, '.md');
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (!/^---\s*\n/.test(source)) fail(`Guide page has no front matter: ${path.relative(root, file)}`);
    if (!/^last_verified:/m.test(source)) fail(`Guide page has no last_verified: ${path.relative(root, file)}`);
    if (!/^product_version:/m.test(source)) fail(`Guide page has no product_version: ${path.relative(root, file)}`);
  }
}

async function checkBuiltLinks() {
  const htmlFiles = await filesUnder(siteRoot, '.html');
  for (const file of htmlFiles) {
    const html = await readFile(file, 'utf8');
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
    for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const raw = match[1];
      if (raw.startsWith('http:') || raw.startsWith('https:') || raw.startsWith('mailto:') || raw.startsWith('data:')) continue;
      const [target, anchor] = raw.split('#', 2);
      if (anchor && !target && !ids.has(anchor)) fail(`Broken anchor ${raw} in ${path.relative(root, file)}`);
      if (!target) continue;
      const resolved = path.resolve(path.dirname(file), target);
      const candidate = target.endsWith('/') ? path.join(resolved, 'index.html') : resolved;
      try { await readFile(candidate); } catch { fail(`Broken local link ${raw} in ${path.relative(root, file)}`); }
      if (anchor) {
        try {
          const targetHtml = await readFile(candidate, 'utf8');
          if (!new RegExp(`\\bid="${anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(targetHtml)) fail(`Broken cross-page anchor ${raw} in ${path.relative(root, file)}`);
        } catch { /* primary missing-file error already reported */ }
      }
    }
  }
}

async function main() {
  execFileSync(process.execPath, [path.join(root, 'scripts/build-docs.mjs')], { cwd: root, stdio: 'inherit' });
  const catalog = await catalogs();
  await checkCatalogs(catalog);
  await checkFrontMatter();
  const landing = await checkRequiredPages();
  if (!landing.includes('./guide/')) fail('Landing page does not link to the portal at ./guide/.');
  if (/Snowflake|Vertica/i.test(landing)) fail('Landing page contains an unadvertised database card/name.');
  const docsText = (await Promise.all((await filesUnder(docsRoot, '.md')).map(file => readFile(file, 'utf8')))).join('\n');
  for (const stale of ['netezza.queryTimeout', 'netezza.queryRowLimit', '#executeQuery', '#sampleData', '#executeImport', '#exportQueryResults']) {
    if (docsText.includes(stale)) fail(`Stale documentation name remains: ${stale}`);
  }
  await checkBuiltLinks();
  if (failures.length > 0) {
    console.error(`docs:check failed with ${failures.length} issue(s):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`docs:check passed (${catalog.commands.length} commands, ${catalog.settings.length} settings, ${catalog.routes.length} Web API routes, ${catalog.mcpTools.length} MCP tools).`);
}

await main();
