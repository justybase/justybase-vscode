import * as fs from "fs";
import * as path from "path";

import {
  EDIT_DATA_PANEL_INBOUND_COMMANDS,
  EDIT_DATA_PANEL_OUTBOUND_COMMANDS,
  IMPORT_WIZARD_INBOUND_TYPES,
  IMPORT_WIZARD_OUTBOUND_TYPES,
  LOGIN_PANEL_INBOUND_COMMANDS,
  LOGIN_PANEL_OUTBOUND_COMMANDS,
  RESULT_PANEL_INBOUND_COMMANDS,
  RESULT_PANEL_OUTBOUND_COMMANDS,
  SCHEMA_SEARCH_INBOUND_TYPES,
  SCHEMA_SEARCH_OUTBOUND_TYPES,
  SECURITY_PANEL_INBOUND_COMMANDS,
  SECURITY_PANEL_OUTBOUND_COMMANDS,
  SESSION_MONITOR_INBOUND_COMMANDS,
  SESSION_MONITOR_OUTBOUND_COMMANDS,
  VISUAL_QUERY_BUILDER_INBOUND_COMMANDS,
  VISUAL_QUERY_BUILDER_OUTBOUND_COMMANDS,
  TABLE_DESIGNER_INBOUND_COMMANDS,
  TABLE_DESIGNER_OUTBOUND_COMMANDS,
  EXPLAIN_PLAN_GRAPH_INBOUND_COMMANDS,
  TEST_DATA_GENERATOR_INBOUND_COMMANDS,
  FILE_SEARCH_INBOUND_TYPES,
  FILE_SEARCH_OUTBOUND_TYPES,
} from "../contracts/webview";
import {
  QUERY_HISTORY_INBOUND_TYPES,
  QUERY_HISTORY_OUTBOUND_TYPES,
} from "../contracts/webviews/queryHistoryContracts";

type MessagePropertyName = "command" | "type";

const RESULT_PANEL_FRONTEND_MESSAGE_FILES = [
  "media/resultPanel/export.ts",
  "media/resultPanel/formatting.ts",
  "media/resultPanel/grid.ts",
  "media/resultPanel/init.ts",
  "media/resultPanel/selection.ts",
  "media/resultPanel/tabs.ts",
  "media/resultPanel/utils.ts",
];

const RESULT_PANEL_GRID_PROTOCOL_FILES = [
  "media/resultPanel/grid/tableBuilder.ts",
  "media/resultPanel/grid/alternateViews.ts",
  "media/resultPanel/selection/clipboard.ts",
];

const RESULT_PANEL_FRONTEND_CONTRACT_FILES = [
  ...RESULT_PANEL_FRONTEND_MESSAGE_FILES.filter(
    (file) => file !== "media/resultPanel/grid.ts",
  ),
  ...RESULT_PANEL_GRID_PROTOCOL_FILES,
  "media/resultPanel/messages.ts",
];

const RESULT_PANEL_PROTOCOL_FILE = "media/resultPanel/protocol.ts";
const RESULT_PANEL_HOST_CONTRACTS_FILE = "media/resultPanel/hostContracts.ts";

const RESULT_PANEL_HOST_OUTBOUND_FILES = [
  "src/views/resultPanelView.ts",
  "src/views/resultPanelMessageHandler.ts",
  "src/state/resultStateManager.ts",
];

const QUERY_HISTORY_FRONTEND_FILES = [
  "media/queryHistory/panel.ts",
  "media/queryHistory/extended.ts",
];

const QUERY_HISTORY_HOST_CONTRACTS_FILE = "media/queryHistory/hostContracts.ts";

const IMPORT_WIZARD_FRONTEND_FILES = [
  "media/importWizard/panel.ts",
];

const IMPORT_WIZARD_HOST_CONTRACTS_FILE = "media/importWizard/hostContracts.ts";

const IMPORT_WIZARD_VIEW_FILE = "src/views/importWizardView.ts";

const IMPORT_WIZARD_HANDLER_FILE = "src/views/importWizardMessageHandler.ts";

const EDIT_DATA_PANEL_FRONTEND_FILES = [
  "media/editDataPanel/panel.ts",
];

const EDIT_DATA_PANEL_HOST_CONTRACTS_FILE = "media/editDataPanel/hostContracts.ts";

const EDIT_DATA_PANEL_PROVIDER_FILE = "src/views/editDataProvider.ts";

const SESSION_MONITOR_FRONTEND_FILES = [
  "media/sessionMonitor/panel.ts",
];

const SESSION_MONITOR_HOST_CONTRACTS_FILE = "media/sessionMonitor/hostContracts.ts";

const SECURITY_PANEL_FRONTEND_FILES = [
  "media/securityPanel/panel.ts",
];

const SECURITY_PANEL_HOST_CONTRACTS_FILE = "media/securityPanel/hostContracts.ts";

const SECURITY_PANEL_VIEW_FILE = "src/views/securityPanelView.ts";

const SCHEMA_SEARCH_GENERATOR_FILE = "src/views/schemaSearchHtmlGenerator.ts";

const SCHEMA_SEARCH_PROVIDER_FILE = "src/providers/schemaSearchProvider.ts";

const VISUAL_QUERY_BUILDER_FRONTEND_FILES = [
  "media/visualQueryBuilder/panel.ts",
];

const VISUAL_QUERY_BUILDER_HOST_CONTRACTS_FILE = "media/visualQueryBuilder/hostContracts.ts";

const VISUAL_QUERY_BUILDER_VIEW_FILE = "src/views/visualQueryBuilderView.ts";

const TABLE_DESIGNER_FRONTEND_FILES = [
  "media/tableDesigner/panel.ts",
];

const TABLE_DESIGNER_HOST_CONTRACTS_FILE = "media/tableDesigner/hostContracts.ts";

const TABLE_DESIGNER_VIEW_FILE = "src/views/tableDesignerView.ts";

const EXPLAIN_PLAN_GRAPH_FRONTEND_FILES = [
  "media/explainPlanGraph/panel.ts",
];

const EXPLAIN_PLAN_GRAPH_HOST_CONTRACTS_FILE = "media/explainPlanGraph/hostContracts.ts";

const EXPLAIN_PLAN_VIEW_FILE = "src/views/explainPlanView.ts";

const TEST_DATA_GENERATOR_FRONTEND_FILES = [
  "media/testDataGenerator/panel.ts",
];

const TEST_DATA_GENERATOR_HOST_CONTRACTS_FILE = "media/testDataGenerator/hostContracts.ts";

const TEST_DATA_GENERATOR_VIEW_FILE = "src/views/testDataGeneratorView.ts";

const FILE_SEARCH_PROVIDER_FILE = "src/providers/fileSearchProvider.ts";

const FILE_SEARCH_GENERATOR_FILE = "src/views/fileSearchHtmlGenerator.ts";

const LOGIN_PANEL_FILE = "src/views/loginPanel.ts";

function readWorkspaceFile(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}

function extractSection(
  source: string,
  startMarker: string,
  endMarker: string,
): string {
  const startIndex = source.indexOf(startMarker);
  expect(startIndex).toBeGreaterThanOrEqual(0);

  const endIndex = source.indexOf(endMarker, startIndex + startMarker.length);
  expect(endIndex).toBeGreaterThan(startIndex);

  return source.slice(startIndex, endIndex);
}

function extractCaseLabels(source: string): string[] {
  const regex = /case\s+["']([^"']+)["']/g;
  const matches: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(source)) !== null) {
    matches.push(match[1]);
  }

  return matches;
}

function extractObjectPropertyValues(
  source: string,
  propertyName: MessagePropertyName,
): string[] {
  const regex = new RegExp(
    `${propertyName}\\s*:\\s*(["'])((?:.(?!\\1))+.?)\\1`,
    "g",
  );
  const matches: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(source)) !== null) {
    matches.push(match[2]);
  }

  return matches;
}

function extractPostedPropertyValues(
  source: string,
  propertyName: MessagePropertyName,
): string[] {
  // Support direct vscode.postMessage plus wrapper helpers used to avoid
  // shadowing the native window.postMessage bridge in top-level webviews.
  const regex = new RegExp(
    `(?:(?:vscode\\.)?postMessage|postToHost|postHostMessage)\\(\\s*\\{[\\s\\S]{0,200}?${propertyName}\\s*:\\s*(["'])([^"']+)\\1`,
    "g",
  );
  const matches: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(source)) !== null) {
    const startIndex = match.index;
    const callSlice = source.slice(
      startIndex,
      Math.min(source.length, startIndex + 32),
    );
    if (
      callSlice.startsWith("postToHost(") ||
      callSlice.startsWith("postHostMessage(")
    ) {
      matches.push(match[2]);
      continue;
    }
    const prefixSlice = source.slice(Math.max(0, startIndex - 20), startIndex);
    const prefixMatch = prefixSlice.match(/([a-zA-Z0-9_]+)\.$/);
    if (prefixMatch && prefixMatch[1] !== "vscode") {
      continue;
    }
    matches.push(match[2]);
  }

  return matches;
}

function extractMethodPostedPropertyValues(
  source: string,
  methodCallPrefix: string,
  propertyName: MessagePropertyName,
): string[] {
  const regex = new RegExp(
    `${methodCallPrefix}\\(\\s*\\{[\\s\\S]{0,200}?${propertyName}\\s*:\\s*(["'])([^"']+)\\1`,
    "g",
  );
  const matches: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(source)) !== null) {
    matches.push(match[2]);
  }

  return matches;
}

function extractFromFiles(
  relativePaths: string[],
  extractor: (source: string) => string[],
): string[] {
  return relativePaths.flatMap((relativePath) =>
    extractor(readWorkspaceFile(relativePath)),
  );
}

function expectSetEqual(actual: string[], expected: readonly string[]): void {
  expect(uniqueSorted(actual)).toEqual(uniqueSorted(expected));
}

function expectSubset(actual: string[], expected: readonly string[]): void {
  const expectedSet = new Set(expected);
  const unexpected = uniqueSorted(actual).filter(
    (value) => !expectedSet.has(value),
  );
  expect(unexpected).toEqual([]);
}

function extractUnionMessageTypeLiterals(
  source: string,
  exportTypeName: string,
): string[] {
  const marker = `export type ${exportTypeName}`;
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);

  const nextExport = source.indexOf("\nexport ", start + marker.length);
  const chunk =
    nextExport === -1
      ? source.slice(start)
      : source.slice(start, nextExport);

  const regex = /\|\s*\{\s*type:\s*['"]([^'"]+)['"]/g;
  const matches: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(chunk)) !== null) {
    matches.push(match[1]);
  }

  return matches;
}

function extractUnionMessageCommandLiterals(
  source: string,
  exportTypeName: string,
): string[] {
  const marker = `export type ${exportTypeName}`;
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);

  const nextExport = source.indexOf("\nexport ", start + marker.length);
  const chunk =
    nextExport === -1
      ? source.slice(start)
      : source.slice(start, nextExport);

  const regex = /\|\s*\{\s*command:\s*['"]([^'"]+)['"]/g;
  const matches: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(chunk)) !== null) {
    matches.push(match[1]);
  }

  return matches;
}

function extractRecoveryActionPostedTypes(source: string): string[] {
  const startMatch = source.match(/function dispatchRecoveryAction\([^)]*\)(?:\s*:\s*[\w|]+)?\s*\{/);
  expect(startMatch?.index).toBeGreaterThanOrEqual(0);

  const startIndex = startMatch!.index!;
  const endIndex = source.indexOf("\nfunction init", startIndex);
  expect(endIndex).toBeGreaterThan(startIndex);

  const recoverySection = source.slice(startIndex, endIndex);
  return extractPostedPropertyValues(recoverySection, "type");
}

describe("Webview contract sync", () => {
  it("keeps Result Panel inbound commands aligned with the host handler and frontend senders", () => {
    const hostHandledCommands = extractCaseLabels(
      readWorkspaceFile("src/views/resultPanelMessageHandler.ts"),
    );
    const frontendPostedCommands = extractFromFiles(
      RESULT_PANEL_FRONTEND_MESSAGE_FILES,
      (source) => extractPostedPropertyValues(source, "command"),
    );

    expectSetEqual(hostHandledCommands, RESULT_PANEL_INBOUND_COMMANDS);
    expectSubset(frontendPostedCommands, RESULT_PANEL_INBOUND_COMMANDS);
  });

  it("keeps Result Panel outbound commands aligned with host senders and frontend handlers", () => {
    const hostSentCommands = extractFromFiles(
      RESULT_PANEL_HOST_OUTBOUND_FILES,
      (source) => extractObjectPropertyValues(source, "command"),
    );
    const frontendHandledCommands = extractCaseLabels(
      readWorkspaceFile("media/resultPanel/messages.ts"),
    );

    expectSetEqual(hostSentCommands, RESULT_PANEL_OUTBOUND_COMMANDS);
    expectSetEqual(frontendHandledCommands, RESULT_PANEL_OUTBOUND_COMMANDS);
  });

  it("keeps Result Panel frontend files bound to the shared protocol helper and contracts", () => {
    const protocolSource = readWorkspaceFile(RESULT_PANEL_PROTOCOL_FILE);
    const hostContractsSource = readWorkspaceFile(
      RESULT_PANEL_HOST_CONTRACTS_FILE,
    );

    expect(protocolSource).toContain("ResultPanelHostToWebviewMessage");
    expect(protocolSource).toContain("ResultPanelWebviewToHostMessage");
    expect(protocolSource).toContain("./hostContracts.js");
    expect(hostContractsSource).toContain("ResultPanelHostToWebviewMessage");
    expect(hostContractsSource).toContain("ResultPanelWebviewToHostMessage");

    RESULT_PANEL_FRONTEND_CONTRACT_FILES.map(readWorkspaceFile).forEach(
      (source) => {
        expect(source).toContain("./protocol.js");
      },
    );
  });

  it("keeps Query History inbound message types aligned with the host handler and frontend senders", () => {
    const hostHandledTypes = extractCaseLabels(
      readWorkspaceFile("src/views/queryHistoryView.ts"),
    );
    const frontendPostedTypes = extractFromFiles(
      QUERY_HISTORY_FRONTEND_FILES,
      (source) => extractPostedPropertyValues(source, "type"),
    );

    expectSetEqual(hostHandledTypes, QUERY_HISTORY_INBOUND_TYPES);
    expectSubset(frontendPostedTypes, QUERY_HISTORY_INBOUND_TYPES);
  });

  it("keeps Query History outbound message types aligned with host senders and frontend handlers", () => {
    const hostSentTypes = extractObjectPropertyValues(
      readWorkspaceFile("src/views/queryHistoryView.ts"),
      "type",
    );
    const frontendHandledTypes = extractFromFiles(
      QUERY_HISTORY_FRONTEND_FILES,
      extractCaseLabels,
    );

    expectSubset(hostSentTypes, QUERY_HISTORY_OUTBOUND_TYPES);
    expectSubset(frontendHandledTypes, QUERY_HISTORY_OUTBOUND_TYPES);
  });

  it("keeps Query History frontend files bound to the shared JSDoc contracts", () => {
    const frontendSources = QUERY_HISTORY_FRONTEND_FILES.map(readWorkspaceFile);

    frontendSources.forEach((source) => {
      expect(source).toContain("QueryHistoryHostToWebviewMessage");
      expect(source).toContain("QueryHistoryWebviewToHostMessage");
      expect(source).toContain("./hostContracts.js");
    });
  });

  it("keeps Query History webview hostContracts aligned with shared contracts", () => {
    const hostContractsSource = readWorkspaceFile(
      QUERY_HISTORY_HOST_CONTRACTS_FILE,
    );

    expectSetEqual(
      extractUnionMessageTypeLiterals(
        hostContractsSource,
        "QueryHistoryWebviewToHostMessage",
      ),
      QUERY_HISTORY_INBOUND_TYPES,
    );
    expectSetEqual(
      extractUnionMessageTypeLiterals(
        hostContractsSource,
        "QueryHistoryHostToWebviewMessage",
      ),
      QUERY_HISTORY_OUTBOUND_TYPES,
    );
  });

  it("keeps Query History recovery actions distinct across both webviews", () => {
    const expectedRecoveryTypes = ["getHistory", "getSavedViews", "refresh"];

    QUERY_HISTORY_FRONTEND_FILES.map(readWorkspaceFile).forEach((source) => {
      expectSetEqual(
        extractRecoveryActionPostedTypes(source),
        expectedRecoveryTypes,
      );
    });
  });

  it("keeps Import Wizard message types aligned across the host and webview", () => {
    const hostHandledTypes = extractCaseLabels(
      readWorkspaceFile(IMPORT_WIZARD_HANDLER_FILE),
    );
    const hostSentTypes = extractObjectPropertyValues(
      readWorkspaceFile(IMPORT_WIZARD_HANDLER_FILE),
      "type",
    );
    const frontendPostedTypes = extractFromFiles(
      IMPORT_WIZARD_FRONTEND_FILES,
      (source) => extractPostedPropertyValues(source, "type"),
    );
    const frontendHandledTypes = extractFromFiles(
      IMPORT_WIZARD_FRONTEND_FILES,
      extractCaseLabels,
    );

    expectSetEqual(hostHandledTypes, IMPORT_WIZARD_INBOUND_TYPES);
    expectSubset(frontendPostedTypes, IMPORT_WIZARD_INBOUND_TYPES);
    expectSetEqual(hostSentTypes, IMPORT_WIZARD_OUTBOUND_TYPES);
    expectSetEqual(frontendHandledTypes, IMPORT_WIZARD_OUTBOUND_TYPES);
  });

  it("keeps Import Wizard frontend and host bound to the shared contracts", () => {
    const frontendSources = IMPORT_WIZARD_FRONTEND_FILES.map(readWorkspaceFile);
    const hostViewSource = readWorkspaceFile(IMPORT_WIZARD_VIEW_FILE);
    const hostHandlerSource = readWorkspaceFile(IMPORT_WIZARD_HANDLER_FILE);

    frontendSources.forEach((source) => {
      expect(source).toContain("ImportWizardHostToWebviewMessage");
      expect(source).toContain("ImportWizardWebviewToHostMessage");
      expect(source).toContain("./hostContracts.js");
    });
    expect(hostViewSource).toContain("../contracts/webviews");
    expect(hostHandlerSource).toContain("../contracts/webviews");
  });

  it("keeps Import Wizard webview hostContracts aligned with shared contracts", () => {
    const hostContractsSource = readWorkspaceFile(
      IMPORT_WIZARD_HOST_CONTRACTS_FILE,
    );

    expectSetEqual(
      extractUnionMessageTypeLiterals(
        hostContractsSource,
        "ImportWizardWebviewToHostMessage",
      ),
      IMPORT_WIZARD_INBOUND_TYPES,
    );
    expectSetEqual(
      extractUnionMessageTypeLiterals(
        hostContractsSource,
        "ImportWizardHostToWebviewMessage",
      ),
      IMPORT_WIZARD_OUTBOUND_TYPES,
    );
  });

  it("keeps Edit Data Panel commands aligned across the host and webview", () => {
    const hostHandledCommands = extractCaseLabels(
      readWorkspaceFile(EDIT_DATA_PANEL_PROVIDER_FILE),
    );
    const hostSentCommands = extractObjectPropertyValues(
      readWorkspaceFile(EDIT_DATA_PANEL_PROVIDER_FILE),
      "command",
    );
    const frontendPostedCommands = extractFromFiles(
      EDIT_DATA_PANEL_FRONTEND_FILES,
      (source) => extractPostedPropertyValues(source, "command"),
    );
    const frontendHandledCommands = extractFromFiles(
      EDIT_DATA_PANEL_FRONTEND_FILES,
      extractCaseLabels,
    );

    expectSetEqual(hostHandledCommands, EDIT_DATA_PANEL_INBOUND_COMMANDS);
    expectSubset(frontendPostedCommands, EDIT_DATA_PANEL_INBOUND_COMMANDS);
    expectSetEqual(hostSentCommands, EDIT_DATA_PANEL_OUTBOUND_COMMANDS);
    expectSetEqual(frontendHandledCommands, EDIT_DATA_PANEL_OUTBOUND_COMMANDS);
  });

  it("keeps Edit Data Panel frontend and host bound to the shared contracts", () => {
    const frontendSources = EDIT_DATA_PANEL_FRONTEND_FILES.map(readWorkspaceFile);
    const hostSource = readWorkspaceFile(EDIT_DATA_PANEL_PROVIDER_FILE);

    frontendSources.forEach((source) => {
      expect(source).toContain("EditDataPanelHostToWebviewMessage");
      expect(source).toContain("EditDataPanelWebviewToHostMessage");
      expect(source).toContain("./hostContracts.js");
    });
    expect(hostSource).toContain("../contracts/webviews");
  });

  it("keeps Edit Data Panel webview hostContracts aligned with shared contracts", () => {
    const hostContractsSource = readWorkspaceFile(
      EDIT_DATA_PANEL_HOST_CONTRACTS_FILE,
    );

    expectSetEqual(
      extractUnionMessageCommandLiterals(
        hostContractsSource,
        "EditDataPanelWebviewToHostMessage",
      ),
      EDIT_DATA_PANEL_INBOUND_COMMANDS,
    );
    expectSetEqual(
      extractUnionMessageCommandLiterals(
        hostContractsSource,
        "EditDataPanelHostToWebviewMessage",
      ),
      EDIT_DATA_PANEL_OUTBOUND_COMMANDS,
    );
  });

  it("keeps Security Panel commands aligned across the host and webview", () => {
    const hostHandledCommands = extractCaseLabels(
      readWorkspaceFile(SECURITY_PANEL_VIEW_FILE),
    );
    const hostSentCommands = extractObjectPropertyValues(
      readWorkspaceFile(SECURITY_PANEL_VIEW_FILE),
      "command",
    );
    const frontendPostedCommands = extractFromFiles(
      SECURITY_PANEL_FRONTEND_FILES,
      (source) => extractPostedPropertyValues(source, "command"),
    );
    const frontendHandledCommands = extractFromFiles(
      SECURITY_PANEL_FRONTEND_FILES,
      extractCaseLabels,
    );

    expectSetEqual(hostHandledCommands, SECURITY_PANEL_INBOUND_COMMANDS);
    expectSetEqual(frontendPostedCommands, SECURITY_PANEL_INBOUND_COMMANDS);
    expectSetEqual(hostSentCommands, SECURITY_PANEL_OUTBOUND_COMMANDS);
    expectSetEqual(frontendHandledCommands, SECURITY_PANEL_OUTBOUND_COMMANDS);
  });

  it("keeps Security Panel frontend and host bound to the shared contracts", () => {
    const frontendSources = SECURITY_PANEL_FRONTEND_FILES.map(readWorkspaceFile);
    const hostSource = readWorkspaceFile(SECURITY_PANEL_VIEW_FILE);

    frontendSources.forEach((source) => {
      expect(source).toContain("SecurityPanelHostToWebviewMessage");
      expect(source).toContain("SecurityPanelWebviewToHostMessage");
      expect(source).toContain("./hostContracts.js");
    });
    expect(hostSource).toContain("../contracts/webviews");
  });

  it("keeps Security Panel webview hostContracts aligned with shared contracts", () => {
    const hostContractsSource = readWorkspaceFile(
      SECURITY_PANEL_HOST_CONTRACTS_FILE,
    );

    expectSetEqual(
      extractUnionMessageCommandLiterals(
        hostContractsSource,
        "SecurityPanelWebviewToHostMessage",
      ),
      SECURITY_PANEL_INBOUND_COMMANDS,
    );
    expectSetEqual(
      extractUnionMessageCommandLiterals(
        hostContractsSource,
        "SecurityPanelHostToWebviewMessage",
      ),
      SECURITY_PANEL_OUTBOUND_COMMANDS,
    );
  });

  it("keeps Session Monitor commands aligned across the host and webview", () => {
    const hostHandledCommands = extractCaseLabels(
      readWorkspaceFile("src/views/sessionMonitorView.ts"),
    );
    const hostSentCommands = extractObjectPropertyValues(
      readWorkspaceFile("src/views/sessionMonitorView.ts"),
      "command",
    );
    const frontendPostedCommands = extractFromFiles(
      SESSION_MONITOR_FRONTEND_FILES,
      (source) => extractPostedPropertyValues(source, "command"),
    );
    const frontendHandledCommands = extractFromFiles(
      SESSION_MONITOR_FRONTEND_FILES,
      extractCaseLabels,
    );

    expectSetEqual(hostHandledCommands, SESSION_MONITOR_INBOUND_COMMANDS);
    expectSetEqual(frontendPostedCommands, SESSION_MONITOR_INBOUND_COMMANDS);
    expectSetEqual(hostSentCommands, SESSION_MONITOR_OUTBOUND_COMMANDS);
    expectSetEqual(frontendHandledCommands, SESSION_MONITOR_OUTBOUND_COMMANDS);
  });

  it("keeps Session Monitor frontend bound to the shared contracts", () => {
    const frontendSources = SESSION_MONITOR_FRONTEND_FILES.map(readWorkspaceFile);

    frontendSources.forEach((source) => {
      expect(source).toContain("SessionMonitorHostToWebviewMessage");
      expect(source).toContain("SessionMonitorWebviewToHostMessage");
      expect(source).toContain("./hostContracts.js");
    });
  });

  it("keeps Session Monitor webview hostContracts aligned with shared contracts", () => {
    const hostContractsSource = readWorkspaceFile(
      SESSION_MONITOR_HOST_CONTRACTS_FILE,
    );

    expectSetEqual(
      extractUnionMessageCommandLiterals(
        hostContractsSource,
        "SessionMonitorWebviewToHostMessage",
      ),
      SESSION_MONITOR_INBOUND_COMMANDS,
    );
    expectSetEqual(
      extractUnionMessageCommandLiterals(
        hostContractsSource,
        "SessionMonitorHostToWebviewMessage",
      ),
      SESSION_MONITOR_OUTBOUND_COMMANDS,
    );
  });

  it("keeps Visual Query Builder commands aligned across the host and webview", () => {
    const hostHandledCommands = extractCaseLabels(
      readWorkspaceFile(VISUAL_QUERY_BUILDER_VIEW_FILE),
    );
    const hostSentCommands = extractObjectPropertyValues(
      readWorkspaceFile(VISUAL_QUERY_BUILDER_VIEW_FILE),
      "command",
    );
    const frontendPostedCommands = extractFromFiles(
      VISUAL_QUERY_BUILDER_FRONTEND_FILES,
      (source) => extractPostedPropertyValues(source, "command"),
    );
    const frontendHandledCommands = extractFromFiles(
      VISUAL_QUERY_BUILDER_FRONTEND_FILES,
      extractCaseLabels,
    );

    expectSetEqual(hostHandledCommands, VISUAL_QUERY_BUILDER_INBOUND_COMMANDS);
    expectSetEqual(
      frontendPostedCommands,
      VISUAL_QUERY_BUILDER_INBOUND_COMMANDS,
    );
    expectSetEqual(hostSentCommands, VISUAL_QUERY_BUILDER_OUTBOUND_COMMANDS);
    expectSetEqual(
      frontendHandledCommands,
      VISUAL_QUERY_BUILDER_OUTBOUND_COMMANDS,
    );
  });

  it("keeps Visual Query Builder frontend bound to the shared contracts", () => {
    const frontendSources = VISUAL_QUERY_BUILDER_FRONTEND_FILES.map(readWorkspaceFile);

    frontendSources.forEach((source) => {
      expect(source).toContain("VisualQueryBuilderHostToWebviewMessage");
      expect(source).toContain("VisualQueryBuilderWebviewToHostMessage");
      expect(source).toContain("./hostContracts.js");
    });
  });

  it("keeps Visual Query Builder webview hostContracts aligned with shared contracts", () => {
    const hostContractsSource = readWorkspaceFile(
      VISUAL_QUERY_BUILDER_HOST_CONTRACTS_FILE,
    );

    expectSetEqual(
      extractUnionMessageCommandLiterals(
        hostContractsSource,
        "VisualQueryBuilderWebviewToHostMessage",
      ),
      VISUAL_QUERY_BUILDER_INBOUND_COMMANDS,
    );
    expectSetEqual(
      extractUnionMessageCommandLiterals(
        hostContractsSource,
        "VisualQueryBuilderHostToWebviewMessage",
      ),
      VISUAL_QUERY_BUILDER_OUTBOUND_COMMANDS,
    );
  });

  it("keeps Table Designer commands aligned across the host and webview", () => {
    const hostHandlerSource = extractSection(
      readWorkspaceFile(TABLE_DESIGNER_VIEW_FILE),
      "this.panel.webview.onDidReceiveMessage(",
      "private update()",
    );
    const hostHandledCommands = extractCaseLabels(hostHandlerSource);
    const hostSentCommands = extractObjectPropertyValues(
      readWorkspaceFile(TABLE_DESIGNER_VIEW_FILE),
      "command",
    );
    const frontendPostedCommands = extractFromFiles(
      TABLE_DESIGNER_FRONTEND_FILES,
      (source) => extractPostedPropertyValues(source, "command"),
    );
    const frontendHandledCommands = extractFromFiles(
      TABLE_DESIGNER_FRONTEND_FILES,
      extractCaseLabels,
    );

    expectSetEqual(hostHandledCommands, TABLE_DESIGNER_INBOUND_COMMANDS);
    expectSubset(frontendPostedCommands, TABLE_DESIGNER_INBOUND_COMMANDS);
    expectSetEqual(hostSentCommands, TABLE_DESIGNER_OUTBOUND_COMMANDS);
    expectSetEqual(frontendHandledCommands, TABLE_DESIGNER_OUTBOUND_COMMANDS);
  });

  it("keeps Table Designer frontend and host bound to the shared contracts", () => {
    TABLE_DESIGNER_FRONTEND_FILES.map(readWorkspaceFile).forEach((source) => {
      expect(source).toContain("TableDesignerHostToWebviewMessage");
      expect(source).toContain("TableDesignerWebviewToHostMessage");
      expect(source).toContain("./hostContracts.js");
    });
    expect(readWorkspaceFile(TABLE_DESIGNER_VIEW_FILE)).toContain(
      "../contracts/webviews/tableDesignerContracts",
    );
  });

  it("keeps Table Designer webview hostContracts aligned with shared contracts", () => {
    const hostContractsSource = readWorkspaceFile(
      TABLE_DESIGNER_HOST_CONTRACTS_FILE,
    );

    expectSetEqual(
      extractUnionMessageCommandLiterals(
        hostContractsSource,
        "TableDesignerWebviewToHostMessage",
      ),
      TABLE_DESIGNER_INBOUND_COMMANDS,
    );
    expectSetEqual(
      extractUnionMessageCommandLiterals(
        hostContractsSource,
        "TableDesignerHostToWebviewMessage",
      ),
      TABLE_DESIGNER_OUTBOUND_COMMANDS,
    );
  });

  it("keeps Explain Plan Graph commands aligned across the host and webview", () => {
    const hostHandlerSource = extractSection(
      readWorkspaceFile(EXPLAIN_PLAN_VIEW_FILE),
      "this._panel.webview.onDidReceiveMessage(",
      "public static createOrShow",
    );
    const hostHandledCommands = extractCaseLabels(hostHandlerSource);
    const frontendPostedCommands = extractFromFiles(
      EXPLAIN_PLAN_GRAPH_FRONTEND_FILES,
      (source) => extractPostedPropertyValues(source, "command"),
    );

    expectSetEqual(hostHandledCommands, EXPLAIN_PLAN_GRAPH_INBOUND_COMMANDS);
    expectSetEqual(frontendPostedCommands, EXPLAIN_PLAN_GRAPH_INBOUND_COMMANDS);
  });

  it("keeps Explain Plan Graph frontend and host bound to the shared contracts", () => {
    EXPLAIN_PLAN_GRAPH_FRONTEND_FILES.map(readWorkspaceFile).forEach((source) => {
      expect(source).toContain("ExplainPlanGraphWebviewToHostMessage");
      expect(source).toContain("./hostContracts.js");
    });
    expect(readWorkspaceFile(EXPLAIN_PLAN_VIEW_FILE)).toContain(
      "../contracts/webviews/explainPlanGraphContracts",
    );
  });

  it("keeps Explain Plan Graph webview hostContracts aligned with shared contracts", () => {
    const hostContractsSource = readWorkspaceFile(
      EXPLAIN_PLAN_GRAPH_HOST_CONTRACTS_FILE,
    );

    expectSetEqual(
      extractUnionMessageCommandLiterals(
        hostContractsSource,
        "ExplainPlanGraphWebviewToHostMessage",
      ),
      EXPLAIN_PLAN_GRAPH_INBOUND_COMMANDS,
    );
  });

  it("keeps Test Data Generator commands aligned across the host and webview", () => {
    const hostHandlerSource = extractSection(
      readWorkspaceFile(TEST_DATA_GENERATOR_VIEW_FILE),
      "this._panel.webview.onDidReceiveMessage(",
      "private async _handleGenerateData",
    );
    const hostHandledCommands = extractCaseLabels(hostHandlerSource);
    const frontendPostedCommands = extractFromFiles(
      TEST_DATA_GENERATOR_FRONTEND_FILES,
      (source) => extractPostedPropertyValues(source, "command"),
    );

    expectSetEqual(hostHandledCommands, TEST_DATA_GENERATOR_INBOUND_COMMANDS);
    expectSubset(frontendPostedCommands, TEST_DATA_GENERATOR_INBOUND_COMMANDS);
  });

  it("keeps Test Data Generator frontend and host bound to the shared contracts", () => {
    TEST_DATA_GENERATOR_FRONTEND_FILES.map(readWorkspaceFile).forEach((source) => {
      expect(source).toContain("TestDataGeneratorWebviewToHostMessage");
      expect(source).toContain("./hostContracts.js");
    });
    expect(readWorkspaceFile(TEST_DATA_GENERATOR_VIEW_FILE)).toContain(
      "../contracts/webviews/testDataGeneratorContracts",
    );
  });

  it("keeps Test Data Generator webview hostContracts aligned with shared contracts", () => {
    const hostContractsSource = readWorkspaceFile(
      TEST_DATA_GENERATOR_HOST_CONTRACTS_FILE,
    );

    expectSetEqual(
      extractUnionMessageCommandLiterals(
        hostContractsSource,
        "TestDataGeneratorWebviewToHostMessage",
      ),
      TEST_DATA_GENERATOR_INBOUND_COMMANDS,
    );
  });

  it("keeps File Search message types aligned across the provider and embedded webview script", () => {
    const generatorSource = readWorkspaceFile(FILE_SEARCH_GENERATOR_FILE);
    const providerSource = readWorkspaceFile(FILE_SEARCH_PROVIDER_FILE);
    const fileSearchScriptSource = extractSection(
      generatorSource,
      "var vscode = acquireVsCodeApi();",
      "    </script>",
    );

    const hostHandledTypes = extractCaseLabels(providerSource);
    const hostSentTypes = extractMethodPostedPropertyValues(
      providerSource,
      "this\\.postMessage",
      "type",
    );
    const frontendPostedTypes = extractPostedPropertyValues(
      fileSearchScriptSource,
      "type",
    );
    const frontendHandledTypes = extractCaseLabels(fileSearchScriptSource);

    expectSetEqual(hostHandledTypes, FILE_SEARCH_INBOUND_TYPES);
    expectSubset(frontendPostedTypes, FILE_SEARCH_INBOUND_TYPES);
    expectSetEqual(hostSentTypes, FILE_SEARCH_OUTBOUND_TYPES);
    expectSetEqual(frontendHandledTypes, FILE_SEARCH_OUTBOUND_TYPES);
  });

  it("keeps File Search provider bound to the shared contracts", () => {
    const providerSource = readWorkspaceFile(FILE_SEARCH_PROVIDER_FILE);

    expect(providerSource).toContain("FileSearchInboundMessage");
    expect(providerSource).toContain("FileSearchOutboundMessage");
    expect(providerSource).toContain("../contracts/webviews/fileSearchContracts");
  });

  it("avoids shadowing window.postMessage in top-level webview frontends", () => {
    const migratedProtocolFiles = [
      "media/editDataPanel/protocol.ts",
      "media/sessionMonitor/protocol.ts",
      "media/securityPanel/protocol.ts",
      "media/importWizard/protocol.ts",
      "media/visualQueryBuilder/protocol.ts",
      "media/tableDesigner/protocol.ts",
      "media/explainPlanGraph/protocol.ts",
      "media/testDataGenerator/protocol.ts",
    ];
    const legacyFrontendFiles: string[] = [];

    [...migratedProtocolFiles, ...legacyFrontendFiles].forEach((relativePath) => {
      const source = readWorkspaceFile(relativePath);

      expect(source).toContain("function postToHost(message");
      expect(source).not.toContain("function postMessage(message)");
    });
  });

  it("keeps Schema Search message types aligned across the provider and embedded webview script", () => {
    const generatorSource = readWorkspaceFile(SCHEMA_SEARCH_GENERATOR_FILE);
    const providerSource = readWorkspaceFile(SCHEMA_SEARCH_PROVIDER_FILE);
    const schemaSearchScriptSource = extractSection(
      generatorSource,
      "const vscode = acquireVsCodeApi();",
      "            } catch (err) {",
    );

    const hostHandledTypes = extractCaseLabels(providerSource);
    const hostSentTypes = extractMethodPostedPropertyValues(
      providerSource,
      "this\\.postMessage",
      "type",
    );
    const frontendPostedTypes = [
      ...extractPostedPropertyValues(schemaSearchScriptSource, "type"),
      ...extractMethodPostedPropertyValues(
        schemaSearchScriptSource,
        "postToHost",
        "type",
      ),
    ];
    const frontendHandledTypes = extractCaseLabels(schemaSearchScriptSource);

    expectSetEqual(hostHandledTypes, SCHEMA_SEARCH_INBOUND_TYPES);
    expectSetEqual(frontendPostedTypes, SCHEMA_SEARCH_INBOUND_TYPES);
    expectSetEqual(hostSentTypes, SCHEMA_SEARCH_OUTBOUND_TYPES);
    expectSetEqual(frontendHandledTypes, SCHEMA_SEARCH_OUTBOUND_TYPES);
  });

  it("keeps Schema Search inline script bound to the shared contract references", () => {
    const generatorSource = readWorkspaceFile(SCHEMA_SEARCH_GENERATOR_FILE);

    expect(generatorSource).toContain("SchemaSearchHostToWebviewMessage");
    expect(generatorSource).toContain("SchemaSearchWebviewToHostMessage");
    expect(generatorSource).toContain(
      "../src/contracts/webviews/schemaSearchContracts",
    );
  });

  it("keeps Login Panel commands aligned across the host and embedded webview script", () => {
    const loginSource = readWorkspaceFile(LOGIN_PANEL_FILE);
    const loginHostSource = extractSection(
      loginSource,
      "export class LoginPanel {",
      "private _getHtmlForWebview(",
    );
    const loginHostHandlerSource = extractSection(
      loginSource,
      "this._panel.webview.onDidReceiveMessage(",
      "this._disposables.push(this.connectionManager.onDidChangeConnections(() => {",
    );
    const loginScriptSource = extractSection(
      loginSource,
      "window.addEventListener('message', event => {",
      "</script>",
    );

    const hostHandledCommands = extractCaseLabels(loginHostHandlerSource);
    const hostSentCommands = extractObjectPropertyValues(
      loginHostSource,
      "command",
    );
    const frontendPostedCommands = extractPostedPropertyValues(
      loginScriptSource,
      "command",
    );
    const frontendHandledCommands = extractCaseLabels(loginScriptSource);

    expectSetEqual(hostHandledCommands, LOGIN_PANEL_INBOUND_COMMANDS);
    expectSetEqual(frontendPostedCommands, LOGIN_PANEL_INBOUND_COMMANDS);
    expectSetEqual(hostSentCommands, LOGIN_PANEL_OUTBOUND_COMMANDS);
    expectSetEqual(frontendHandledCommands, LOGIN_PANEL_OUTBOUND_COMMANDS);
  });
});
