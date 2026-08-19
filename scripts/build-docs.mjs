import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const docsRoot = path.join(root, 'docs');
const guideRoot = path.join(docsRoot, 'guide');
const siteRoot = path.join(root, '_site');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const productVersion = packageJson.version;
const lastVerified = process.env.DOCS_LAST_VERIFIED ?? '2026-08-19';
const advertisedDatabaseKinds = new Set(['netezza', 'db2', 'mssql', 'oracle', 'postgresql', 'mysql', 'access', 'duckdb', 'sqlite']);

function getBuildProvenance() {
  let sourceCommit = '';
  let workingTreeDirty = false;
  try {
    sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    workingTreeDirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim().length > 0;
  } catch {
    // Some sandboxed local Node runtimes block child_process even though the
    // checkout is readable. Resolve HEAD directly so local docs:check still
    // records an auditable commit.
    let gitDirectory = path.join(root, '.git');
    try {
      const gitFile = readFileSync(gitDirectory, 'utf8');
      const match = gitFile.match(/^gitdir:\s*(.+)$/m);
      if (match) gitDirectory = path.resolve(root, match[1].trim());
    } catch {
      // Normal repositories have a .git directory.
    }
    try {
      const head = readFileSync(path.join(gitDirectory, 'HEAD'), 'utf8').trim();
      if (head.startsWith('ref: ')) {
        const ref = head.slice('ref: '.length).trim();
        try {
          sourceCommit = readFileSync(path.join(gitDirectory, ref), 'utf8').trim();
        } catch {
          const packedRefs = readFileSync(path.join(gitDirectory, 'packed-refs'), 'utf8');
          sourceCommit = packedRefs.split('\n').find(line => line.endsWith(` ${ref}`))?.split(' ', 1)[0] ?? '';
        }
      } else {
        sourceCommit = head;
      }
    } catch {
      sourceCommit = '';
    }
    workingTreeDirty = true;
  }
  if (!sourceCommit) sourceCommit = process.env.GITHUB_SHA?.trim() ?? '';
  const sourceCommitShort = sourceCommit && /^[0-9a-f]{7,40}$/i.test(sourceCommit) ? sourceCommit.slice(0, 12) : 'unknown';
  return {
    sourceCommit: sourceCommit || 'unknown',
    sourceCommitShort,
    sourceCommitUrl: sourceCommit && /^[0-9a-f]{40}$/i.test(sourceCommit)
      ? `https://github.com/justybase/justybase-vscode/commit/${sourceCommit}`
      : 'https://github.com/justybase/justybase-vscode',
    workingTreeDirty,
    generatedAt: new Date().toISOString(),
  };
}

const navGroups = [
  { label: 'Start here', items: ['guide/user/getting-started', 'guide/user/connections'] },
  {
    label: 'Product guides',
    items: [
      'guide/user/parser-lsp',
      'guide/user/sql-quality',
      'guide/user/performance-reliability',
      'guide/user/data-grid',
      'guide/user/import-export',
      'guide/user/schema-search',
      'guide/user/ai-assistant',
      'guide/user/schema-browser',
      'guide/user/history-favorites',
      'guide/user/sql-console-notebooks',
      'guide/user/data-workspace',
      'guide/user/visual-builder-erd',
      'guide/user/migration-etl',
      'guide/user/table-design-maintenance',
      'guide/user/session-security',
      'guide/user/test-data-compare',
      'guide/user/query-flow-file-search',
    ],
  },
  {
    label: 'Reference',
    items: [
      'guide/reference/database-support',
      'guide/reference/settings',
      'guide/reference/commands',
      'guide/reference/web-api',
      'guide/reference/statuses-and-permissions',
    ],
  },
  {
    label: 'Administration',
    items: ['guide/admin/web-editor', 'guide/admin/deployment-security', 'guide/admin/backup-restore'],
  },
  {
    label: 'Developers',
    items: ['guide/developer/architecture', 'guide/developer/testing-and-docs', 'guide/developer/performance-benchmarks'],
  },
];

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function parseFrontMatter(source, fallbackTitle) {
  const match = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  const metadata = { title: fallbackTitle };
  if (!match) return { metadata, body: source };
  for (const line of match[1].split('\n')) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) continue;
    let value = field[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else if (value === 'true' || value === 'false') {
      value = value === 'true';
    } else if (/^-?\d+(\.\d+)?$/.test(value)) {
      value = Number(value);
    }
    metadata[field[1]] = value;
  }
  return { metadata, body: source.slice(match[0].length) };
}

function titleFromFile(filePath) {
  return path.basename(filePath, '.md').replace(/[-_]+/g, ' ').replace(/\b\w/g, character => character.toUpperCase());
}

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(entryPath);
  }
  return files;
}

function slugify(value) {
  return value.toLowerCase().trim().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section';
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

function headingSlug(value) {
  return slugify(decodeHtmlEntities(value).replace(/[`*_]/g, '').trim());
}

function nextHeadingId(value, seen) {
  const base = headingSlug(value);
  const count = (seen.get(base) ?? 0) + 1;
  seen.set(base, count);
  return count === 1 ? base : `${base}-${count}`;
}

function stripMarkdown(value) {
  return value
    .replace(/^---[\s\S]*?---\s*/m, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_>#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenText(token) {
  if (!token) return '';
  if (typeof token === 'string') return token;
  if (Array.isArray(token.tokens)) return token.tokens.map(tokenText).join('');
  return token.text ?? token.raw ?? '';
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function pageUrlFromSource(filePath, sourceRoot) {
  const relative = toPosix(path.relative(sourceRoot, filePath)).replace(/\.md$/, '');
  if (relative === 'index') return 'guide/';
  return `guide/${relative}/`;
}

function outputFileForUrl(url) {
  return path.join(siteRoot, ...url.split('/').filter(Boolean), 'index.html');
}

function rootRelativeForOutput(outputFile) {
  const relative = toPosix(path.relative(path.dirname(outputFile), siteRoot));
  return relative ? `${relative}/` : './';
}

function repositoryUrl(relativePath, anchor = '') {
  const normalized = toPosix(relativePath);
  const kind = path.extname(normalized) ? 'blob' : 'tree';
  return `https://github.com/justybase/justybase-vscode/${kind}/master/${normalized}${anchor}`;
}

function rewriteLocalLinks(html, rootRelative, sourceFile, legacyPageUrls) {
  const sourceDirectory = sourceFile ? path.dirname(sourceFile) : docsRoot;
  return html
    .replace(/href="([^"#?]+)(#[^"]*)?"/g, (match, target, anchor = '') => {
      if (target.startsWith('http:') || target.startsWith('https:') || target.startsWith('mailto:') || target.startsWith('data:')) return match;
      if (target === 'guide' || target.startsWith('guide/')) return `href="${rootRelative}${target}${anchor}"`;
      if (target === './guide' || target.startsWith('./guide/')) return `href="${rootRelative}${target.slice(2)}${anchor}"`;

      const resolved = path.resolve(target.startsWith('docs/') ? root : sourceDirectory, target.startsWith('docs/') ? target : target);
      const relativeToDocs = path.relative(docsRoot, resolved);
      const relativeToRepo = path.relative(root, resolved);
      const legacyUrl = !relativeToDocs.startsWith('..') && !path.isAbsolute(relativeToDocs)
        ? legacyPageUrls.get(toPosix(relativeToDocs))
        : undefined;
      if (legacyUrl) return `href="${rootRelative}${legacyUrl}${anchor}"`;
      if (!relativeToRepo.startsWith('..') && !path.isAbsolute(relativeToRepo) && existsSync(resolved)) {
        return `href="${repositoryUrl(relativeToRepo, anchor)}"`;
      }
      return match;
    })
    .replace(/src="screenshots\//g, `src="${rootRelative}screenshots/`)
    .replace(/src="gifs\//g, `src="${rootRelative}gifs/`);
}

function renderMarkdown(markdown, rootRelative, sourceFile, legacyPageUrls) {
  const seenIds = new Map();
  const renderer = new marked.Renderer();
  renderer.heading = token => {
    const text = tokenText(token);
    const label = decodeHtmlEntities(text);
    const id = nextHeadingId(label, seenIds);
    return `<h${token.depth} id="${id}"><a class="heading-anchor" href="#${id}" aria-label="Link to ${escapeHtml(label)}">#</a>${marked.parseInline(text)}</h${token.depth}>\n`;
  };
  renderer.code = token => {
    const language = token.lang ? ` class="language-${escapeHtml(token.lang)}"` : '';
    const encoded = escapeHtml(token.text);
    const copyValue = escapeHtml(token.text);
    return `<div class="code-block"><button class="copy-code" type="button" data-copy-code="${copyValue}">Copy</button><pre><code${language}>${encoded}</code></pre></div>\n`;
  };
  renderer.link = token => {
    const label = marked.parseInline(tokenText(token));
    const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
    return `<a href="${escapeHtml(token.href)}"${title}>${label}</a>`;
  };
  return rewriteLocalLinks(marked.parse(markdown, { renderer, gfm: true, breaks: false }), rootRelative, sourceFile, legacyPageUrls);
}

function statusBadge(status) {
  if (!status) return '';
  const normalized = String(status).toLowerCase().replace(/\s+/g, '-');
  return `<span class="status status-${normalized}">${escapeHtml(String(status))}</span>`;
}

function tableOfContents(markdown) {
  const headings = [];
  const seen = new Map();
  for (const token of marked.lexer(markdown)) {
    if (token.type !== 'heading') continue;
    const text = decodeHtmlEntities(token.text.replace(/[`*_]/g, '').trim());
    const id = nextHeadingId(text, seen);
    if (token.depth === 2 || token.depth === 3) headings.push({ text, id, level: token.depth });
  }
  if (headings.length === 0) return '';
  return `<div class="toc-title">On this page</div><ul>${headings.map(item => `<li class="toc-level-${item.level}"><a href="#${item.id}">${escapeHtml(item.text)}</a></li>`).join('')}</ul>`;
}

function pageMeta(metadata, url) {
  return {
    ...metadata,
    title: metadata.title ?? 'JustyBase documentation',
    description: metadata.description ?? '',
    status: metadata.status ?? 'Supported',
    audience: metadata.audience ?? 'user',
    category: metadata.category ?? 'Product guides',
    product_version: metadata.product_version ?? productVersion,
    last_verified: metadata.last_verified ?? lastVerified,
    url,
  };
}

function navHtml(currentUrl, rootRelative, pages) {
  return navGroups.map(group => {
    const links = group.items.map(item => {
      const page = pages.find(candidate => candidate.url === `${item}/` || candidate.url === item);
      if (!page) return '';
      const current = currentUrl === page.url ? ' aria-current="page" class="is-current"' : '';
      return `<li><a href="${rootRelative}${page.url}"${current}>${escapeHtml(page.title)}</a></li>`;
    }).join('');
    return `<section class="nav-group"><h2>${escapeHtml(group.label)}</h2><ul>${links}</ul></section>`;
  }).join('');
}

function pageHtml(page, markdown, outputFile, pages, legacyPageUrls, buildInfo) {
  const rootRelative = rootRelativeForOutput(outputFile);
  const body = renderMarkdown(markdown, rootRelative, page.sourceFile, legacyPageUrls);
  const canonical = `https://justybase.github.io/justybase-vscode/${page.url}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#10182b">
    <meta name="description" content="${escapeHtml(page.description)}">
    <meta name="justybase:product-version" content="${escapeHtml(productVersion)}">
    <meta name="justybase:source-commit" content="${escapeHtml(buildInfo.sourceCommit)}">
    <link rel="canonical" href="${canonical}">
    <link rel="icon" type="image/svg+xml" href="${rootRelative}favicon.svg">
    <link rel="stylesheet" href="${rootRelative}guide-assets/guide.css">
    <title>${escapeHtml(page.title)} · JustyBase documentation</title>
  </head>
  <body class="no-js" data-search-index="${rootRelative}guide/search-index.json" data-site-root="${rootRelative}" data-source-commit="${escapeHtml(buildInfo.sourceCommit)}">
    <a class="skip-link" href="#main-content">Skip to content</a>
    <header class="guide-header">
      <div class="guide-container guide-header-inner">
        <a class="guide-brand" href="${rootRelative}guide/" aria-label="JustyBase documentation home"><span class="guide-mark">N</span><span><strong>JustyBase</strong><small>Documentation</small></span></a>
        <nav class="guide-top-nav" aria-label="Documentation navigation"><a href="${rootRelative}">Product home</a><a href="${rootRelative}guide/">Guide home</a><a href="${rootRelative}guide/reference/commands/">Command reference</a><a href="https://github.com/justybase/justybase-vscode" target="_blank" rel="noreferrer">GitHub ↗</a></nav>
        <button class="sidebar-toggle" type="button" aria-expanded="false" aria-controls="guide-sidebar">Sections</button>
      </div>
    </header>
    <div class="guide-layout guide-container">
      <aside id="guide-sidebar" class="guide-sidebar" aria-label="Documentation sections">
        <form class="guide-search" role="search"><label for="guide-search-input">Search documentation</label><div><input id="guide-search-input" type="search" placeholder="Search…" autocomplete="off"><button type="submit">Go</button></div><div id="search-results" aria-live="polite"></div></form>
        ${navHtml(page.url, rootRelative, pages)}
        <div class="legacy-note"><strong>Technical appendices</strong><p>Implementation notes remain available under <a href="${rootRelative}guide/legacy/">legacy reference</a>.</p></div>
      </aside>
      <main id="main-content" class="guide-main">
        <nav class="breadcrumbs" aria-label="Breadcrumbs"><a href="${rootRelative}guide/">Documentation</a><span>›</span><span>${escapeHtml(page.category)}</span><span>›</span><strong>${escapeHtml(page.title)}</strong></nav>
        <div class="page-heading"><div><p class="eyebrow">${escapeHtml(page.audience)} guide</p><h1>${escapeHtml(page.title)}</h1><p class="lead">${escapeHtml(page.description)}</p></div><div class="page-badges">${statusBadge(page.status)}<span class="verified">v${escapeHtml(String(page.product_version))} · verified ${escapeHtml(String(page.last_verified))}</span></div></div>
        <div class="content-layout"><article class="markdown-body">${body}</article><aside class="page-toc" aria-label="Page contents">${tableOfContents(markdown)}</aside></div>
        <div class="page-footer-nav"><a href="${rootRelative}guide/">← Documentation home</a><a href="${rootRelative}guide/reference/statuses-and-permissions/">Statuses and permissions →</a></div>
      </main>
    </div>
    <footer class="guide-footer"><div class="guide-container"><span>JustyBase ${escapeHtml(productVersion)}</span><span>Source <a href="${buildInfo.sourceCommitUrl}" target="_blank" rel="noreferrer">${escapeHtml(buildInfo.sourceCommitShort)}</a>${buildInfo.workingTreeDirty ? ' · working tree' : ''}</span><span>Apache-2.0</span><a href="https://github.com/justybase/justybase-vscode/issues">Report an issue</a></div></footer>
    <script defer src="${rootRelative}guide-assets/guide.js"></script>
  </body>
</html>`;
}

async function optionalPackageJsons() {
  const extensionRoot = path.join(root, 'extensions');
  const entries = await readdir(extensionRoot, { withFileTypes: true });
  const manifests = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      manifests.push(JSON.parse(await readFile(path.join(extensionRoot, entry.name, 'package.json'), 'utf8')));
    } catch {
      // An extension directory without a manifest is not a publishable package.
    }
  }
  return manifests;
}

function uniqueByName(items, key) {
  const seen = new Set();
  return items.filter(item => {
    const value = item[key];
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function displayCatalogValue(value) {
  if (value === undefined || value === null) return '—';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function readRegexValues(source, pattern) {
  return [...source.matchAll(pattern)].map(match => match[1]).filter(Boolean);
}

function extractApiRoutes(source) {
  return [...source.matchAll(/app\.(?:get|post|put|patch|delete)(?:<[^()]*?>)?\(\s*['"`](\/[^'"`]+)['"`]/g)].map(match => match[1]);
}

function extractTypeUnionValues(source, typeName) {
  const declaration = source.match(new RegExp(`${typeName}\\s*=\\s*([^;]+)`))?.[1] ?? '';
  return [...declaration.matchAll(/'([^']+)'/g)].map(match => match[1]);
}

async function liveCatalogs() {
  const optional = await optionalPackageJsons();
  const manifests = [packageJson, ...optional];
  const commands = uniqueByName(manifests.flatMap(manifest => manifest.contributes?.commands ?? []), 'command').sort((a, b) => a.command.localeCompare(b.command));
  const settings = uniqueByName(manifests.flatMap(manifest => Object.entries(manifest.contributes?.configuration?.properties ?? {}).map(([key, value]) => ({ key, ...(value ?? {}) }))), 'key').sort((a, b) => a.key.localeCompare(b.key));
  const contractSource = await readFile(path.join(root, 'src/contracts/copilotTools/contracts.ts'), 'utf8');
  const registrationSource = await readFile(path.join(root, 'src/activation/copilotRegistration.ts'), 'utf8');
  const mcpSource = await readFile(path.join(root, 'src/mcp/mcpToolCatalog.ts'), 'utf8');
  const copilotNames = [...new Set(readRegexValues(registrationSource, /name:\s*'([^']+)'/g))].sort();
  const mcpNames = [...new Set(readRegexValues(mcpSource, /name:\s*'([^']+)'/g))].sort();
  const contractNames = [...new Set(readRegexValues(contractSource, /name:\s*'([^']+)'/g))].filter(name => name.startsWith('netezza_')).sort();
  const apiSource = await readFile(path.join(root, 'apps/api/src/server.ts'), 'utf8');
  const routes = [...new Set(extractApiRoutes(apiSource))].sort();
  const databaseSource = await readFile(path.join(root, 'packages/contracts/src/database/index.ts'), 'utf8');
  const databaseKinds = [...new Set(readRegexValues(databaseSource, /\|\s*'([^']+)'/g))].filter(value => value !== 'string').sort();
  const exportSource = await readFile(path.join(root, 'packages/contracts/src/webApi.ts'), 'utf8');
  const exportFormats = extractTypeUnionValues(exportSource, 'QueryExportFormat');
  const importFormats = extractTypeUnionValues(exportSource, 'QueryFileImportFormat');
  const formats = [...new Set([...exportFormats, ...importFormats, 'parquet', 'xpt'])].sort();
  return { commands, settings, copilotNames, mcpNames, contractNames, routes, databaseKinds, exportFormats, importFormats, formats, manifests };
}

function catalogMarkdown(catalog) {
  const commandRows = catalog.commands.map(command => `| \`${command.command}\` | ${String(command.title ?? '').replaceAll('|', '\\|')} |`).join('\n');
  const settingRows = catalog.settings.map(setting => `| \`${setting.key}\` | ${displayCatalogValue(setting.default).replaceAll('|', '\\|').replaceAll('\n', ' ')} | ${displayCatalogValue(setting.description ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')} |`).join('\n');
  const toolRows = catalog.copilotNames.map(name => `| \`${name}\` | Language Model Tool |`).join('\n');
  const mcpRows = catalog.mcpNames.map(name => `| \`${name}\` | Read-only MCP catalog |`).join('\n');
  const routeRows = catalog.routes.map(route => `| \`${route}\` | Web API route |`).join('\n');
  const dbRows = catalog.databaseKinds.filter(kind => advertisedDatabaseKinds.has(kind)).map(kind => `| \`${kind}\` | ${kind === 'sqlite' || kind === 'duckdb' ? 'Local / file runtime' : 'Database or companion runtime'} |`).join('\n');
  const formats = catalog.formats;
  return {
    COMMANDS: `<!-- GENERATED_TABLE:COMMANDS -->\n| Command | Title |\n| --- | --- |\n${commandRows}`,
    SETTINGS: `<!-- GENERATED_TABLE:SETTINGS -->\n| Setting | Default | Description |\n| --- | --- | --- |\n${settingRows}`,
    AI_TOOLS: `<!-- GENERATED_TABLE:AI_TOOLS -->\n| Tool | Surface |\n| --- | --- |\n${toolRows}`,
    MCP_TOOLS: `<!-- GENERATED_TABLE:MCP_TOOLS -->\n| Tool | Surface |\n| --- | --- |\n${mcpRows}`,
    ROUTES: `<!-- GENERATED_TABLE:ROUTES -->\n| Route | Contract surface |\n| --- | --- |\n${routeRows}`,
    DATABASES: `<!-- GENERATED_TABLE:DATABASES -->\n| DatabaseKind | Runtime family |\n| --- | --- |\n${dbRows}`,
    FORMATS: `<!-- GENERATED_TABLE:FORMATS -->\n| Format | Export | Import |\n| --- | --- | --- |\n${formats.map(format => `| **${format.toUpperCase()}** | ${catalog.exportFormats.includes(format) ? 'Export' : '—'} | ${catalog.importFormats.includes(format) ? 'Web/file import' : '—'} |`).join('\n')}`,
  };
}

function expandGeneratedSections(markdown, sections) {
  return Object.entries(sections).reduce((result, [name, value]) => result.replaceAll(`<!-- GENERATED:${name} -->`, value), markdown);
}

async function copyStaticAssets() {
  await cp(path.join(docsRoot, 'index.html'), path.join(siteRoot, 'index.html'));
  for (const file of ['favicon.svg', 'site.css', 'site.js']) await cp(path.join(docsRoot, file), path.join(siteRoot, file));
  for (const directory of ['screenshots', 'gifs', 'design']) await cp(path.join(docsRoot, directory), path.join(siteRoot, directory), { recursive: true });
  const legacyRawRoot = path.join(siteRoot, 'docs');
  await mkdir(legacyRawRoot, { recursive: true });
  for (const file of await markdownFiles(docsRoot)) {
    if (file.startsWith(`${guideRoot}${path.sep}`)) continue;
    const relative = path.relative(docsRoot, file);
    const destination = path.join(legacyRawRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(file, destination);
    if (path.dirname(relative) === '.') await cp(file, path.join(siteRoot, path.basename(file)));
  }
}

async function build() {
  const catalog = await liveCatalogs();
  const generatedSections = catalogMarkdown(catalog);
  await rm(siteRoot, { recursive: true, force: true });
  await mkdir(siteRoot, { recursive: true });
  await writeFile(path.join(siteRoot, '.nojekyll'), '', 'utf8');
  await copyStaticAssets();

  const sourceFiles = await markdownFiles(guideRoot);
  const pages = [];
  const legacyPageUrls = new Map();
  for (const file of sourceFiles) {
    const source = await readFile(file, 'utf8');
    const parsed = parseFrontMatter(source, titleFromFile(file));
    const url = pageUrlFromSource(file, guideRoot);
    const metadata = pageMeta(parsed.metadata, url);
    pages.push({ ...metadata, sourceFile: file, markdown: expandGeneratedSections(parsed.body, generatedSections) });
  }
  const legacyFiles = (await markdownFiles(docsRoot)).filter(file => !file.startsWith(`${guideRoot}${path.sep}`) && !/(?:snowflake|vertica)\.md$/i.test(file));
  for (const file of legacyFiles) {
    const source = await readFile(file, 'utf8');
    const parsed = parseFrontMatter(source, titleFromFile(file));
    const slug = path.basename(file, '.md').toLowerCase();
    const url = `guide/legacy/${slug}/`;
    legacyPageUrls.set(toPosix(path.relative(docsRoot, file)), url);
    pages.push({ ...pageMeta({ ...parsed.metadata, title: parsed.metadata.title ?? titleFromFile(file), category: 'Technical appendices', audience: 'reference', status: parsed.metadata.status ?? 'Legacy reference' }, url), sourceFile: file, markdown: parsed.body });
  }
  pages.push({
    ...pageMeta({ title: 'Technical appendices', description: 'Compatibility pages for the repository Markdown references that predate the documentation portal.', category: 'Technical appendices', audience: 'reference', status: 'Legacy reference' }, 'guide/legacy/'),
    sourceFile: undefined,
    markdown: '# Technical appendices\n\nThese pages preserve the existing repository Markdown references while the maintained user, admin, reference, and developer guides live in the portal. Start with the [documentation home](guide/) or use the sidebar to browse an appendix.',
  });
  pages.sort((left, right) => left.url.localeCompare(right.url));
  const provenance = getBuildProvenance();
  const buildInfo = {
    schemaVersion: 1,
    sourceCommit: provenance.sourceCommit,
    sourceCommitShort: provenance.sourceCommitShort,
    sourceCommitUrl: provenance.sourceCommitUrl,
    workingTreeDirty: provenance.workingTreeDirty,
    generatedAt: provenance.generatedAt,
    productVersion,
    counts: {
      pages: pages.length,
      guidePages: sourceFiles.length,
      legacyPages: pages.length - sourceFiles.length,
      commands: catalog.commands.length,
      settings: catalog.settings.length,
      copilotTools: catalog.copilotNames.length,
      mcpTools: catalog.mcpNames.length,
      routes: catalog.routes.length,
      databaseKinds: catalog.databaseKinds.filter(kind => advertisedDatabaseKinds.has(kind)).length,
      formats: catalog.formats.length,
    },
  };

  for (const page of pages) {
    const outputFile = outputFileForUrl(page.url);
    await mkdir(path.dirname(outputFile), { recursive: true });
    await writeFile(outputFile, pageHtml(page, page.markdown, outputFile, pages, legacyPageUrls, buildInfo), 'utf8');
  }
  const searchIndex = pages.map(page => ({ title: page.title, description: page.description, category: page.category, status: page.status, url: page.url, text: stripMarkdown(page.markdown).slice(0, 5000) }));
  await writeFile(path.join(siteRoot, 'guide', 'search-index.json'), JSON.stringify(searchIndex, null, 2), 'utf8');
  await writeFile(path.join(siteRoot, 'build-info.json'), `${JSON.stringify(buildInfo, null, 2)}\n`, 'utf8');
  await cp(path.join(docsRoot, 'guide-assets'), path.join(siteRoot, 'guide-assets'), { recursive: true });

  console.log(`Documentation site built: ${pages.length} pages, ${catalog.commands.length} commands, ${catalog.settings.length} settings, source ${provenance.sourceCommitShort}.`);
}

await build();
