import { TextDocument } from "vscode-languageserver-textdocument";
import type { CodeAction, Diagnostic } from "vscode-languageserver/node";
import { buildLspQuickFixActions } from "../../server/handlers/signatureAndCodeActionHandlers";

function diagnosticFor(document: TextDocument, code: string, text: string): Diagnostic {
  const start = document.getText().indexOf(text);
  return {
    code,
    message: code,
    range: {
      start: document.positionAt(start),
      end: document.positionAt(start + text.length),
    },
  };
}

async function actionsFor(sql: string, code: string, text: string): Promise<CodeAction[]> {
  const document = TextDocument.create("file:///lsp-quick-fix.sql", "sql", 1, sql);
  const actions = await buildLspQuickFixActions({
    document,
    diagnostics: [diagnosticFor(document, code, text)],
    databaseKind: "netezza",
  });
  return (actions ?? []) as CodeAction[];
}

describe("buildLspQuickFixActions", () => {
  it("attaches safe, Fix All eligible policy to SQL012", async () => {
    const [action] = await actionsFor("CREATE TABLE t (name VARCHAR)", "SQL012", "VARCHAR");
    expect(action?.data).toEqual({ safety: "safe", fixAllEligible: true });
    expect(action?.isPreferred).toBe(true);
  });

  it("marks SQL019 unused-alias removal unsafe and not preferred", async () => {
    const [action] = await actionsFor("SELECT 1 FROM t x", "SQL019", "x");
    expect(action?.title).toBe("Remove unused alias");
    expect(action?.data).toEqual({ safety: "unsafe", fixAllEligible: false });
    expect(action?.isPreferred).toBe(false);
  });
});
