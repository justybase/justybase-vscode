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
const advertisedDatabaseKinds = new Set(['netezza', 'db2', 'mssql', 'oracle', 'postgresql', 'mysql', 'clickhouse', 'access', 'duckdb', 'sqlite']);

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
function decodeHtmlEntities(value) {
  return value.replace(/&(amp|lt|gt|quot|#39|#x27);/gi, (_match, entity) => ({
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    '#39': "'",
    '#x27': "'",
  })[entity.toLowerCase()] ?? _match);
}
function textFromHtml(value) {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}
function extractTables(source) {
  return [...source.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map(match => match[0]);
}
function extractTableRows(table) {
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(match => [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => textFromHtml(cell[1])))
    .filter(row => row.length > 0);
}
function generatedTable(html, name) {
  const marker = `GENERATED_TABLE:${name}`;
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return undefined;
  return extractTables(html.slice(markerIndex))[0];
}
function tableValues(html, name, normalizer = value => value) {
  const table = generatedTable(html, name);
  if (!table) return undefined;
  return extractTableRows(table).map(row => normalizer(row[0])).filter(Boolean);
}
function sorted(values) { return [...values].sort((left, right) => left.localeCompare(right)); }
function assertExactCatalog(label, expected, actual) {
  if (!actual) {
    fail(`Generated ${label} table is missing its provenance marker.`);
    return;
  }
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  for (const value of sorted(expectedSet)) if (!actualSet.has(value)) fail(`Missing ${label} in generated reference: ${value}`);
  for (const value of sorted(actualSet)) if (!expectedSet.has(value)) fail(`Extra ${label} in generated reference: ${value}`);
  if (actual.length !== actualSet.size) fail(`Duplicate ${label} in generated reference.`);
}
function frontMatterValue(source, key) {
  const block = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  const line = block?.[1].split('\n').find(value => value.match(new RegExp(`^${key}:\\s*`)));
  if (!line) return undefined;
  const value = line.replace(new RegExp(`^${key}:\\s*`), '').trim();
  return (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
    ? value.slice(1, -1)
    : value;
}
function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
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
  const copilotNames = activeTools;
  const mcpNames = mcpTools;
  return { commands, settings, contractTools, activeTools, mcpTools, copilotNames, mcpNames, routes, databaseKinds, formats };
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
  assertExactCatalog('command', catalog.commands, tableValues(generated.commands, 'COMMANDS'));
  assertExactCatalog('setting', catalog.settings, tableValues(generated.settings, 'SETTINGS'));
  assertExactCatalog('advertised DatabaseKind', catalog.databaseKinds.filter(value => advertisedDatabaseKinds.has(value)), tableValues(generated.databases, 'DATABASES', value => value.toLowerCase()));
  assertExactCatalog('Web API route', catalog.routes, tableValues(generated.api, 'ROUTES'));
  assertExactCatalog('import/export format', catalog.formats, tableValues(generated.formats, 'FORMATS', value => value.toLowerCase()));
  assertExactCatalog('Copilot tool', catalog.copilotNames, tableValues(generated.api, 'AI_TOOLS'));
  assertExactCatalog('MCP tool', catalog.mcpNames, tableValues(generated.api, 'MCP_TOOLS'));
  for (const tool of catalog.activeTools) if (!catalog.contractTools.includes(tool)) fail(`Active Copilot tool has no contract: ${tool}`);
  for (const tool of catalog.contractTools) if (!catalog.activeTools.includes(tool)) fail(`Contract tool is not registered: ${tool}`);
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
    const relative = path.relative(root, file);
    if (!/^---\s*\n/.test(source)) {
      fail(`Guide page has no front matter: ${relative}`);
      continue;
    }
    const verified = frontMatterValue(source, 'last_verified');
    if (!verified) fail(`Guide page has no last_verified: ${relative}`);
    else if (!isValidIsoDate(verified)) fail(`Guide page has invalid last_verified: ${relative} (${verified})`);
    const version = frontMatterValue(source, 'product_version');
    if (!version) fail(`Guide page has no product_version: ${relative}`);
    else if (version !== packageJson.version) fail(`Guide page product_version does not match package.json: ${relative} (${version} != ${packageJson.version})`);
  }

  // The guide is required to carry complete front matter. Other Markdown
  // documents may opt into release-version tracking by declaring
  // product_version; when they do, it must stay aligned with the package.
  const trackedDocumentationFiles = await filesUnder(docsRoot, '.md');
  for (const file of trackedDocumentationFiles) {
    if (file.startsWith(`${guideRoot}${path.sep}`)) {
      continue;
    }

    const source = await readFile(file, 'utf8');
    const version = frontMatterValue(source, 'product_version');
    if (version && version !== packageJson.version) {
      const relative = path.relative(root, file);
      fail(`Documentation product_version does not match package.json: ${relative} (${version} != ${packageJson.version})`);
    }
  }

  const indexFile = path.join(guideRoot, 'index.md');
  const indexSource = await readFile(indexFile, 'utf8');
  const narrativeVersion = indexSource.match(
    /This portal (?:was verified against product version|is published for product version) \*\*([^*]+)\*\*/,
  )?.[1];
  if (!narrativeVersion) {
    fail('Documentation guide index has no product-version narrative.');
  } else if (narrativeVersion !== packageJson.version) {
    fail(`Documentation guide index narrative does not match package.json: ${narrativeVersion} != ${packageJson.version}`);
  }
}

async function checkBuildProvenance(catalog) {
  const file = path.join(siteRoot, 'build-info.json');
  let buildInfo;
  try {
    buildInfo = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    fail('Generated build-info.json is missing or invalid.');
    return;
  }
  if (buildInfo.schemaVersion !== 1) fail(`Unsupported documentation build-info schema: ${buildInfo.schemaVersion}`);
  if (buildInfo.productVersion !== packageJson.version) fail(`Generated product version does not match package.json: ${buildInfo.productVersion} != ${packageJson.version}`);
  if (!/^[0-9a-f]{40}$/i.test(buildInfo.sourceCommit ?? '')) fail(`Generated documentation has no full source commit: ${buildInfo.sourceCommit ?? 'missing'}`);
  if (!isValidIsoDate(String(buildInfo.generatedAt ?? '').slice(0, 10))) fail(`Generated documentation has invalid generation timestamp: ${buildInfo.generatedAt ?? 'missing'}`);
  if (typeof buildInfo.workingTreeDirty !== 'boolean') fail('Generated documentation build-info.json has no workingTreeDirty boolean.');

  let currentCommit = '';
  try { currentCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { /* source checkout may not contain .git */ }
  if (/^[0-9a-f]{40}$/i.test(currentCommit) && buildInfo.sourceCommit !== currentCommit) fail(`Generated source commit does not match checkout: ${buildInfo.sourceCommit} != ${currentCommit}`);

  let searchIndex;
  try { searchIndex = JSON.parse(await readFile(path.join(siteRoot, 'guide', 'search-index.json'), 'utf8')); } catch { searchIndex = undefined; }
  if (!Array.isArray(searchIndex)) fail('Generated search index is missing or invalid.');
  const counts = buildInfo.counts ?? {};
  const expectedCounts = {
    pages: Array.isArray(searchIndex) ? searchIndex.length : undefined,
    guidePages: Array.isArray(searchIndex) ? searchIndex.filter(page => !String(page.url ?? '').startsWith('guide/legacy/')).length : undefined,
    legacyPages: Array.isArray(searchIndex) ? searchIndex.filter(page => String(page.url ?? '').startsWith('guide/legacy/')).length : undefined,
    commands: catalog.commands.length,
    settings: catalog.settings.length,
    copilotTools: catalog.copilotNames.length,
    mcpTools: catalog.mcpNames.length,
    routes: catalog.routes.length,
    databaseKinds: catalog.databaseKinds.filter(kind => advertisedDatabaseKinds.has(kind)).length,
    formats: catalog.formats.length,
  };
  for (const [key, expected] of Object.entries(expectedCounts)) {
    if (expected !== undefined && counts[key] !== expected) fail(`Generated build count ${key} is stale: ${counts[key]} != ${expected}`);
  }
}

async function checkNarrativeCommands(catalog) {
  const requiredNarrativeCommands = new Map([
    ['netezza.showMetadataRefreshDetails', 'guide/user/schema-browser.md'],
  ]);
  const canonicalSources = await filesUnder(path.join(guideRoot, 'user'), '.md');
  const canonicalText = (await Promise.all(canonicalSources.map(file => readFile(file, 'utf8')))).join('\n');
  for (const [command, preferredPage] of requiredNarrativeCommands) {
    if (!catalog.commands.includes(command)) {
      fail(`Required narrative command is not present in the live manifest: ${command}`);
      continue;
    }
    if (!canonicalText.includes(command)) fail(`Command has no description in the canonical user guide: ${command} (expected near ${preferredPage})`);
  }
}

async function checkBuiltLinks() {
  const htmlFiles = await filesUnder(siteRoot, '.html');
  for (const file of htmlFiles) {
    const html = await readFile(file, 'utf8');
    if (/language-mermaid/.test(html)) fail(`Unconverted mermaid fence in ${path.relative(root, file)}`);
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
  await checkBuildProvenance(catalog);
  await checkNarrativeCommands(catalog);
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
