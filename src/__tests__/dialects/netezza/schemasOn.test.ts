import {
  detectNetezzaSchemasEnabled,
  parseSchemasEnabledFromNotice,
} from "../../../dialects/netezza/metadata/schemasOn";
import type { DatabaseConnection } from "../../../contracts/database";

describe("parseSchemasEnabledFromNotice", () => {
  it("returns false when notice ends with 0", () => {
    expect(parseSchemasEnabledFromNotice("ENABLE_SCHEMA_DBO_CHECK = 0")).toBe(
      false,
    );
  });

  it("returns true when notice ends with non-zero", () => {
    expect(parseSchemasEnabledFromNotice("ENABLE_SCHEMA_DBO_CHECK = 1")).toBe(
      true,
    );
  });

  it("returns false for empty notice", () => {
    expect(parseSchemasEnabledFromNotice("")).toBe(false);
  });
});

describe("detectNetezzaSchemasEnabled", () => {
  function createConnection(notices: string[]): DatabaseConnection {
    const handlers = new Map<string, (msg: unknown) => void>();
    return {
      on: (event: string, handler: (msg: unknown) => void) => {
        handlers.set(event, handler);
      },
      removeListener: (event: string, _handler: (msg: unknown) => void) => {
        handlers.delete(event);
      },
      createCommand: () => ({
        executeReader: async () => ({
          read: async () => {
            const noticeHandler = handlers.get("notice");
            for (const message of notices) {
              noticeHandler?.({ message });
            }
            return false;
          },
          close: async () => undefined,
        }),
      }),
      close: async () => undefined,
    } as unknown as DatabaseConnection;
  }

  it("detects schemas enabled from server notice", async () => {
    const enabled = await detectNetezzaSchemasEnabled(
      createConnection(["ENABLE_SCHEMA_DBO_CHECK = 1"]),
    );
    expect(enabled).toBe(true);
  });

  it("detects schemas disabled from server notice", async () => {
    const enabled = await detectNetezzaSchemasEnabled(
      createConnection(["ENABLE_SCHEMA_DBO_CHECK = 0"]),
    );
    expect(enabled).toBe(false);
  });

  it("returns false when command fails", async () => {
    const connection = {
      on: jest.fn(),
      removeListener: jest.fn(),
      createCommand: () => ({
        executeReader: async () => {
          throw new Error("boom");
        },
      }),
      close: async () => undefined,
    } as unknown as DatabaseConnection;

    await expect(detectNetezzaSchemasEnabled(connection)).resolves.toBe(false);
  });
});
