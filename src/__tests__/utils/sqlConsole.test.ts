import * as vscode from "vscode";
import {
    buildSqlConsoleHeader,
    buildSqlConsoleUntitledUri,
    isSqlConsoleDocument,
    registerSqlConsoleDocument,
    resolveSqlConsoleContextFromTreeItem,
    sanitizeSqlConsoleLabel,
    SQL_CONSOLE_HEADER_PREFIX,
} from "../../utils/sqlConsole";

function createContext() {
    let state: Record<string, unknown> = {};
    return {
        workspaceState: {
            get: jest.fn((_key: string, defaultValue?: unknown) => state || defaultValue),
            update: jest.fn((_key: string, value: Record<string, unknown>) => {
                state = value;
                return Promise.resolve();
            }),
        },
    } as unknown as vscode.ExtensionContext;
}

describe("sqlConsole utilities", () => {
    it("sanitizes connection names for untitled SQL console labels", () => {
        expect(sanitizeSqlConsoleLabel("prod nz/main")).toBe("prod_nz_main");
        expect(sanitizeSqlConsoleLabel("   ")).toBe("connection");
    });

    it("builds readable untitled URIs for console tabs", () => {
        const uri = buildSqlConsoleUntitledUri("prod nz");

        expect(uri.scheme).toBe("untitled");
        expect(uri.toString()).toBe("untitled:Console-prod_nz.sql");
    });

    it("builds console headers with optional database context", () => {
        expect(buildSqlConsoleHeader("prod")).toBe(
            `${SQL_CONSOLE_HEADER_PREFIX} prod\n-- Ephemeral session (not saved to disk)\n\n`,
        );
        expect(buildSqlConsoleHeader("prod", "SALES")).toBe(
            `${SQL_CONSOLE_HEADER_PREFIX} prod | SALES\n-- Ephemeral session (not saved to disk)\n\n`,
        );
    });

    it("recognizes SQL console documents from registry, URI, or header", async () => {
        const context = createContext();
        await registerSqlConsoleDocument(context, "untitled:Console-prod.sql", {
            connectionName: "prod",
            openedAt: 1,
        });

        expect(isSqlConsoleDocument(context, "untitled:Console-prod.sql")).toBe(true);
        expect(isSqlConsoleDocument(context, "untitled:Console-other.sql")).toBe(true);
        expect(isSqlConsoleDocument(context, "untitled:Scratch.sql", `${SQL_CONSOLE_HEADER_PREFIX} prod`)).toBe(true);
        expect(isSqlConsoleDocument(context, "file:///tmp/query.sql", "SELECT 1")).toBe(false);
    });

    it("resolves schema tree items into console context", () => {
        expect(resolveSqlConsoleContextFromTreeItem({
            contextValue: "serverInstance",
            connectionName: "prod",
        })).toEqual({ connectionName: "prod" });

        expect(resolveSqlConsoleContextFromTreeItem({
            contextValue: "database",
            connectionName: "prod",
            dbName: "SALES",
        })).toEqual({ connectionName: "prod", database: "SALES" });

        expect(resolveSqlConsoleContextFromTreeItem(undefined)).toEqual({});
    });
});
