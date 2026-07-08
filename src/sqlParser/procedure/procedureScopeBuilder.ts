import type { IToken } from "chevrotain";

export type ProcedureParamMode = "IN" | "OUT" | "INOUT";

export interface ProcedureScopeDiagnostic {
  code: string;
  message: string;
  token: IToken;
  severity: "error" | "warning" | "information";
}

export class ProcedureScopeBuilder {
  private readonly parameters = new Map<
    string,
    { mode: ProcedureParamMode; assigned: boolean; token: IToken }
  >();
  private readonly variables = new Map<
    string,
    { token: IToken; used: boolean }
  >();
  private hasReturnsClause = false;
  private hasReturnStatement = false;
  private returnsToken: IToken | undefined;
  private readonly diagnostics: ProcedureScopeDiagnostic[] = [];

  reset(): void {
    this.parameters.clear();
    this.variables.clear();
    this.hasReturnsClause = false;
    this.hasReturnStatement = false;
    this.returnsToken = undefined;
    this.diagnostics.length = 0;
  }

  registerParameter(
    name: string,
    mode: ProcedureParamMode,
    token: IToken,
  ): void {
    const key = name.toUpperCase();
    this.parameters.set(key, { mode, assigned: mode === "IN", token });
  }

  registerVariable(name: string, token: IToken): void {
    const key = name.toUpperCase();
    if (!this.variables.has(key)) {
      this.variables.set(key, { token, used: false });
    }
  }

  markNameUsed(name: string): void {
    const key = name.toUpperCase();
    const variable = this.variables.get(key);
    if (variable) {
      variable.used = true;
      return;
    }
    const parameter = this.parameters.get(key);
    if (parameter) {
      parameter.assigned = true;
    }
  }

  setHasReturns(token: IToken): void {
    this.hasReturnsClause = true;
    this.returnsToken = token;
  }

  setHasReturn(): void {
    this.hasReturnStatement = true;
  }

  checkStandaloneSelect(selectToken: IToken, hasInto: boolean): void {
    if (!hasInto) {
      this.diagnostics.push({
        code: "SQL037",
        message:
          "Possibly standalone SELECT in procedure should use INTO or PERFORM if the result is expected to be consumed",
        token: selectToken,
        severity: "information",
      });
    }
  }

  reportUnclosedCase(caseToken: IToken): void {
    this.diagnostics.push({
      code: "SQL041",
      message: "CASE expression must end with END",
      token: caseToken,
      severity: "error",
    });
  }

  finalize(): ProcedureScopeDiagnostic[] {
    if (this.hasReturnsClause && !this.hasReturnStatement && this.returnsToken) {
      this.diagnostics.push({
        code: "SQL038",
        message: "Procedure declares RETURNS but has no RETURN statement",
        token: this.returnsToken,
        severity: "warning",
      });
    }

    for (const [name, variable] of this.variables) {
      if (!variable.used) {
        this.diagnostics.push({
          code: "SQL039",
          message: `Variable '${name}' is declared but never used`,
          token: variable.token,
          severity: "information",
        });
      }
    }

    for (const [name, parameter] of this.parameters) {
      if (
        (parameter.mode === "OUT" || parameter.mode === "INOUT") &&
        !parameter.assigned
      ) {
        this.diagnostics.push({
          code: "SQL040",
          message: `OUT/INOUT parameter '${name}' is possibly not assigned a value`,
          token: parameter.token,
          severity: "warning",
        });
      }
    }

    return [...this.diagnostics];
  }
}
