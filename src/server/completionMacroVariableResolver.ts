import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
  Position,
  Range,
} from "vscode-languageserver/node";

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
}): CompletionItem[] | undefined {
  const declarationItems = buildPercentMacroCompletions(
    params.linePrefix,
    params.position,
  );
  if (declarationItems) {
    return declarationItems;
  }

  const referenceContext = getMacroReferenceContext(params.linePrefix);
  if (!referenceContext) {
    return undefined;
  }

  const declarations = collectMacroVariableDeclarationsBefore(
    params.documentText,
    params.cursorOffset,
  );

  if (declarations.length === 0) {
    return undefined;
  }

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

  return [{
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
    label: "%export(format, file, query);",
    kind: CompletionItemKind.Snippet,
    detail: "Export SQL macro",
    documentation:
      "Executes the inner query during preprocessing and exports the result to XLSX or XLSB.",
    insertTextFormat: InsertTextFormat.Snippet,
    textEdit: {
      range,
      newText: "export(format='${1:xlsx}', file='${2:/tmp/results.xlsx}', sheet='${3:Query Results}', query=(\n  ${4:SELECT * FROM table}\n), overwrite=${5:false});",
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
  const declarationPattern = /^\s*%let\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)(?:;|$)/gim;

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
