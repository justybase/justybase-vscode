import * as vscode from "vscode";
import type { ConnectionManager } from "../core/connectionManager";
import { getDatabaseSqlAuthoring } from "../core/connectionFactory";

/**
 * Function signature information for SQL functions
 */
export class SqlSignatureHelpProvider implements vscode.SignatureHelpProvider {
  constructor(private readonly connectionManager?: ConnectionManager) {}

  public provideSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.SignatureHelpContext,
  ): vscode.ProviderResult<vscode.SignatureHelp> {
    const lineText = document.lineAt(position.line).text;
    const textBeforeCursor = lineText.substring(0, position.character);

    // Find function call context
    const functionCall = this.findFunctionCall(textBeforeCursor);
    if (!functionCall) {
      return undefined;
    }

    const { functionName, argumentPosition } = functionCall;
    const normalizedName = functionName.toUpperCase();

    const documentUri = document.uri?.toString?.();
    const databaseKind =
      this.connectionManager?.getExecutionDatabaseKind(documentUri);
    const signatures =
      getDatabaseSqlAuthoring(databaseKind).signatures.get(normalizedName);
    if (!signatures || signatures.length === 0) {
      return undefined;
    }

    // Create SignatureHelp
    const signatureHelp = new vscode.SignatureHelp();

    signatureHelp.signatures = signatures.map((sig) => {
      const signatureInfo = new vscode.SignatureInformation(
        `${sig.name}(${sig.parameters.join(", ")})`,
        new vscode.MarkdownString(sig.description),
      );

      signatureInfo.parameters = sig.parameters.map(
        (param) => new vscode.ParameterInformation(param),
      );

      return signatureInfo;
    });

    // Set active signature (first one by default)
    signatureHelp.activeSignature = 0;

    // Set active parameter based on cursor position
    signatureHelp.activeParameter = argumentPosition;

    return signatureHelp;
  }

  /**
   * Find function call context before cursor
   * Returns function name and current argument position
   */
  private findFunctionCall(
    textBeforeCursor: string,
  ): { functionName: string; argumentPosition: number } | undefined {
    // Match pattern: FUNCTION_NAME( with possible content
    // We need to find the innermost function call
    const functionPattern = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

    let lastMatch: { name: string; openParenIndex: number } | undefined;
    let match;

    while ((match = functionPattern.exec(textBeforeCursor)) !== null) {
      lastMatch = {
        name: match[1],
        openParenIndex: match.index + match[0].length - 1,
      };
    }

    if (!lastMatch) {
      return undefined;
    }

    // Check if cursor is inside this function call
    const afterOpenParen = textBeforeCursor.substring(
      lastMatch.openParenIndex + 1,
    );

    // Count parentheses to see if we're inside
    let depth = 1;
    let argumentPosition = 0;
    let inString = false;
    let stringChar = "";

    for (let i = 0; i < afterOpenParen.length; i++) {
      const char = afterOpenParen[i];

      // Handle string literals
      if (
        (char === "'" || char === '"') &&
        (i === 0 || afterOpenParen[i - 1] !== "\\")
      ) {
        if (!inString) {
          inString = true;
          stringChar = char;
        } else if (char === stringChar) {
          inString = false;
        }
        continue;
      }

      if (inString) {
        continue;
      }

      if (char === "(") {
        depth++;
      } else if (char === ")") {
        depth--;
        if (depth === 0) {
          // Function call closed, cursor is after it
          return undefined;
        }
      } else if (char === "," && depth === 1) {
        argumentPosition++;
      }
    }

    // If depth > 0, we're inside the function call
    if (depth > 0) {
      return {
        functionName: lastMatch.name,
        argumentPosition: argumentPosition,
      };
    }

    return undefined;
  }
}

export { SqlSignatureHelpProvider as NetezzaSignatureHelpProvider };
