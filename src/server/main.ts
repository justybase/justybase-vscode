import {
  createConnection,
  InitializeParams,
  InitializeResult,
  ProposedFeatures,
  TextDocumentSyncKind,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { TextDocuments } from "vscode-languageserver/node";
import {
  DocumentParseSession,
  DocumentValidationSession,
} from "../sqlParser";
import {
  NETEZZA_DOCUMENT_CONTEXT_CHANGED_NOTIFICATION,
  NETEZZA_GET_METADATA_REQUEST,
  NETEZZA_METADATA_CACHE_INVALIDATED_NOTIFICATION,
  type DocumentContextChangedParams,
  type MetadataResponse,
} from "../lsp/protocol";
import { LspCompletionEngine } from "./completionEngine";
import { LspInlayHintEngine } from "./inlayHintEngine";
import { MetadataBridge } from "./metadataBridge";
import { registerCompletionHandler } from "./handlers/completionHandler";
import { createDiagnosticsHandler } from "./handlers/diagnosticsHandler";
import { registerHoverHandler } from "./handlers/hoverHandler";
import {
  registerInlayHintHandler,
  requestInlayHintRefresh,
} from "./handlers/inlayHintHandler";
import { registerSymbolHandlers } from "./handlers/symbolHandlers";
import {
  registerCodeActionHandler,
  registerSignatureHelpHandler,
} from "./handlers/signatureAndCodeActionHandlers";

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

const metadataBridge = new MetadataBridge(
  (params) =>
    connection.sendRequest<MetadataResponse>(NETEZZA_GET_METADATA_REQUEST, params),
  connection.console,
);
const documentParseSession = new DocumentParseSession();
const documentValidationSession = new DocumentValidationSession();
const completionEngine = new LspCompletionEngine(
  metadataBridge,
  documentParseSession,
);
const inlayHintEngine = new LspInlayHintEngine(
  metadataBridge,
  documentParseSession,
);
const diagnosticsHandler = createDiagnosticsHandler({
  connection,
  metadataBridge,
  documentParseSession,
  documentValidationSession,
});

connection.onInitialize((_params: InitializeParams): InitializeResult => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        triggerCharacters: [".", " ", "*", "$", "%", "&"],
      },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: {
        prepareProvider: true,
      },
      inlayHintProvider: true,
      signatureHelpProvider: {
        triggerCharacters: ["(", ","],
      },
      codeActionProvider: true,
    },
  };
});

connection.onInitialized(() => {
  connection.console.log("Netezza SQL language server initialized.");
});

connection.onDidChangeConfiguration(() => {
  requestInlayHintRefresh(connection);
});

documents.onDidOpen((event) => {
  diagnosticsHandler.scheduleDiagnostics(event.document);
});

documents.onDidChangeContent((event) => {
  diagnosticsHandler.scheduleDiagnostics(event.document);
});

documents.onDidClose((event) => {
  diagnosticsHandler.onDocumentClosed(event.document.uri);
  metadataBridge.clearDocument(event.document.uri);
  documentParseSession.invalidateDocument(event.document.uri);
  documentValidationSession.invalidateDocument(event.document.uri);
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

connection.onNotification(
  NETEZZA_DOCUMENT_CONTEXT_CHANGED_NOTIFICATION,
  (params: DocumentContextChangedParams) => {
    const document = documents.get(params.documentUri);
    if (!document) {
      return;
    }

    metadataBridge.clearDocument(document.uri);
    documentValidationSession.invalidateDocument(document.uri);
    diagnosticsHandler.scheduleDiagnostics(document);
    requestInlayHintRefresh(connection);
  },
);

connection.onNotification(NETEZZA_METADATA_CACHE_INVALIDATED_NOTIFICATION, () => {
  metadataBridge.clearAll();
  documentValidationSession.clear();
  for (const document of documents.all()) {
    diagnosticsHandler.scheduleDiagnostics(document);
  }
  requestInlayHintRefresh(connection);
});

registerCompletionHandler({ connection, documents, completionEngine });
registerHoverHandler({
  connection,
  documents,
  metadataBridge,
  documentParseSession,
});
registerInlayHintHandler({ connection, documents, inlayHintEngine });
registerSignatureHelpHandler({ connection, documents, metadataBridge });
registerCodeActionHandler({ connection, documents, metadataBridge });
registerSymbolHandlers({
  connection,
  documents,
  metadataBridge,
  documentParseSession,
});

connection.onShutdown(() => {
  diagnosticsHandler.dispose();
});

documents.listen(connection);
connection.listen();
