import * as fs from 'fs';
import * as path from 'path';

export interface WebSnippet {
  prefix: string[];
  body: string[];
  description?: string;
}

interface SnippetFileEntry {
  prefix?: string | string[];
  body?: string | string[];
  description?: string;
}

interface SnippetFile {
  [name: string]: SnippetFileEntry;
}

const SNIPPET_PATHS = [
  '../../dialects/netezza/snippets/netezza.code-snippets',
  '../../../dialects/netezza/snippets/netezza.code-snippets',
];

function resolveSnippetFile(): string | null {
  for (const relative of SNIPPET_PATHS) {
    const candidate = path.resolve(__dirname, relative);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function loadNetezzaSnippets(): WebSnippet[] {
  const file = resolveSnippetFile();
  if (!file) return [];
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const contents = JSON.parse(raw) as SnippetFile;
    return Object.values(contents).map(entry => ({
      prefix: Array.isArray(entry.prefix) ? entry.prefix : entry.prefix ? [entry.prefix] : [],
      body: Array.isArray(entry.body) ? entry.body : entry.body ? [entry.body] : [],
      description: entry.description,
    })).filter(snippet => snippet.prefix.length > 0 && snippet.body.length > 0);
  } catch {
    return [];
  }
}