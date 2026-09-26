import { describe, expect, it } from "@jest/globals";
import {
  DEFAULT_JOIN_COMPLETION_SETTINGS,
  normalizeJoinCompletionSettings,
} from "../lsp/joinCompletionSettings";

describe("join completion settings", () => {
  it("uses enabled heuristics and aliases by default", () => {
    expect(normalizeJoinCompletionSettings(undefined)).toEqual(
      DEFAULT_JOIN_COMPLETION_SETTINGS,
    );
  });

  it("normalizes structured virtual relationships and custom aliases", () => {
    expect(normalizeJoinCompletionSettings({
      joinNameHeuristics: false,
      autoJoinAliases: false,
      joinAliases: [
        { table: { database: "DB1", schema: "S1", table: "ORDERS" }, alias: "O" },
        { table: { table: "" }, alias: "bad" },
      ],
      joinRelations: [{
        left: { database: "DB1", schema: "S1", table: "USERS" },
        right: { database: "DB1", schema: "S1", table: "ORDERS" },
        columns: [
          { left: "TENANT_ID", right: "TENANT_ID" },
          { left: "ID", right: "OWNER_ID" },
          { left: "", right: "INVALID" },
        ],
      }, {
        left: { table: "NO_COLUMNS" },
        right: { table: "OTHER" },
        columns: [],
      }],
    })).toEqual({
      nameHeuristicsEnabled: false,
      autoAliases: false,
      aliases: [{
        table: { database: "DB1", schema: "S1", table: "ORDERS" },
        alias: "O",
      }],
      relations: [{
        left: { database: "DB1", schema: "S1", table: "USERS" },
        right: { database: "DB1", schema: "S1", table: "ORDERS" },
        columns: [
          { left: "TENANT_ID", right: "TENANT_ID" },
          { left: "ID", right: "OWNER_ID" },
        ],
      }],
    });
  });
});
