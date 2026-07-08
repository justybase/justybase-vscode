import { TextDocument } from "vscode-languageserver-textdocument";
import {
  Hover,
  MarkupKind,
  Position,
} from "vscode-languageserver/node";
import type { MetadataBridge } from "./metadataBridge";
import type { AliasInfo } from "../providers/types";

function getUniqueAliasTableBindings(
  aliasBindings: Map<string, AliasInfo>,
): AliasInfo[] {
  const seen = new Set<string>();
  const unique: AliasInfo[] = [];
  for (const binding of aliasBindings.values()) {
    const key = `${binding.db ?? ""}|${binding.schema ?? ""}|${binding.table.toUpperCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(binding);
  }
  return unique;
}

function appendColumnDescriptionLine(
  markdownLines: string[],
  description?: string,
): void {
  if (!description?.trim()) {
    return;
  }
  const trimmed = description.trim();
  const truncated =
    trimmed.length > 500 ? trimmed.substring(0, 500) + "…" : trimmed;
  markdownLines.push("", `Description: ${truncated}`);
}

export interface HoverDependencies {
  resolveSqlRenameSymbol: (
    sql: string,
    offset: number,
    databaseKind?: string,
  ) => { kind: string; name: string; target: { text: string } } | undefined;
  getStatementAtPosition: (
    sql: string,
    offset: number,
  ) => { sql: string; start: number; end: number } | null;
  getAliasBindings: (
    statementSql: string,
    statementOffset: number,
    databaseKind?: string,
  ) => Map<string, AliasInfo>;
  getCompletionLocalDefinitions: (
    fullSql: string,
    statementSql: string,
    statementOffset: number,
    databaseKind?: string,
  ) => { name: string; type: string; columns: string[] }[];
  findLocalDefinition: (
    localDefinitions: { name: string; type: string; columns: string[] }[],
    name: string,
  ) => { name: string; type: string; columns: string[] } | undefined;
  formatObjectPath: (
    dbName: string | undefined,
    schemaName: string | undefined,
    tableName: string,
  ) => string;
  isCancellationRequested: () => boolean;
}

export async function provideHover(
  document: TextDocument,
  params: { position: Position },
  deps: HoverDependencies,
  metadataBridge: MetadataBridge,
): Promise<Hover | null> {
  if (deps.isCancellationRequested()) {
    return null;
  }

  const sql = document.getText();
  const offset = document.offsetAt(params.position);
  const context = await metadataBridge.getContext(document.uri);
  if (deps.isCancellationRequested()) {
    return null;
  }

  const symbol = deps.resolveSqlRenameSymbol(sql, offset, context.databaseKind);
  const statement = deps.getStatementAtPosition(sql, offset);
  const statementSql = statement?.sql ?? sql;
  const statementOffset = statement
    ? Math.max(0, offset - statement.start)
    : offset;
  const aliasBindings = deps.getAliasBindings(
    statementSql,
    statementOffset,
    context.databaseKind,
  );
  const localDefinitions = deps.getCompletionLocalDefinitions(
    sql,
    statementSql,
    statementOffset,
    context.databaseKind,
  );
  const effectiveDatabase = context.effectiveDatabase;

  if (symbol) {
    const markdownLines = [
      `**${symbol.kind.replace("_", " ")}** \`${symbol.name}\``,
    ];

    const aliasReference =
      aliasBindings.get(symbol.name.toUpperCase()) ??
      aliasBindings.get(symbol.target.text.toUpperCase());

    let resolvedReference:
      | { database?: string; schema?: string; table: string }
      | undefined;
    if (aliasReference) {
      resolvedReference = {
        database: aliasReference.db,
        schema: aliasReference.schema,
        table: aliasReference.table,
      };
    } else if (symbol.kind === "table") {
      resolvedReference = { table: symbol.name };
      for (const [, aliasRef] of aliasBindings) {
        if (aliasRef.table.toUpperCase() === symbol.name.toUpperCase()) {
          resolvedReference = {
            database: aliasRef.db,
            schema: aliasRef.schema,
            table: aliasRef.table,
          };
          break;
        }
      }
    }

    if (resolvedReference) {
      if (effectiveDatabase || resolvedReference.database) {
        const database = resolvedReference.database || effectiveDatabase;
        if (database) {
          const tableInfo = await metadataBridge.getTableInfo(
            document.uri,
            database,
            resolvedReference.table,
            resolvedReference.schema,
          );
          if (deps.isCancellationRequested()) {
            return null;
          }

          if (tableInfo) {
            const kindLabel =
              symbol.kind === "table_alias" ? "table alias" : symbol.kind;
            markdownLines.length = 0;
            markdownLines.push(
              `**${kindLabel}** \`${symbol.name}\``,
            );
            if (resolvedReference.schema) {
              markdownLines.push(
                `${resolvedReference.schema} \`${deps.formatObjectPath(database, resolvedReference.schema, resolvedReference.table)}\``,
              );
            } else {
              markdownLines.push(
                `\`${deps.formatObjectPath(database, resolvedReference.schema, resolvedReference.table)}\``,
              );
            }
            if (tableInfo.description) {
              markdownLines.push("", tableInfo.description);
            }
            if (tableInfo.columns.length) {
              markdownLines.push("", "---", "");
              const colLines = tableInfo.columns
                .map((column) => {
                  let badge = "";
                  if (column.isPk) badge += " \u25C6";
                  if (column.isFk) badge += " \u25CB";
                  const badgeStr = badge ? ` ${badge.trim()}` : "";
                    let line = `- **${column.name}**`;
                    if (column.type) {
                      line += ` : \`${column.type}\``;
                  }
                  if (badgeStr) {
                    line += badgeStr;
                  }
                  if (column.description) {
                    const desc =
                      column.description.length > 500
                        ? column.description.substring(0, 500) + "\u2026"
                        : column.description;
                    line += ` — _${desc}_`;
                  }
                  return line;
                });
              markdownLines.push(colLines.join("\n"));
            }
          }
        }
      }

      if (markdownLines.length === 1) {
        const localTarget = deps.findLocalDefinition(
          localDefinitions,
          resolvedReference.table,
        );
        if (localTarget && localTarget.columns.length > 0) {
          const preview = localTarget.columns
            .map((column) => `\`${column}\``)
            .join(", ");
          markdownLines.push("", `Source: \`${resolvedReference.table}\``);
          markdownLines.push(
            "",
            `Columns (${localTarget.columns.length}): ${preview}`,
          );
        }
      }
    }

    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: markdownLines.join("\n"),
      },
    };
  }

  // Manual hover: resolve table or column at cursor
  const fullLineText = document.getText({
    start: { line: params.position.line, character: 0 },
    end: {
      line: params.position.line,
      character: params.position.character + 50,
    },
  });
  const character = params.position.character;

  const wordRegex = /[A-Za-z_][A-Za-z0-9_$]*/g;
  let wordMatch: RegExpExecArray | null;
  let hoverWord: string | undefined;
  let wordStart = -1;
  while ((wordMatch = wordRegex.exec(fullLineText)) !== null) {
    const start = wordMatch.index;
    const end = start + wordMatch[0].length;
    if (character >= start && character <= end) {
      hoverWord = wordMatch[0];
      wordStart = start;
      break;
    }
  }
  if (!hoverWord) {
    return null;
  }

  // Try table name match first (handles JUST_DATA_2.ADMIN.FACT_SALES_2)
  const upperWord = hoverWord.toUpperCase();
  for (const [, aliasRef] of aliasBindings) {
    if (aliasRef.table.toUpperCase() === upperWord) {
      const database = aliasRef.db || effectiveDatabase;
      if (!database) {
        continue;
      }

      const tableInfo = await metadataBridge.getTableInfo(
        document.uri,
        database,
        aliasRef.table,
        aliasRef.schema,
      );
      if (deps.isCancellationRequested()) {
        return null;
      }

      if (tableInfo) {
        const markdownLines = [`**table** \`${hoverWord}\``];
        if (aliasRef.schema) {
          markdownLines.push(
            `${aliasRef.schema} \`${deps.formatObjectPath(database, aliasRef.schema, aliasRef.table)}\``,
          );
        } else {
          markdownLines.push(
            `\`${deps.formatObjectPath(database, aliasRef.schema, aliasRef.table)}\``,
          );
        }
        if (tableInfo.description) {
          markdownLines.push("", tableInfo.description);
        }
        if (tableInfo.columns.length) {
          markdownLines.push("", "---", "");
          const colLines = tableInfo.columns.map((column) => {
            let badge = "";
            if (column.isPk) badge += " \u25C6";
            if (column.isFk) badge += " \u25CB";
            const badgeStr = badge ? ` ${badge.trim()}` : "";
            let line = `- **${column.name}**`;
            if (column.type) {
              line += ` : \`${column.type}\``;
            }
            if (badgeStr) {
              line += badgeStr;
            }
            if (column.description) {
              const desc =
                column.description.length > 500
                  ? column.description.substring(0, 500) + "\u2026"
                  : column.description;
              line += ` — _${desc}_`;
            }
            return line;
          });
          markdownLines.push(colLines.join("\n"));
        }

        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: markdownLines.join("\n"),
          },
        };
      }
    }
  }

  const beforeWordText = fullLineText.substring(0, wordStart);
  const beforeWord = beforeWordText;

  // Qualified column: qualifier.columnName
  const qualifierMatch = beforeWord.match(
    /([A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*$/,
  );

  if (qualifierMatch) {
    const qualifier = qualifierMatch[1];
    const aliasRef = aliasBindings.get(qualifier.toUpperCase());
    if (!aliasRef) {
      return null;
    }

    const database = aliasRef.db || effectiveDatabase;
    if (!database) {
      return null;
    }

    const tableInfo = await metadataBridge.getTableInfo(
      document.uri,
      database,
      aliasRef.table,
      aliasRef.schema,
    );
    if (deps.isCancellationRequested()) {
      return null;
    }

    const matchedColumn = tableInfo?.columns.find(
      (c) => c.name.toUpperCase() === hoverWord.toUpperCase(),
    );

    const markdownLines = [`**column** \`${hoverWord}\``];
    if (matchedColumn) {
      if (matchedColumn.type) {
        markdownLines.push(`: \`${matchedColumn.type}\``);
      }
      const pathStr = deps.formatObjectPath(database, aliasRef.schema, aliasRef.table);
      markdownLines.push(`${qualifier} → \`${pathStr}\``);
      appendColumnDescriptionLine(markdownLines, matchedColumn.description);
    } else {
      const pathStr = deps.formatObjectPath(database, aliasRef.schema, aliasRef.table);
      markdownLines.push(`${qualifier} → \`${pathStr}\``);
    }

    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: markdownLines.join("\n"),
      },
    };
  }

  // Unqualified column: single local definition or unique table source match
  const localColumnSources = localDefinitions.filter((definition) =>
    definition.columns.some(
      (column) => column.toUpperCase() === upperWord,
    ),
  );
  if (localColumnSources.length === 1) {
    const source = localColumnSources[0];
    const markdownLines = [`**column** \`${hoverWord}\``];
    markdownLines.push(`Source: ${source.type} \`${source.name}\``);
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: markdownLines.join("\n"),
      },
    };
  }

  const uniqueBindings = getUniqueAliasTableBindings(aliasBindings);
  if (uniqueBindings.length > 0) {
    const columnMatches: Array<{
      binding: AliasInfo;
      column: {
        name: string;
        type?: string;
        description?: string;
      };
    }> = [];

    for (const binding of uniqueBindings) {
      const database = binding.db || effectiveDatabase;
      if (!database) {
        continue;
      }

      const tableInfo = await metadataBridge.getTableInfo(
        document.uri,
        database,
        binding.table,
        binding.schema,
      );
      if (deps.isCancellationRequested()) {
        return null;
      }

      const matchedColumn = tableInfo?.columns.find(
        (column) => column.name.toUpperCase() === upperWord,
      );
      if (matchedColumn) {
        columnMatches.push({ binding, column: matchedColumn });
      }
    }

    if (columnMatches.length === 1) {
      const { binding, column: matchedColumn } = columnMatches[0];
      const database = binding.db || effectiveDatabase;
      if (!database) {
        return null;
      }

      const markdownLines = [`**column** \`${hoverWord}\``];
      if (matchedColumn.type) {
        markdownLines.push(`: \`${matchedColumn.type}\``);
      }
      const pathStr = deps.formatObjectPath(
        database,
        binding.schema,
        binding.table,
      );
      markdownLines.push(`→ \`${pathStr}\``);
      appendColumnDescriptionLine(markdownLines, matchedColumn.description);

      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: markdownLines.join("\n"),
        },
      };
    }
  }

  // Fallback: resolve as direct table reference (e.g. INSERT INTO, UPDATE, DELETE)
  // Extract the qualifier parts directly before the word to determine context
  const beforeDotMatch = beforeWordText.match(/([A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)*)\.\s*$/);
  const isBareWord = !beforeWordText.match(/\.\s*$/);
  const hasMultipleDotsBefore = beforeDotMatch && (beforeDotMatch[1].match(/\./g) || []).length >= 1;
  const isColumnRef = beforeDotMatch && aliasBindings.has(beforeDotMatch[1].toUpperCase());
  const qualifiesForTableLookup = isBareWord || (hasMultipleDotsBefore && !isColumnRef);
  if (effectiveDatabase && qualifiesForTableLookup) {
    let lookupDb = effectiveDatabase;
    let lookupSchema: string | undefined;
    if (hasMultipleDotsBefore && beforeDotMatch) {
      const qualifierParts = beforeDotMatch[1].split(".");
      if (qualifierParts.length >= 2) {
        lookupDb = qualifierParts[0];
        lookupSchema = qualifierParts[1];
      }
    }
    const tableInfo = await metadataBridge.getTableInfo(
      document.uri,
      lookupDb,
      hoverWord,
      lookupSchema,
    );
    if (deps.isCancellationRequested()) {
      return null;
    }
    if (tableInfo && tableInfo.columns.length > 0) {
      const markdownLines = [`**table** \`${hoverWord}\``];
      markdownLines.push(`\`${deps.formatObjectPath(effectiveDatabase, undefined, hoverWord)}\``);
      if (tableInfo.description) {
        markdownLines.push("", tableInfo.description);
      }
      if (tableInfo.columns.length) {
        markdownLines.push("", "---", "");
        const colLines = tableInfo.columns.map((column) => {
          let badge = "";
          if (column.isPk) badge += " \u25C6";
          if (column.isFk) badge += " \u25CB";
          const badgeStr = badge ? ` ${badge.trim()}` : "";
          let line = `- **${column.name}**`;
          if (column.type) line += ` : \`${column.type}\``;
          if (badgeStr) line += badgeStr;
          if (column.description) {
            const desc = column.description.length > 500
              ? column.description.substring(0, 500) + "\u2026"
              : column.description;
            line += ` — _${desc}_`;
          }
          return line;
        });
        markdownLines.push(colLines.join("\n"));
      }
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: markdownLines.join("\n"),
        },
      };
    }
  }

  return null;
}
