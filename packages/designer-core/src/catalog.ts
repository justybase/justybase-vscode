import type {
  DatabaseDesignerColumn,
  DatabaseDesignerConstraint,
  DatabaseDesignerIndex,
  DatabaseDesignerTrigger,
} from '@justybase/contracts';

/** Normalized catalog row consumed by the platform-neutral snapshot parsers. */
export type CatalogRow = Record<string, unknown>;

export function rowString(row: CatalogRow, key: string, fallback = ''): string {
  const value = row[key];
  return value === null || value === undefined ? fallback : String(value);
}

export function rowNumber(row: CatalogRow, key: string, fallback = 0): number {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : fallback;
}

export function rowBoolean(row: CatalogRow, key: string): boolean {
  const value = row[key];
  return value === true || value === 1 || value === '1' || String(value).toUpperCase() === 'TRUE';
}

export function splitTopLevelList(value: string): string[] {
  const items: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | '`' | '[' | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? '';
    const next = value[index + 1] ?? '';
    if (quote) {
      if (quote === '[') {
        if (character === ']') quote = undefined;
      } else if (character === quote && next === quote) {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quote = character;
    else if (character === '[') quote = '[';
    else if (character === '(') depth += 1;
    else if (character === ')' && depth > 0) depth -= 1;
    else if (character === ',' && depth === 0) {
      items.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  items.push(value.slice(start).trim());
  return items.filter(Boolean);
}

export function splitColumnList(value: string): string[] {
  return splitTopLevelList(value)
    .map(item => item.trim().replace(/^"(.*)"$/u, '$1').replace(/""/g, '"'))
    .filter(Boolean);
}

export function rowStringArray(row: CatalogRow, key: string): string[] {
  const value = row[key];
  if (Array.isArray(value)) return value.map(item => String(item)).filter(Boolean);
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  const list = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed;
  return splitTopLevelList(list)
    .map(item => item.trim().replace(/^"(.*)"$/u, '$1').replace(/""/g, '"'))
    .filter(Boolean);
}

function matchingParenthesis(source: string, openingIndex: number): number {
  let depth = 0;
  let quote: "'" | '"' | '`' | undefined;
  for (let index = openingIndex; index < source.length; index += 1) {
    const character = source[index] ?? '';
    const next = source[index + 1] ?? '';
    if (quote) {
      if (character === quote && next === quote) index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quote = character;
    else if (character === '(') depth += 1;
    else if (character === ')' && --depth === 0) return index;
  }
  return -1;
}

function sqliteTableDefinitionItems(source: string): string[] {
  let quote: "'" | '"' | '`' | undefined;
  let openingIndex = -1;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';
    const next = source[index + 1] ?? '';
    if (quote) {
      if (character === quote && next === quote) index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quote = character;
    else if (character === '(') {
      openingIndex = index;
      break;
    }
  }
  if (openingIndex < 0) return [];
  const closingIndex = matchingParenthesis(source, openingIndex);
  if (closingIndex < 0) return [];
  const definition = source.slice(openingIndex + 1, closingIndex);
  const items: string[] = [];
  let start = 0;
  let depth = 0;
  quote = undefined;
  for (let index = 0; index < definition.length; index += 1) {
    const character = definition[index] ?? '';
    const next = definition[index + 1] ?? '';
    if (quote) {
      if (character === quote && next === quote) index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quote = character;
    else if (character === '(') depth += 1;
    else if (character === ')' && depth > 0) depth -= 1;
    else if (character === ',' && depth === 0) {
      items.push(definition.slice(start, index).trim());
      start = index + 1;
    }
  }
  items.push(definition.slice(start).trim());
  return items.filter(Boolean);
}

export function parseSqliteCheckConstraints(source: string): DatabaseDesignerConstraint[] {
  return sqliteTableDefinitionItems(source).flatMap(item => {
    const start = /\b(?:CONSTRAINT\s+((?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*))\s+)?CHECK\s*\(/i.exec(item);
    if (!start) return [];
    const openingIndex = item.indexOf(start[0]) + start[0].lastIndexOf('(');
    const closingIndex = matchingParenthesis(item, openingIndex);
    if (closingIndex < 0) return [];
    const expression = item.slice(openingIndex + 1, closingIndex).trim();
    if (!expression) return [];
    const rawName = start[1]?.trim();
    const name = rawName?.startsWith('"') && rawName.endsWith('"')
      ? rawName.slice(1, -1).replace(/""/g, '"')
      : rawName;
    return [{ kind: 'check' as const, ...(name ? { name } : {}), expression }];
  });
}

export function viewQueryFromSource(source: string): string {
  const query = /\bAS\b([\s\S]*)$/i.exec(source)?.[1]?.trim() ?? '';
  return query.replace(/;\s*$/u, '').trim();
}

export function sqliteColumnsFromRows(rows: CatalogRow[]): DatabaseDesignerColumn[] {
  return rows.map(row => ({
    name: rowString(row, 'name'),
    dataType: rowString(row, 'type', 'UNKNOWN'),
    ordinal: rowNumber(row, 'cid') + 1,
    nullable: !rowBoolean(row, 'notnull'),
    ...(Object.prototype.hasOwnProperty.call(row, 'dflt_value')
      ? { defaultExpression: row.dflt_value as string | null }
      : Object.prototype.hasOwnProperty.call(row, 'default_value')
      ? { defaultExpression: row.default_value as string | null }
      : {}),
  })).filter(column => column.name.length > 0);
}

export function duckDbColumnsFromRows(rows: CatalogRow[], includeStorageMetadata = true): DatabaseDesignerColumn[] {
  return rows.map(row => ({
    name: rowString(row, 'column_name'),
    dataType: rowString(row, 'data_type', 'UNKNOWN'),
    ordinal: rowNumber(row, 'ordinal_position'),
    nullable: rowString(row, 'is_nullable', 'YES').toUpperCase() !== 'NO',
    ...(includeStorageMetadata && Object.prototype.hasOwnProperty.call(row, 'column_default')
      ? { defaultExpression: row.column_default as string | null }
      : {}),
    ...(includeStorageMetadata && rowBoolean(row, 'is_identity') ? { identity: true } : {}),
    ...(includeStorageMetadata && rowString(row, 'generation_expression')
      ? { generatedExpression: rowString(row, 'generation_expression') }
      : {}),
  })).filter(column => column.name.length > 0);
}

export function parseDuckDbConstraints(rows: CatalogRow[], schema: string): DatabaseDesignerConstraint[] {
  const constraints: DatabaseDesignerConstraint[] = [];
  for (const row of rows) {
    const kind = rowString(row, 'constraint_type').toUpperCase();
    const name = rowString(row, 'constraint_name') || undefined;
    const constraintColumns = rowStringArray(row, 'constraint_column_names');
    if (kind === 'PRIMARY KEY' || kind === 'UNIQUE') {
      constraints.push({
        kind: kind === 'PRIMARY KEY' ? 'primaryKey' : 'unique',
        ...(name ? { name } : {}),
        columns: constraintColumns,
        enforced: true,
      });
    } else if (kind === 'CHECK') {
      const expression = rowString(row, 'expression') || rowString(row, 'constraint_text');
      if (expression) constraints.push({ kind: 'check', ...(name ? { name } : {}), expression, enforced: true });
    } else if (kind === 'FOREIGN KEY') {
      const referencedTable = rowString(row, 'referenced_table');
      if (referencedTable) {
        constraints.push({
          kind: 'foreignKey',
          ...(name ? { name } : {}),
          columns: constraintColumns,
          referencedSchema: schema,
          referencedTable,
          referencedColumns: rowStringArray(row, 'referenced_column_names'),
          enforced: true,
        });
      }
    }
  }
  return constraints;
}

export function parseDuckDbIndexes(rows: CatalogRow[]): DatabaseDesignerIndex[] {
  return rows.map(row => {
    const name = rowString(row, 'index_name');
    const sourceDdl = rowString(row, 'sql');
    return {
      kind: 'relational' as const,
      name,
      columns: rowStringArray(row, 'expressions').map(expression => ({ expression })),
      unique: rowBoolean(row, 'is_unique'),
      ...(sourceDdl ? { sourceDdl } : {}),
    };
  }).filter(index => index.name.length > 0);
}

export function parseSqliteTrigger(name: string, source: string): DatabaseDesignerTrigger {
  const header = /\b(BEFORE|AFTER|INSTEAD\s+OF)\s+(INSERT|DELETE|UPDATE(?:\s+OF\s+.+?)?)\s+ON\s+/i.exec(source);
  const timing = header?.[1]?.toUpperCase().replace(/\s+/g, ' ') as DatabaseDesignerTrigger['timing'] | undefined;
  const eventText = header?.[2]?.trim() ?? '';
  const normalizedEventText = eventText.toUpperCase();
  const updateColumns = /^UPDATE\s+OF\s+(.+)$/i.exec(eventText)?.[1];
  const event = normalizedEventText.startsWith('UPDATE') ? 'UPDATE' : normalizedEventText.startsWith('INSERT') ? 'INSERT' : normalizedEventText.startsWith('DELETE') ? 'DELETE' : undefined;
  const whenExpression = /\bWHEN\s+([\s\S]*?)\s+BEGIN\b/i.exec(source)?.[1]?.trim();
  return {
    name,
    timing: timing ?? 'UNSPECIFIED',
    events: event ? [event] : [],
    level: 'ROW',
    ...(updateColumns ? { updateColumns: splitColumnList(updateColumns) } : {}),
    ...(whenExpression ? { whenExpression } : {}),
    body: source,
  };
}
