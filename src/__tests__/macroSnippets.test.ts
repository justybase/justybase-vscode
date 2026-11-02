import * as fs from "fs";
import * as path from "path";

interface NetezzaSnippet {
  prefix: string | string[];
  body: string[];
  description?: string;
}

const SNIPPETS_PATH = path.resolve(
  __dirname,
  "../../dialects/netezza/snippets/netezza.code-snippets",
);

function loadSnippets(): Record<string, NetezzaSnippet> {
  return JSON.parse(fs.readFileSync(SNIPPETS_PATH, "utf8")) as Record<
    string,
    NetezzaSnippet
  >;
}

/** Dashboard refresh recipes, kept as examples next to their workbooks. */
const RECIPES_DIRECTORY = path.resolve(__dirname, "../../fixtures/bank-dashboards/macros");
const RECIPES: Readonly<Record<string, readonly string[]>> = {
  bankdashboardupdate: ["sheet='Raw_Monthly'", "sheet='Raw_Products'"],
  campaigndashboardupdate: ["sheet='Raw_Campaigns'"],
  branchproductizationupdate: ["sheet='Raw_CrossSell'"],
  externalsalesdashboard: ["sheet='superstore'", "product_name"],
  externalfinancedashboard: ["sheet='Dataset'", "balance_after_transaction"],
  fullreportingpipeline: ["%SQL(SELECT MAX(DATEKEY)"],
};

function snippetText(snippet: NetezzaSnippet): string {
  return snippet.body.join("\n");
}

describe("Netezza SAS-like snippets", () => {
  it("keeps every supported mini-scripting construct discoverable", () => {
    const snippets = loadSnippets();

    expect(Object.keys(snippets)).toEqual(expect.arrayContaining([
      "Macro LET",
      "Macro SET",
      "Macro SQL",
      "Macro SQLLIST",
      "Macro EVAL",
      "Macro PUT",
      "Macro IF THEN DO",
      "Macro ELSE DO",
      "Macro END",
      "Macro INCLUDE",
      "Macro PYTHON",
      "Macro DO Block",
      "Macro EXPORT",
      "Macro EXPORT Update XLSX",
      "Macro EXPORT Update XLSB",
      "Macro Workflow",
    ]));
  });

  it("offers update=true examples for both spreadsheet formats", () => {
    const snippets = loadSnippets();
    const xlsx = snippets["Macro EXPORT Update XLSX"];
    const xlsb = snippets["Macro EXPORT Update XLSB"];

    expect(snippetText(xlsx)).toContain("format='xlsx'");
    expect(snippetText(xlsx)).toContain("existing-report.xlsx");
    expect(snippetText(xlsx)).toContain("update=true");
    expect(snippetText(xlsb)).toContain("format='xlsb'");
    expect(snippetText(xlsb)).toContain("existing-report.xlsb");
    expect(snippetText(xlsb)).toContain("update=true");
  });

  it("keeps the general export snippet backward-compatible while exposing update", () => {
    const snippets = loadSnippets();
    const exportText = snippetText(snippets["Macro EXPORT"]);

    expect(exportText).toContain("overwrite=${5:false}");
    expect(exportText).toContain("update=${6:false}");
  });

  it("keeps environment-specific dashboard recipes out of completion", () => {
    const prefixes = Object.values(loadSnippets()).flatMap((snippet) => snippet.prefix);
    expect(prefixes).not.toEqual(expect.arrayContaining(["nzbankdashboardupdate"]));
    for (const recipe of Object.keys(RECIPES)) {
      expect(prefixes).not.toContain(`nz${recipe}`);
    }
  });

  it("contains complete dashboard refresh recipes as example files", () => {
    for (const [recipe, fragments] of Object.entries(RECIPES)) {
      const text = fs.readFileSync(path.join(RECIPES_DIRECTORY, `${recipe}.sql`), "utf8");
      for (const fragment of fragments) {
        expect(`${recipe}: ${text.includes(fragment)}`).toBe(`${recipe}: true`);
      }
    }
  });
});
