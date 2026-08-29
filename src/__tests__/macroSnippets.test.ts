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
      "Macro Bank Sales Dashboard Update",
      "Macro Bank Campaign Dashboard Update",
      "Macro Branch Productization Dashboard Update",
      "Macro External Superstore Dashboard Update",
      "Macro External Finance Dashboard Update",
      "Macro Full Reporting Pipeline",
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

  it("contains complete refresh recipes for the three generated dashboards", () => {
    const snippets = loadSnippets();

    expect(snippetText(snippets["Macro Bank Sales Dashboard Update"]))
      .toContain("sheet='Raw_Monthly'");
    expect(snippetText(snippets["Macro Bank Sales Dashboard Update"]))
      .toContain("sheet='Raw_Products'");
    expect(snippetText(snippets["Macro Bank Campaign Dashboard Update"]))
      .toContain("sheet='Raw_Campaigns'");
    expect(snippetText(snippets["Macro Branch Productization Dashboard Update"]))
      .toContain("sheet='Raw_CrossSell'");
  });

  it("contains complete external PivotTable source contracts", () => {
    const snippets = loadSnippets();

    expect(snippetText(snippets["Macro External Superstore Dashboard Update"]))
      .toContain("sheet='superstore'");
    expect(snippetText(snippets["Macro External Superstore Dashboard Update"]))
      .toContain("product_name");
    expect(snippetText(snippets["Macro External Finance Dashboard Update"]))
      .toContain("sheet='Dataset'");
    expect(snippetText(snippets["Macro External Finance Dashboard Update"]))
      .toContain("balance_after_transaction");
    expect(snippetText(snippets["Macro Full Reporting Pipeline"]))
      .toContain("%SQL(SELECT MAX(DATEKEY)");
  });
});
