import { CstNode, type IToken } from "chevrotain";
import type { ColumnInfo, TableInfo, ValidationError } from "../types";
import type { SchemaProvider } from "../schemaProvider";
import type { ScopeBuilder } from "./scopeBuilder";
import {
  addTableQualificationWarningFromQualifiedName,
} from "./queryScopeVisitor";
import type { SqlVisitorHost } from "./sqlVisitorHost";

export interface DdlVisitorHost {
  addError(
    message: string,
    token: IToken,
    severity: ValidationError["severity"],
    code: string,
  ): void;
  visit(node: CstNode): void;
  visitAs<T>(node: CstNode): T;
  getFirstTokenFromCst(node: CstNode): IToken | undefined;
  getScopeBuilder(): ScopeBuilder;
  addScriptCreatedTable(table: TableInfo): void;
  removeScriptCreatedTable(table: TableInfo): void;
  getInProcedureContext(): boolean;
  getSchemaProvider(): SchemaProvider | undefined;
  validateTableExists(table: TableInfo, tableNameNode: CstNode): void;
  isDropTargetTableLike(): boolean;
  setDropTargetIsTableLike(value: boolean): void;
  setPendingRenameSource(table: TableInfo | undefined): void;
  getPendingRenameSource(): TableInfo | undefined;
}

export function createTableStatement(
  host: DdlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  const isTemp = !!ctx.tableTypeClause;
  let createdTable: TableInfo | undefined;
  const isCtas = !!(ctx.selectStatement || ctx.withStatement);

  if (isCtas && !isTemp && !ctx.distributeClause) {
    const token =
      (ctx.Create?.[0] as unknown as IToken | undefined) ||
      (ctx.qualifiedName?.[0]
        ? host.getFirstTokenFromCst(ctx.qualifiedName[0])
        : undefined);
    if (token) {
      host.addError(
        "CREATE TABLE AS SELECT should specify explicit data distribution. Add DISTRIBUTE ON (...) or DISTRIBUTE ON RANDOM.",
        token,
        "warning",
        "SQL045",
      );
    }
  }

  if (ctx.qualifiedName) {
    const nameInfo = host.visitAs<{
      name: string;
      schema?: string;
      database?: string;
    }>(ctx.qualifiedName[0]);

    createdTable = {
      name: nameInfo.name || "",
      schema: nameInfo.schema,
      database: nameInfo.database,
      isCte: false,
      isTempTable: isTemp,
      columns: [],
    };

  }

  if (ctx.withStatement) {
    const columns = host.visitAs<ColumnInfo[]>(ctx.withStatement[0]);
    if (createdTable) {
      createdTable.columns = columns;
    }
  } else if (ctx.selectStatement) {
    const columns = host.visitAs<ColumnInfo[]>(ctx.selectStatement[0]);
    if (createdTable) {
      createdTable.columns = columns;
    }
  }

  if (ctx.columnDefinitionList) {
    const columns = host.visitAs<ColumnInfo[]>(ctx.columnDefinitionList[0]);
    if (createdTable) {
      createdTable.columns = columns;
    }
  }

  if (ctx.distributeClause) {
    host.visit(ctx.distributeClause[0]);
  }

  if (ctx.organizeClause) {
    host.visit(ctx.organizeClause[0]);
  }

  if (createdTable) {
    host.getScopeBuilder().addTable(createdTable);
    if (!host.getInProcedureContext()) {
      host.addScriptCreatedTable(createdTable);
    }
  }
}

export function createExternalTableStatement(
  host: DdlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  let createdTable: TableInfo | undefined;

  if (ctx.qualifiedName) {
    const nameInfo = host.visitAs<{
      name: string;
      schema?: string;
      database?: string;
    }>(ctx.qualifiedName[0]);
    createdTable = {
      name: nameInfo.name || "",
      schema: nameInfo.schema,
      database: nameInfo.database,
      isCte: false,
      isTempTable: false,
      columns: [],
    };
  }

  if (ctx.columnDefinitionList) {
    const columns = host.visitAs<ColumnInfo[]>(ctx.columnDefinitionList[0]);
    if (createdTable) {
      createdTable.columns = columns;
    }
  }

  if (ctx.externalTableUsingClause) {
    host.visit(ctx.externalTableUsingClause[0]);
  }

  if (ctx.selectStatement) {
    host.visit(ctx.selectStatement[0]);
  }
  if (ctx.withStatement) {
    host.visit(ctx.withStatement[0]);
  }

  if (createdTable) {
    host.getScopeBuilder().addTable(createdTable);
    if (!host.getInProcedureContext()) {
      host.addScriptCreatedTable(createdTable);
    }
  }
}

export function dropStatement(
  host: DdlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  const hasIfExists = !!(ctx.If && ctx.Exists);
  host.setDropTargetIsTableLike(
    !!(ctx.Table || ctx.View || ctx.Procedure) && !hasIfExists,
  );
  if (ctx.dropTargetList) {
    host.visit(ctx.dropTargetList[0]);
  }
  if (ctx.commandTail) {
    host.visit(ctx.commandTail[0]);
  }
  host.setDropTargetIsTableLike(false);
}

export function dropTargetList(
  host: DdlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.dropTarget) {
    ctx.dropTarget.forEach((target: CstNode) => {
      host.visit(target);
    });
  }
}

export function dropTarget(
  host: DdlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.qualifiedName && host.isDropTargetTableLike()) {
    const nameInfo = host.visitAs<{
      name: string;
      schema?: string;
      database?: string;
    }>(ctx.qualifiedName[0]);
    const table: TableInfo = {
      name: nameInfo.name,
      database: nameInfo.database,
      schema: nameInfo.schema,
      isCte: false,
      isTempTable: false,
      columns: [],
    };
    const isQualified = !!(nameInfo.database || nameInfo.schema);
    if (isQualified && host.getSchemaProvider()) {
      host.validateTableExists(table, ctx.qualifiedName[0] as CstNode);
    }
    if (!host.getInProcedureContext()) {
      host.removeScriptCreatedTable(table);
      host.getScopeBuilder().removeTable(table);
    }
    addTableQualificationWarningFromQualifiedName(
      host as unknown as SqlVisitorHost,
      nameInfo,
      ctx.qualifiedName[0] as CstNode,
    );
  }
}

export function alterTableStatement(
  host: DdlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  let oldTable: TableInfo | undefined;

  if (ctx.qualifiedName && host.getSchemaProvider()) {
    const nameInfo = host.visitAs<{
      name: string;
      schema?: string;
      database?: string;
    }>(ctx.qualifiedName[0]);
    const isQualified = !!(nameInfo.database || nameInfo.schema);
    const table: TableInfo = {
      name: nameInfo.name,
      database: nameInfo.database,
      schema: nameInfo.schema,
      isCte: false,
      isTempTable: false,
      columns: [],
    };
    if (isQualified) {
      host.validateTableExists(table, ctx.qualifiedName[0] as CstNode);
    }
    oldTable = table;
    addTableQualificationWarningFromQualifiedName(
      host as unknown as SqlVisitorHost,
      nameInfo,
      ctx.qualifiedName[0] as CstNode,
    );
  } else if (ctx.qualifiedName) {
    // No schema provider but still need name info for rename tracking
    const nameInfo = host.visitAs<{
      name: string;
      schema?: string;
      database?: string;
    }>(ctx.qualifiedName[0]);
    oldTable = {
      name: nameInfo.name,
      database: nameInfo.database,
      schema: nameInfo.schema,
      isCte: false,
      isTempTable: false,
      columns: [],
    };
  }

  // Set pending rename source so alterTableRenameTableAction can use it
  host.setPendingRenameSource(oldTable);

  if (ctx.alterTableAction) {
    host.visit(ctx.alterTableAction[0]);
  } else if (!ctx.organizeClause && ctx.qualifiedName) {
    const tableToken = host.getFirstTokenFromCst(
      ctx.qualifiedName[0] as CstNode,
    );
    if (tableToken) {
      host.addError(
        "ALTER TABLE requires an action (ADD, DROP, ALTER, RENAME, etc.)",
        tableToken,
        "error",
        "PAR001",
      );
    }
  }

  // Clear pending rename source
  host.setPendingRenameSource(undefined);

  if (ctx.organizeClause) {
    host.visit(ctx.organizeClause[0]);
  }
}

export function alterTableAction(
  host: DdlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.alterTableAddColumnAction) {
    host.visit(ctx.alterTableAddColumnAction[0]);
  } else if (ctx.alterTableAddConstraintAction) {
    host.visit(ctx.alterTableAddConstraintAction[0]);
  } else if (ctx.alterTableAlterColumnAction) {
    host.visit(ctx.alterTableAlterColumnAction[0]);
  } else if (ctx.alterTableDropColumnAction) {
    host.visit(ctx.alterTableDropColumnAction[0]);
  } else if (ctx.alterTableDropConstraintAction) {
    host.visit(ctx.alterTableDropConstraintAction[0]);
  } else if (ctx.alterTableModifyColumnAction) {
    host.visit(ctx.alterTableModifyColumnAction[0]);
  } else if (ctx.alterTableOwnerAction) {
    host.visit(ctx.alterTableOwnerAction[0]);
  } else if (ctx.alterTableRenameColumnAction) {
    host.visit(ctx.alterTableRenameColumnAction[0]);
  } else if (ctx.alterTableRenameTableAction) {
    host.visit(ctx.alterTableRenameTableAction[0]);
  } else if (ctx.alterTableSetPrivilegesAction) {
    host.visit(ctx.alterTableSetPrivilegesAction[0]);
  }
}

export function alterTableAddColumnAction(
  host: DdlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.columnDefinition) {
    ctx.columnDefinition.forEach((definition: CstNode) => {
      host.visit(definition);
    });
  }
}

export function alterTableAddConstraintAction(
  host: DdlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.tableConstraintDefinition) {
    host.visit(ctx.tableConstraintDefinition[0]);
  }
}

export function alterTableAlterColumnAction(
  host: DdlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.columnName) {
    ctx.columnName.forEach((column: CstNode) => host.visit(column));
  }
  if (ctx.additiveExpression) {
    host.visit(ctx.additiveExpression[0]);
  }
}

export function alterTableDropColumnAction(
  host: DdlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.columnName) {
    ctx.columnName.forEach((column: CstNode) => host.visit(column));
  }
}

export function alterTableDropConstraintAction(): void {
  // Constraint name validation requires metadata not available here.
}

export function alterTableModifyColumnAction(
  host: DdlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.columnName) {
    host.visit(ctx.columnName[0]);
  }
  if (ctx.typeName) {
    host.visit(ctx.typeName[0]);
  }
}

export function alterTableOwnerAction(
  host: DdlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.identifier) {
    host.visit(ctx.identifier[0]);
  }
}

export function alterTableRenameColumnAction(
  host: DdlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.columnName) {
    ctx.columnName.forEach((column: CstNode) => host.visit(column));
  }
}

export function alterTableRenameTableAction(
  host: DdlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (!ctx.qualifiedName) {
    return;
  }

  // Extract the new table name
  const newNameInfo = host.visitAs<{
    name: string;
    schema?: string;
    database?: string;
  }>(ctx.qualifiedName[0]);

  if (!newNameInfo.name) {
    return;
  }

  // Handle the rename in script scope: the RENAME TO creates a new table name
  // that subsequent statements (e.g., DROP TABLE, ALTER TABLE) need to resolve.
  const renameSource = host.getPendingRenameSource();

  const newTable: TableInfo = {
    name: newNameInfo.name,
    // Inherit database/schema from the old table if the new name doesn't specify them
    // This is critical because RENAME TO targets are often unqualified (e.g., "RENAME TO BACKUP")
    // while subsequent references use the fully qualified name.
    database: newNameInfo.database || renameSource?.database,
    schema: newNameInfo.schema || renameSource?.schema,
    isCte: false,
    isTempTable: false,
    columns: [],
  };

  // Remove old table from script scope (if it was script-created)
  if (renameSource) {
    host.removeScriptCreatedTable(renameSource);
    host.getScopeBuilder().removeTable(renameSource);
  }

  // Add new table name to script scope so subsequent statements can resolve it
  if (!host.getInProcedureContext()) {
    host.addScriptCreatedTable(newTable);
  }
  host.getScopeBuilder().addTable(newTable);
}

export function alterTableSetPrivilegesAction(
  host: DdlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.qualifiedName) {
    host.visit(ctx.qualifiedName[0]);
  }
}

export function alterTableCascadeRestrictClause(): void {
  // No validation needed
}
