import {
  CompletionItem,
  CompletionItemKind,
  CompletionTriggerKind,
  InsertTextFormat,
  Position,
  Range,
} from "vscode-languageserver/node";
import { buildSqlSourceScanIndex } from "../sql/sqlSourceScan";

interface MacroVariableDeclaration {
  name: string;
  value: string;
}

type MacroReferenceMode = "ampersand" | "dollar" | "braced-dollar";

interface MacroReferenceContext {
  mode: MacroReferenceMode;
  replaceStartCharacter: number;
  prefix: string;
}

export function handleMacroVariableCompletion(params: {
  documentText: string;
  cursorOffset: number;
  linePrefix: string;
  position: Position;
  triggerKind?: CompletionTriggerKind;
}): CompletionItem[] | undefined {
  const referenceContext = getMacroReferenceContext(params.linePrefix);
  if (referenceContext) {
    if (
      referenceContext.mode === "braced-dollar" &&
      params.triggerKind === CompletionTriggerKind.TriggerCharacter
    ) {
      return undefined;
    }

    const declarations = collectMacroVariableDeclarationsBefore(
      params.documentText,
      params.cursorOffset,
    );

    if (declarations.length > 0) {
      const matchingDeclarations = declarations.filter((declaration) =>
        declaration.name.toUpperCase().startsWith(referenceContext.prefix.toUpperCase()),
      );

      if (matchingDeclarations.length === 0) {
        return [];
      }

      return matchingDeclarations.map((declaration) =>
        buildMacroReferenceCompletion(
          declaration,
          referenceContext,
          params.position,
        ),
      );
    }
  }

  const exportArgumentItems = buildMacroExportArgumentCompletions(params);
  if (exportArgumentItems !== undefined) {
    return exportArgumentItems;
  }

  const declarationItems = buildPercentMacroCompletions(
    params.linePrefix,
    params.position,
  );
  if (declarationItems) {
    return declarationItems;
  }

  const setItems = buildAtSetCompletions(params.linePrefix, params.position);
  if (setItems !== undefined) {
    return setItems;
  }

  if (!referenceContext) {
    return undefined;
  }

  return undefined;
}

function buildPercentMacroCompletions(
  linePrefix: string,
  position: Position,
): CompletionItem[] | undefined {
  const match = linePrefix.match(/%[A-Za-z_]*$/);
  if (!match || match.index === undefined) {
    return undefined;
  }

  const range = Range.create(
    position.line,
    match.index + 1,
    position.line,
    position.character,
  );

  const directivePrefix = match[0].slice(1).toLowerCase();
  const completions: CompletionItem[] = [{
    label: "%let variable = value;",
    kind: CompletionItemKind.Snippet,
    detail: "Inline SQL variable declaration",
    documentation:
      "Declares an execution-scoped SQL variable. The %let directive is stripped before execution.",
    insertTextFormat: InsertTextFormat.Snippet,
    textEdit: {
      range,
      newText: "let ${1:variable_name} = ${2:value};",
    },
    sortText: "0_%let",
  }, {
    label: "%if ... %then %do; ... %end;",
    kind: CompletionItemKind.Snippet,
    detail: "SAS-like conditional macro block",
    documentation:
      "Executes the block when the macro condition is true. The block must be closed with %END;.",
    insertTextFormat: InsertTextFormat.Snippet,
    textEdit: {
      range,
      newText: "if ${1:&flag = 1} %then %do;\n    ${2:SELECT 1;}\n%end;",
    },
    sortText: "0_%if",
  }, {
    label: "%else %do; ... %end;",
    kind: CompletionItemKind.Snippet,
    detail: "SAS-like ELSE macro block",
    documentation:
      "Adds the alternative branch to a preceding %IF block.",
    insertTextFormat: InsertTextFormat.Snippet,
    textEdit: {
      range,
      newText: "else %do;\n    ${1:SELECT 1;}\n%end;",
    },
    sortText: "0_%else",
  }, {
    label: "%end;",
    kind: CompletionItemKind.Snippet,
    detail: "Close SAS-like macro block",
    documentation: "Closes a %DO or conditional macro block.",
    insertTextFormat: InsertTextFormat.Snippet,
    textEdit: {
      range,
      newText: "end;",
    },
    sortText: "0_%end",
  }, {
    label: "%include 'path.sql';",
    kind: CompletionItemKind.Snippet,
    detail: "Include SQL macro file",
    documentation:
      "Includes a local SQL file using the current macro environment.",
    insertTextFormat: InsertTextFormat.Snippet,
    textEdit: {
      range,
      newText: "include '${1:path/to/file.sql}';",
    },
    sortText: "0_%include",
  }, {
    label: "%sql(SELECT ...)",
    kind: CompletionItemKind.Snippet,
    detail: "Inline scalar SQL macro",
    documentation:
      "Executes the inner query during preprocessing and substitutes the first row/first column value.",
    insertTextFormat: InsertTextFormat.Snippet,
    textEdit: {
      range,
      newText: "sql(SELECT ${1:expression} FROM ${2:table})",
    },
    sortText: "0_%sql",
  }, {
    label: "%sqllist(SELECT ...)",
    kind: CompletionItemKind.Snippet,
    detail: "Inline SQL list macro",
    documentation:
      "Executes the inner query during preprocessing and substitutes a comma-separated SQL literal list from the first column.",
    insertTextFormat: InsertTextFormat.Snippet,
    textEdit: {
      range,
      newText: "sqllist(SELECT ${1:column} FROM ${2:table})",
    },
    sortText: "0_%sqllist",
  }, {
    label: "%eval(expression)",
    kind: CompletionItemKind.Snippet,
    detail: "Evaluate a macro expression",
    documentation:
      "Evaluates a safe arithmetic or logical expression during preprocessing.",
    insertTextFormat: InsertTextFormat.Snippet,
    textEdit: {
      range,
      newText: "eval(${1:expression})",
    },
    sortText: "0_%eval",
  }, {
    label: "%python script.py [args...]",
    kind: CompletionItemKind.Snippet,
    detail: "Execute Python script macro",
    documentation:
      "Runs a Python script during preprocessing and substitutes stdout. Supports &variable resolution in script path and args.",
    insertTextFormat: InsertTextFormat.Snippet,
    textEdit: {
      range,
      newText: "python ${1:script.py} ${2:--arg1 --arg2}",
    },
    sortText: "0_%python",
  }, {
    label: "%do; ... %end;",
    kind: CompletionItemKind.Snippet,
    detail: "SAS-like %DO block",
    documentation:
      "Starts a %DO block that executes unconditionally. Must be closed with %END;.",
    insertTextFormat: InsertTextFormat.Snippet,
    textEdit: {
      range,
      newText: "do;\n    ${1:-- statements}\n%end;",
    },
    sortText: "0_%do",
  }, {
    label: "%export(format, file, query, update);",
    kind: CompletionItemKind.Snippet,
    detail: "Export SQL macro",
    documentation:
      "Executes the inner query during preprocessing and exports the result to XLSX or XLSB. Set update=true to replace a sheet in an existing workbook.",
    insertTextFormat: InsertTextFormat.Snippet,
    textEdit: {
      range,
      newText: "export(format='${1:xlsx}', file='${2:/tmp/results.xlsx}', sheet='${3:Query Results}', query=(\n  ${4:SELECT * FROM table}\n), overwrite=${5:false}, update=${6:false});",
    },
    sortText: "0_%export",
  }, {
    label: "%put message;",
    kind: CompletionItemKind.Snippet,
    detail: "Print message to output log",
    documentation:
      "Prints the resolved message to the output log during preprocessing. Supports &variable resolution.",
    insertTextFormat: InsertTextFormat.Snippet,
    textEdit: {
      range,
      newText: "put ${1:message};",
    },
    sortText: "0_%put",
  }];

  return completions.filter((item) => {
    if (directivePrefix.length === 0) {
      return true;
    }
    const directiveName = item.sortText?.replace(/^0_%/, "") ?? "";
    return directiveName.startsWith(directivePrefix);
  });
}

function buildAtSetCompletions(
  linePrefix: string,
  position: Position,
): CompletionItem[] | undefined {
  const match = linePrefix.match(/@[A-Za-z_]*/);
  if (!match || match.index === undefined || match.index + match[0].length !== linePrefix.length) {
    return undefined;
  }

  const range = Range.create(
    position.line,
    match.index + 1,
    position.line,
    position.character,
  );

  return [{
    label: "@SET variable = value;",
    kind: CompletionItemKind.Snippet,
    detail: "Inline SQL variable declaration",
    documentation:
      "Declares an execution-scoped SQL variable using the @SET alias.",
    insertTextFormat: InsertTextFormat.Snippet,
    textEdit: {
      range,
      newText: "SET ${1:variable_name} = ${2:value};",
    },
    sortText: "0_@set",
  }];
}

const EXPORT_ARGUMENTS = [
  {
    name: "format",
    label: "format='xlsx'",
    detail: "Output format: xlsx, xlsb, parquet, csv or xpt",
    newText: "format='${1:xlsx}'",
  },
  {
    name: "file",
    label: "file='/tmp/results.xlsx'",
    detail: "Output file path",
    newText: "file='${1:/tmp/results.xlsx}'",
  },
  {
    name: "sheet",
    label: "sheet='Query Results'",
    detail: "Target worksheet name",
    newText: "sheet='${1:Query Results}'",
  },
  {
    name: "query",
    label: "query=(SELECT ...)",
    detail: "SQL query whose result is exported",
    newText: "query=(\n  ${1:SELECT * FROM table}\n)",
  },
  {
    name: "overwrite",
    label: "overwrite=false",
    detail: "Allow replacing a newly exported file",
    newText: "overwrite=${1:false}",
  },
  {
    name: "update",
    label: "update=false",
    detail: "Replace a sheet in an existing XLSX/XLSB workbook",
    newText: "update=${1:false}",
  },
] as const;

function buildMacroExportArgumentCompletions(params: {
  documentText: string;
  cursorOffset: number;
  linePrefix: string;
  position: Position;
}): CompletionItem[] | undefined {
  const context = findOpenMacroExportContext(
    params.documentText,
    params.cursorOffset,
  );
  if (!context || context.depth !== 1) {
    return undefined;
  }

  const argumentText = params.documentText.slice(
    context.openParen + 1,
    params.cursorOffset,
  );
  const currentArgument = getCurrentTopLevelArgument(argumentText);
  const equalsIndex = findTopLevelEquals(currentArgument);
  if (equalsIndex !== -1) {
    const key = currentArgument.slice(0, equalsIndex).trim().toLowerCase();
    if (key === "format") {
      return buildMacroValueCompletions(
        params.linePrefix,
        params.position,
        ["xlsx", "xlsb", "parquet", "csv", "xpt"],
        "Export format",
      );
    }
    if (key === "overwrite" || key === "update") {
      return buildMacroValueCompletions(
        params.linePrefix,
        params.position,
        ["true", "false"],
        key === "update" ? "Update existing workbook" : "Allow overwrite",
      );
    }
    return [];
  }

  const keyMatch = params.linePrefix.match(/[A-Za-z_][A-Za-z0-9_]*$/);
  const keyPrefix = keyMatch?.[0] ?? "";
  const keyRange = Range.create(
    params.position.line,
    params.position.character - keyPrefix.length,
    params.position.line,
    params.position.character,
  );
  const usedKeys = new Set<string>();
  for (const segment of splitTopLevelArguments(argumentText)) {
    const segmentEqualsIndex = findTopLevelEquals(segment);
    if (segmentEqualsIndex !== -1) {
      usedKeys.add(segment.slice(0, segmentEqualsIndex).trim().toLowerCase());
    }
  }

  return EXPORT_ARGUMENTS
    .filter((argument) => !usedKeys.has(argument.name))
    .filter((argument) => argument.name.startsWith(keyPrefix.toLowerCase()))
    .map((argument) => ({
      label: argument.label,
      kind: CompletionItemKind.Property,
      detail: argument.detail,
      insertTextFormat: InsertTextFormat.Snippet,
      textEdit: {
        range: keyRange,
        newText: argument.newText,
      },
      filterText: argument.name,
      sortText: `0_%export.${argument.name}`,
    }));
}

function buildMacroValueCompletions(
  linePrefix: string,
  position: Position,
  values: readonly string[],
  detail: string,
): CompletionItem[] {
  const valueMatch = linePrefix.match(/(?:^|=)\s*(['"]?)([A-Za-z0-9_-]*)$/);
  const prefix = valueMatch?.[2] ?? "";
  const range = Range.create(
    position.line,
    position.character - prefix.length,
    position.line,
    position.character,
  );

  return values
    .filter((value) => value.startsWith(prefix.toLowerCase()))
    .map((value) => ({
      label: value,
      kind: CompletionItemKind.Value,
      detail,
      textEdit: {
        range,
        newText: value,
      },
      sortText: `0_${value}`,
    }));
}

function findOpenMacroExportContext(
  documentText: string,
  cursorOffset: number,
): { openParen: number; depth: number } | undefined {
  const scanIndex = buildSqlSourceScanIndex(documentText);
  const sanitizedPrefix = scanIndex.sanitized.slice(0, cursorOffset);
  const matches = Array.from(sanitizedPrefix.matchAll(/%export\s*\(/gi));

  for (let matchIndex = matches.length - 1; matchIndex >= 0; matchIndex--) {
    const match = matches[matchIndex];
    if (match.index === undefined) {
      continue;
    }

    const openParen = match.index + match[0].lastIndexOf("(");
    let depth = 0;
    let closed = false;
    for (let offset = openParen; offset < cursorOffset; offset++) {
      if (scanIndex.isInStringOrComment(offset)) {
        continue;
      }
      if (documentText[offset] === "(") {
        depth++;
      } else if (documentText[offset] === ")") {
        depth--;
        if (depth === 0) {
          closed = true;
          break;
        }
      }
    }

    if (!closed && depth > 0) {
      return { openParen, depth };
    }
  }

  return undefined;
}

function getCurrentTopLevelArgument(argumentText: string): string {
  const segments = splitTopLevelArguments(argumentText);
  return segments[segments.length - 1] ?? "";
}

function splitTopLevelArguments(text: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | undefined;

  for (let offset = 0; offset < text.length; offset++) {
    const char = text[offset];
    if (quote) {
      if (char === quote) {
        if (text[offset + 1] === quote) {
          offset++;
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth++;
    } else if (char === ")" && depth > 0) {
      depth--;
    } else if (char === "," && depth === 0) {
      segments.push(text.slice(start, offset));
      start = offset + 1;
    }
  }

  segments.push(text.slice(start));
  return segments;
}

function findTopLevelEquals(text: string): number {
  let depth = 0;
  let quote: "'" | '"' | undefined;

  for (let offset = 0; offset < text.length; offset++) {
    const char = text[offset];
    if (quote) {
      if (char === quote) {
        if (text[offset + 1] === quote) {
          offset++;
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "(") {
      depth++;
    } else if (char === ")" && depth > 0) {
      depth--;
    } else if (char === "=" && depth === 0) {
      return offset;
    }
  }

  return -1;
}

function getMacroReferenceContext(
  linePrefix: string,
): MacroReferenceContext | undefined {
  const bracedMatch = linePrefix.match(/\$\{\s*([A-Za-z_][A-Za-z0-9_]*)?$/);
  if (bracedMatch?.index !== undefined) {
    const prefix = bracedMatch[1] ?? "";
    return {
      mode: "braced-dollar",
      replaceStartCharacter: bracedMatch.index + bracedMatch[0].length - prefix.length,
      prefix,
    };
  }

  const ampersandMatch = linePrefix.match(/&([A-Za-z_][A-Za-z0-9_]*)?$/);
  if (ampersandMatch?.index !== undefined) {
    return {
      mode: "ampersand",
      replaceStartCharacter: ampersandMatch.index + 1,
      prefix: ampersandMatch[1] ?? "",
    };
  }

  const dollarMatch = linePrefix.match(/\$([A-Za-z_][A-Za-z0-9_]*)?$/);
  if (dollarMatch?.index !== undefined) {
    return {
      mode: "dollar",
      replaceStartCharacter: dollarMatch.index + 1,
      prefix: dollarMatch[1] ?? "",
    };
  }

  return undefined;
}

function buildMacroReferenceCompletion(
  declaration: MacroVariableDeclaration,
  context: MacroReferenceContext,
  position: Position,
): CompletionItem {
  const label = formatMacroReferenceLabel(declaration.name, context.mode);
  return {
    label,
    kind: CompletionItemKind.Variable,
    detail: "Inline SQL variable",
    documentation: declaration.value
      ? `%let ${declaration.name} = ${declaration.value};`
      : `%let ${declaration.name};`,
    textEdit: {
      range: Range.create(
        position.line,
        context.replaceStartCharacter,
        position.line,
        position.character,
      ),
      newText: context.mode === "braced-dollar"
        ? `${declaration.name}}`
        : declaration.name,
    },
    insertText: context.mode === "braced-dollar"
      ? `${declaration.name}}`
      : declaration.name,
    filterText: declaration.name,
    sortText: `0_${declaration.name.toUpperCase()}`,
  };
}

function formatMacroReferenceLabel(
  name: string,
  mode: MacroReferenceMode,
): string {
  switch (mode) {
    case "ampersand":
      return `&${name}`;
    case "braced-dollar":
      return `\${${name}}`;
    case "dollar":
      return `$${name}`;
  }
}

function collectMacroVariableDeclarationsBefore(
  documentText: string,
  cursorOffset: number,
): MacroVariableDeclaration[] {
  const declarations = new Map<string, MacroVariableDeclaration>();
  const beforeCursor = documentText.substring(0, cursorOffset);
  const declarationPattern = /^\s*(?:%let|@set)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)(?:;|$)/gim;

  for (const match of beforeCursor.matchAll(declarationPattern)) {
    const name = match[1];
    if (!name) {
      continue;
    }

    declarations.set(name.toUpperCase(), {
      name,
      value: (match[2] ?? "").trim(),
    });
  }

  return Array.from(declarations.values());
}
