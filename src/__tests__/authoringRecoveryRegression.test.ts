jest.unmock("chevrotain");
import { parseSemanticScopeWithParser } from "../providers/parsers/parserSqlContext";

test("an unfinished CTE body retains its declared name", () => {
  const scope = parseSemanticScopeWithParser("WITH x AS (", 11, "netezza");
  expect(scope.localDefinitions.some(definition => definition.type === "CTE" && definition.name === "x")).toBe(true);
});
