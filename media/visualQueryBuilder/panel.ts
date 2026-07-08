import type {
    CanvasPoint,
    ColumnJoinDragState,
    DragState,
    PlacedTable,
    VisualQueryBuilderBootstrapState,
    VisualQueryBuilderData,
    VisualQueryBuilderHostToWebviewMessage,
    VisualQueryBuilderJoin,
    VisualQueryBuilderJoinSource,
    VisualQueryBuilderJoinType,
    VisualQueryBuilderState,
    VisualQueryBuilderTable,
    VisualQueryBuilderWebviewToHostMessage,
} from './hostContracts.js';
import { getRequiredElement } from './dom.js';
import { postToHost, asHostMessage } from './protocol.js';

/** @type {Partial<VisualQueryBuilderBootstrapState>} */
const bootstrapState: Partial<VisualQueryBuilderBootstrapState> =
  (window as Window & { visualQueryBuilderInitialState?: Partial<VisualQueryBuilderBootstrapState> }).visualQueryBuilderInitialState || {};

const state: VisualQueryBuilderState = {
  connectionName: "",
  availableSchemas: [],
  data: {
    database: "",
    schema: "",
    tables: [],
    relationships: [],
  },
  placedTables: [],
  joins: [],
  searchTerm: "",
  distinct: false,
  whereClause: "",
  groupByClause: "",
  havingClause: "",
  orderByClause: "",
  limitValue: "",
};

const dom = {
  dbSchemaBadge: getRequiredElement<HTMLSpanElement>("dbSchemaBadge"),
  builderStats: getRequiredElement<HTMLSpanElement>("builderStats"),
  schemaSelect: getRequiredElement<HTMLSelectElement>("schemaSelect"),
  reloadSchemaBtn: getRequiredElement<HTMLButtonElement>("reloadSchemaBtn"),
  autoLayoutBtn: getRequiredElement<HTMLButtonElement>("autoLayoutBtn"),
  clearCanvasBtn: getRequiredElement<HTMLButtonElement>("clearCanvasBtn"),
  tableSearch: getRequiredElement<HTMLInputElement>("tableSearch"),
  tablePalette: getRequiredElement<HTMLDivElement>("tablePalette"),
  canvasViewport: getRequiredElement<HTMLDivElement>("canvasViewport"),
  canvas: getRequiredElement<HTMLDivElement>("canvas"),
  joinLines: getRequiredElement<SVGSVGElement>("joinLines"),
  distinctToggle: getRequiredElement<HTMLInputElement>("distinctToggle"),
  joinLeftTable: getRequiredElement<HTMLSelectElement>("joinLeftTable"),
  joinLeftColumn: getRequiredElement<HTMLSelectElement>("joinLeftColumn"),
  joinType: getRequiredElement<HTMLSelectElement>("joinType"),
  joinRightTable: getRequiredElement<HTMLSelectElement>("joinRightTable"),
  joinRightColumn: getRequiredElement<HTMLSelectElement>("joinRightColumn"),
  addJoinBtn: getRequiredElement<HTMLButtonElement>("addJoinBtn"),
  joinList: getRequiredElement<HTMLDivElement>("joinList"),
  selectedColumnsList: getRequiredElement<HTMLDivElement>("selectedColumnsList"),
  whereClause: getRequiredElement<HTMLTextAreaElement>("whereClause"),
  groupByClause: getRequiredElement<HTMLTextAreaElement>("groupByClause"),
  havingClause: getRequiredElement<HTMLTextAreaElement>("havingClause"),
  orderByClause: getRequiredElement<HTMLTextAreaElement>("orderByClause"),
  limitValue: getRequiredElement<HTMLInputElement>("limitValue"),
  sqlPreview: getRequiredElement<HTMLTextAreaElement>("sqlPreview"),
  copySqlBtn: getRequiredElement<HTMLButtonElement>("copySqlBtn"),
  openSqlBtn: getRequiredElement<HTMLButtonElement>("openSqlBtn"),
  runSqlBtn: getRequiredElement<HTMLButtonElement>("runSqlBtn"),
};

let tableInstanceCounter = 1;
let joinCounter = 1;

let dragState: DragState | null = null;
let columnJoinDragState: ColumnJoinDragState | null = null;
let hoveredJoinTargetRow: HTMLElement | null = null;
let statusResetTimer: ReturnType<typeof setTimeout> | null = null;

initialize(bootstrapState);

function initialize(initialState: Partial<VisualQueryBuilderBootstrapState>): void {
  registerEventHandlers();
  applyState(initialState, true);
}

function registerEventHandlers(): void {
  dom.tableSearch.addEventListener("input", () => {
    state.searchTerm = (dom.tableSearch.value || "").trim().toUpperCase();
    renderTablePalette();
  });

  dom.reloadSchemaBtn.addEventListener("click", () => {
    const schema = dom.schemaSelect.value;
    if (!schema) {
      return;
    }
    postToHost({ command: "loadSchema", schema });
  });

  dom.autoLayoutBtn.addEventListener("click", () => {
    autoLayoutTables();
  });

  dom.clearCanvasBtn.addEventListener("click", () => {
    stopColumnJoinDrag(false);
    state.placedTables = [];
    state.joins = [];
    renderCanvas();
    refreshJoinControls();
    updateSelectedColumnsList();
    updateSqlPreview();
    setTemporaryStatus("Canvas cleared");
  });

  dom.distinctToggle.addEventListener("change", () => {
    state.distinct = dom.distinctToggle.checked;
    updateSqlPreview();
  });

  dom.whereClause.addEventListener("input", () => {
    state.whereClause = dom.whereClause.value || "";
    updateSqlPreview();
  });

  dom.groupByClause.addEventListener("input", () => {
    state.groupByClause = dom.groupByClause.value || "";
    updateSqlPreview();
  });

  dom.havingClause.addEventListener("input", () => {
    state.havingClause = dom.havingClause.value || "";
    updateSqlPreview();
  });

  dom.orderByClause.addEventListener("input", () => {
    state.orderByClause = dom.orderByClause.value || "";
    updateSqlPreview();
  });

  dom.limitValue.addEventListener("input", () => {
    state.limitValue = dom.limitValue.value || "";
    updateSqlPreview();
  });

  dom.joinLeftTable.addEventListener("change", () => {
    populateJoinColumnOptions(dom.joinLeftTable, dom.joinLeftColumn);
  });

  dom.joinRightTable.addEventListener("change", () => {
    populateJoinColumnOptions(dom.joinRightTable, dom.joinRightColumn);
  });

  dom.addJoinBtn.addEventListener("click", () => {
    addManualJoin();
  });

  dom.copySqlBtn.addEventListener("click", async () => {
    const sql = dom.sqlPreview.value || "";
    if (!sql.trim()) {
      return;
    }

    try {
      await navigator.clipboard.writeText(sql);
      setTemporaryStatus("SQL copied to clipboard");
    } catch (_err) {
      dom.sqlPreview.focus();
      dom.sqlPreview.select();
      document.execCommand("copy");
      setTemporaryStatus("SQL copied to clipboard");
    }
  });

  dom.openSqlBtn.addEventListener("click", () => {
    postToHost({ command: "openSql", sql: dom.sqlPreview.value || "" });
  });

  dom.runSqlBtn.addEventListener("click", () => {
    postToHost({ command: "runSql", sql: dom.sqlPreview.value || "" });
  });

  dom.canvasViewport.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
  });

  dom.canvasViewport.addEventListener("drop", (event) => {
    event.preventDefault();
    const fullName = event.dataTransfer?.getData("text/plain");
    if (!fullName) {
      return;
    }

    // Find table by fullName (schema.table) for unique identification across schemas
    const table = state.data.tables.find((item) => item.fullName === fullName);
    if (!table) {
      return;
    }

    const viewportRect = dom.canvasViewport.getBoundingClientRect();
    const x = event.clientX - viewportRect.left + dom.canvasViewport.scrollLeft;
    const y = event.clientY - viewportRect.top + dom.canvasViewport.scrollTop;
    addTableToCanvas(table, x, y);
  });

  window.addEventListener("resize", () => {
    renderJoinLines();
  });

  window.addEventListener("message", (event) => {
    const message = asHostMessage(event.data);

    switch (message.command) {
      case "schemaData":
        applyState(message.payload, true);
        setTemporaryStatus("Schema reloaded");
        return;
      case "loadingState":
        setLoading(Boolean(message.loading));
        return;
      case "error":
        setTemporaryStatus(`Error: ${message.message}`);
        return;
    }
  });
}

function setLoading(isLoading: boolean): void {
  document.body.classList.toggle("is-loading", isLoading);
  dom.reloadSchemaBtn.disabled = isLoading;
}

function applyState(
  nextState: Partial<VisualQueryBuilderBootstrapState>,
  resetCanvas: boolean,
): void {
  state.connectionName = nextState.connectionName || state.connectionName;
  state.availableSchemas = Array.isArray(nextState.availableSchemas)
    ? [...nextState.availableSchemas]
    : [];
  state.data = normalizeData(nextState.data);

  if (resetCanvas) {
    stopColumnJoinDrag(false);
    state.placedTables = [];
    state.joins = [];
    tableInstanceCounter = 1;
    joinCounter = 1;
    dom.whereClause.value = "";
    dom.groupByClause.value = "";
    dom.havingClause.value = "";
    dom.orderByClause.value = "";
    dom.limitValue.value = "";
    dom.distinctToggle.checked = false;
    state.whereClause = "";
    state.groupByClause = "";
    state.havingClause = "";
    state.orderByClause = "";
    state.limitValue = "";
    state.distinct = false;
  }

  updateHeader();
  renderSchemaOptions();
  renderTablePalette();
  renderCanvas();
  refreshJoinControls();
  updateSelectedColumnsList();
  updateSqlPreview();
}

function normalizeData(data: VisualQueryBuilderData | undefined): VisualQueryBuilderData {
  const fallback = {
    database: "",
    schema: "",
    tables: [],
    relationships: [],
    allSchemas: [],
  };
  if (!data) {
    return fallback;
  }

  return {
    database: String(data.database || "").toUpperCase(),
    schema: String(data.schema || "").toUpperCase(),
    tables: Array.isArray(data.tables) ? data.tables : [],
    relationships: Array.isArray(data.relationships) ? data.relationships : [],
    allSchemas: Array.isArray(data.allSchemas) ? data.allSchemas : [],
  };
}

function updateHeader(): void {
  // Show just database name since we now load all schemas
  const schemaCount = state.data.allSchemas?.length || 1;
  dom.dbSchemaBadge.textContent = `${state.data.database} (${schemaCount} schema${schemaCount !== 1 ? "s" : ""})`;
  dom.builderStats.textContent = `${state.data.tables.length} tables • ${state.data.relationships.length} relationships`;
}

function setTemporaryStatus(statusText: string): void {
  if (statusResetTimer) {
    clearTimeout(statusResetTimer);
  }

  dom.builderStats.textContent = `${state.data.tables.length} tables • ${state.data.relationships.length} relationships • ${statusText}`;
  statusResetTimer = setTimeout(() => {
    updateHeader();
  }, 2500);
}

function renderSchemaOptions(): void {
  dom.schemaSelect.innerHTML = "";
  for (const schemaName of state.availableSchemas) {
    const option = document.createElement("option");
    option.value = schemaName;
    option.textContent = schemaName;
    if (schemaName === state.data.schema) {
      option.selected = true;
    }
    dom.schemaSelect.appendChild(option);
  }
}

function renderTablePalette(): void {
  dom.tablePalette.innerHTML = "";

  // Group tables by schema
  const tablesBySchema = new Map<string, VisualQueryBuilderTable[]>();
  for (const table of state.data.tables) {
    const schema = table.schema || state.data.schema;
    if (!tablesBySchema.has(schema)) {
      tablesBySchema.set(schema, []);
    }
    tablesBySchema.get(schema)!.push(table);
  }

  // Filter tables based on search term
  const filteredTables = state.data.tables.filter((table) => {
    if (!state.searchTerm) {
      return true;
    }
    const value =
      `${table.tableName} ${table.schema}.${table.tableName}`.toUpperCase();
    return value.includes(state.searchTerm);
  });

  if (filteredTables.length === 0) {
    const emptyItem = document.createElement("div");
    emptyItem.className = "palette-empty";
    emptyItem.textContent = "No matching tables";
    dom.tablePalette.appendChild(emptyItem);
    return;
  }

  // Render tables grouped by schema
  const filteredSchemas = new Set(
    filteredTables.map((t) => t.schema || state.data.schema),
  );

  for (const schema of Array.from(tablesBySchema.keys()).sort()) {
    if (!filteredSchemas.has(schema)) {
      continue;
    }

    // Add schema header
    const schemaHeader = document.createElement("div");
    schemaHeader.className = "palette-schema-header";
    schemaHeader.textContent = schema;
    dom.tablePalette.appendChild(schemaHeader);

    // Add tables in this schema
    const schemaTables = (tablesBySchema.get(schema) ?? [])
      .filter((t) => filteredTables.includes(t));

    for (const table of schemaTables) {
      const item = document.createElement("div");
      item.className = "table-palette-item";
      item.draggable = true;
      // Use full qualified name for unique identification
      item.dataset.tableName = table.tableName;
      item.dataset.schema = table.schema;
      item.dataset.fullName = table.fullName;

      const title = document.createElement("div");
      title.className = "palette-title";
      title.textContent = table.tableName;
      item.appendChild(title);

      const meta = document.createElement("div");
      meta.className = "palette-meta";
      meta.textContent = `${table.columns.length} columns`;
      item.appendChild(meta);

      item.addEventListener("dragstart", (event) => {
        if (!event.dataTransfer) {
          return;
        }
        event.dataTransfer.effectAllowed = "copy";
        // Store full name to identify table uniquely
        event.dataTransfer.setData("text/plain", table.fullName);
      });

      item.addEventListener("dblclick", () => {
        const offset = state.placedTables.length * 24;
        addTableToCanvas(table, 120 + offset, 90 + offset);
      });

      dom.tablePalette.appendChild(item);
    }
  }
}

function generateAlias(tableName: string): string {
  const firstLetterMatch = tableName.match(/[A-Za-z]/);
  const prefix = firstLetterMatch ? firstLetterMatch[0].toUpperCase() : "T";
  const existingAliases = new Set(
    state.placedTables.map((table) => table.alias.toUpperCase()),
  );
  let counter = 1;
  let alias = `${prefix}${counter}`;

  while (existingAliases.has(alias.toUpperCase())) {
    counter += 1;
    alias = `${prefix}${counter}`;
  }

  return alias;
}

function normalizePosition(value: number, maxValue: number): number {
  const floor = 12;
  if (Number.isNaN(value)) {
    return floor;
  }
  return Math.max(floor, Math.min(value, maxValue));
}

function addTableToCanvas(
  tableDef: VisualQueryBuilderTable,
  rawX: number,
  rawY: number,
): void {
  const maxX = Math.max(20, dom.canvas.scrollWidth - 320);
  const maxY = Math.max(20, dom.canvas.scrollHeight - 260);
  const instance = {
    instanceId: `T${tableInstanceCounter++}`,
    tableName: tableDef.tableName,
    schema: tableDef.schema,
    database: tableDef.database,
    fullName: tableDef.fullName,
    alias: generateAlias(tableDef.tableName),
    x: normalizePosition(rawX, maxX),
    y: normalizePosition(rawY, maxY),
    selectedColumns: [],
  };

  state.placedTables.push(instance);
  autoAttachRelationshipJoins(instance.instanceId);
  renderCanvas();
  refreshJoinControls();
  updateSelectedColumnsList();
  updateSqlPreview();
}

function autoAttachRelationshipJoins(newTableId: string): void {
  const newTable = getPlacedTableById(newTableId);
  if (!newTable) {
    return;
  }

  for (const otherTable of state.placedTables) {
    if (otherTable.instanceId === newTableId) {
      continue;
    }

    for (const relationship of state.data.relationships) {
      const isNewAsFrom =
        relationshipMatchesTable(relationship.fromTable, newTable) &&
        relationshipMatchesTable(relationship.toTable, otherTable);
      const isNewAsTo =
        relationshipMatchesTable(relationship.fromTable, otherTable) &&
        relationshipMatchesTable(relationship.toTable, newTable);

      if (isNewAsFrom) {
        createJoin(
          newTable.instanceId,
          otherTable.instanceId,
          relationship.fromColumns,
          relationship.toColumns,
          "INNER",
          "relationship",
          relationship.constraintName,
        );
        continue;
      }

      if (isNewAsTo) {
        createJoin(
          otherTable.instanceId,
          newTable.instanceId,
          relationship.fromColumns,
          relationship.toColumns,
          "INNER",
          "relationship",
          relationship.constraintName,
        );
      }
    }
  }
}

function relationshipMatchesTable(
  relationshipTableName: string,
  tableInstance: PlacedTable,
): boolean {
  const relationKey = String(relationshipTableName || "").toUpperCase();
  const fullKey =
    `${tableInstance.schema}.${tableInstance.tableName}`.toUpperCase();
  const shortKey = tableInstance.tableName.toUpperCase();
  return relationKey === fullKey || relationKey.endsWith(`.${shortKey}`);
}

function createJoin(
  leftTableId: string,
  rightTableId: string,
  leftColumns: string[],
  rightColumns: string[],
  joinType: string,
  source: VisualQueryBuilderJoinSource,
  constraintName: string,
): boolean {
  if (!leftTableId || !rightTableId || leftTableId === rightTableId) {
    return false;
  }

  const normalizedLeftColumns = Array.isArray(leftColumns)
    ? leftColumns.filter(Boolean)
    : [];
  const normalizedRightColumns = Array.isArray(rightColumns)
    ? rightColumns.filter(Boolean)
    : [];
  if (
    normalizedLeftColumns.length === 0 ||
    normalizedRightColumns.length === 0
  ) {
    return false;
  }

  const join = {
    joinId: `J${joinCounter++}`,
    leftTableId,
    rightTableId,
    leftColumns: normalizedLeftColumns,
    rightColumns: normalizedRightColumns,
    joinType: normalizeJoinType(joinType),
    source,
    constraintName: constraintName || "",
  };

  const joinSignature = toJoinSignature(join);
  const alreadyExists = state.joins.some(
    (existing) => toJoinSignature(existing) === joinSignature,
  );
  if (alreadyExists) {
    return false;
  }

  state.joins.push(join);
  return true;
}

function toJoinSignature(join: VisualQueryBuilderJoin): string {
  return [
    join.leftTableId,
    join.rightTableId,
    join.leftColumns.join("|").toUpperCase(),
    join.rightColumns.join("|").toUpperCase(),
  ].join("::");
}

function normalizeJoinType(joinType: string): VisualQueryBuilderJoinType {
  const normalized = String(joinType || "").toUpperCase();
  if (
    normalized === "LEFT" ||
    normalized === "RIGHT" ||
    normalized === "FULL"
  ) {
    return normalized as VisualQueryBuilderJoinType;
  }
  return "INNER";
}

function renderCanvas(): void {
  dom.canvas.innerHTML = "";

  for (const table of state.placedTables) {
    const tableDef = getTableDefinition(table);
    if (!tableDef) {
      continue;
    }

    const card = document.createElement("div");
    card.className = "table-card";
    card.dataset.instanceId = table.instanceId;
    card.style.left = `${table.x}px`;
    card.style.top = `${table.y}px`;

    const header = document.createElement("div");
    header.className = "table-card-header";
    header.addEventListener("mousedown", (event) => {
      startDraggingTable(event, table.instanceId);
    });

    const title = document.createElement("span");
    title.className = "table-card-title";
    title.textContent = table.tableName;
    header.appendChild(title);

    const aliasInput = document.createElement("input");
    aliasInput.className = "alias-input";
    aliasInput.type = "text";
    aliasInput.value = table.alias;
    aliasInput.maxLength = 20;
    aliasInput.title = "Alias";
    aliasInput.addEventListener("click", (event) => event.stopPropagation());
    aliasInput.addEventListener("input", () => {
      updateTableAlias(table.instanceId, aliasInput.value);
    });
    header.appendChild(aliasInput);

    const removeButton = document.createElement("button");
    removeButton.className = "remove-table-btn";
    removeButton.textContent = "×";
    removeButton.title = "Remove table";
    removeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      removePlacedTable(table.instanceId);
    });
    header.appendChild(removeButton);

    card.appendChild(header);

    const body = document.createElement("div");
    body.className = "table-card-body";
    for (const column of tableDef.columns) {
      const row = document.createElement("label");
      row.className = "column-row";
      row.dataset.tableId = table.instanceId;
      row.dataset.columnName = column.name;

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = table.selectedColumns.includes(column.name);
      checkbox.addEventListener("change", () => {
        toggleSelectedColumn(table.instanceId, column.name, checkbox.checked);
      });
      row.appendChild(checkbox);

      const nameElement = document.createElement("span");
      nameElement.className = "column-name";
      nameElement.textContent = column.name;
      row.appendChild(nameElement);

      const typeElement = document.createElement("span");
      typeElement.className = "column-type";
      typeElement.textContent = column.dataType;
      row.appendChild(typeElement);

      const flags = document.createElement("span");
      flags.className = "column-flags";
      const markers: string[] = [];
      if (column.isPrimaryKey) {
        markers.push("PK");
      }
      if (column.isForeignKey) {
        markers.push("FK");
      }
      flags.textContent = markers.join(" ");
      row.appendChild(flags);

      const joinHandle = document.createElement("button");
      joinHandle.type = "button";
      joinHandle.className = "column-link-handle";
      joinHandle.title = "Drag to create join";
      joinHandle.textContent = "●";
      joinHandle.addEventListener("mousedown", (event) => {
        startColumnJoinDrag(event, table.instanceId, column.name);
      });
      row.appendChild(joinHandle);

      body.appendChild(row);
    }

    card.appendChild(body);
    dom.canvas.appendChild(card);
  }

  renderJoinLines();
  renderJoinList();
}

function startColumnJoinDrag(
  event: MouseEvent,
  fromTableId: string,
  fromColumn: string,
): void {
  if (event.button !== 0) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const startPoint = getColumnAnchorPoint(fromTableId, fromColumn, true);
  if (!startPoint) {
    return;
  }

  stopColumnJoinDrag(false);
  columnJoinDragState = {
    fromTableId,
    fromColumn,
    startPoint,
    currentPoint: { ...startPoint },
  };

  document.body.classList.add("column-link-mode");
  document.addEventListener("mousemove", handleColumnJoinDragMove);
  document.addEventListener("mouseup", handleColumnJoinDragEnd);
  document.addEventListener("keydown", handleColumnJoinDragKeydown);
  renderJoinLines();
}

function handleColumnJoinDragMove(event: MouseEvent): void {
  if (!columnJoinDragState) {
    return;
  }

  columnJoinDragState.currentPoint = getCanvasPointFromClient(
    event.clientX,
    event.clientY,
  );
  const targetRow = findTargetColumnRow(
    event.clientX,
    event.clientY,
    columnJoinDragState.fromTableId,
  );
  setHoveredJoinTargetRow(targetRow);
  renderJoinLines();
}

function handleColumnJoinDragEnd(event: MouseEvent): void {
  if (!columnJoinDragState) {
    return;
  }

  const targetRow = findTargetColumnRow(
    event.clientX,
    event.clientY,
    columnJoinDragState.fromTableId,
  );
  const fromTableId = columnJoinDragState.fromTableId;
  const fromColumn = columnJoinDragState.fromColumn;

  stopColumnJoinDrag(false);

  if (!targetRow) {
    renderJoinLines();
    return;
  }

  const rightTableId = targetRow.dataset.tableId || "";
  const rightColumn = targetRow.dataset.columnName || "";
  const added = createJoin(
    fromTableId,
    rightTableId,
    [fromColumn],
    [rightColumn],
    normalizeJoinType(dom.joinType.value),
    "manual",
    "",
  );

  if (!added) {
    renderJoinLines();
    return;
  }

  renderJoinLines();
  renderJoinList();
  refreshJoinControls();
  updateSqlPreview();
  setTemporaryStatus(`Join created: ${fromColumn} → ${rightColumn}`);
}

function handleColumnJoinDragKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    stopColumnJoinDrag(true);
  }
}

function stopColumnJoinDrag(triggerRender: boolean): void {
  document.removeEventListener("mousemove", handleColumnJoinDragMove);
  document.removeEventListener("mouseup", handleColumnJoinDragEnd);
  document.removeEventListener("keydown", handleColumnJoinDragKeydown);
  document.body.classList.remove("column-link-mode");

  setHoveredJoinTargetRow(null);
  columnJoinDragState = null;

  if (triggerRender) {
    renderJoinLines();
  }
}

function setHoveredJoinTargetRow(row: HTMLElement | null): void {
  if (hoveredJoinTargetRow && hoveredJoinTargetRow !== row) {
    hoveredJoinTargetRow.classList.remove("join-target-hover");
  }

  hoveredJoinTargetRow = row || null;
  if (hoveredJoinTargetRow) {
    hoveredJoinTargetRow.classList.add("join-target-hover");
  }
}

function findTargetColumnRow(clientX: number, clientY: number, sourceTableId: string): HTMLElement | null {
  const element = document.elementFromPoint(clientX, clientY);
  if (!element) {
    return null;
  }

  const row = element.closest(".column-row") as HTMLElement | null;
  if (!row) {
    return null;
  }

  const targetTableId = row.dataset.tableId || "";
  if (!targetTableId || targetTableId === sourceTableId) {
    return null;
  }

  if (!row.dataset.columnName) {
    return null;
  }

  return row;
}

function findColumnRow(tableId: string, columnName: string): HTMLElement | null {
  const rows = dom.canvas.querySelectorAll(".column-row");
  for (const row of Array.from(rows)) {
    const columnRow = row as HTMLElement;
    if (
      columnRow.dataset.tableId === tableId &&
      columnRow.dataset.columnName === columnName
    ) {
      return columnRow;
    }
  }
  return null;
}

function getCanvasPointFromClient(clientX: number, clientY: number): CanvasPoint {
  const viewportRect = dom.canvasViewport.getBoundingClientRect();
  return {
    x: clientX - viewportRect.left + dom.canvasViewport.scrollLeft,
    y: clientY - viewportRect.top + dom.canvasViewport.scrollTop,
  };
}

function getColumnAnchorPoint(
  tableId: string,
  columnName: string,
  preferRightSide: boolean,
): CanvasPoint | null {
  const row = findColumnRow(tableId, columnName);
  if (!row) {
    return null;
  }

  const rowRect = row.getBoundingClientRect();
  const viewportRect = dom.canvasViewport.getBoundingClientRect();
  const x =
    (preferRightSide ? rowRect.right : rowRect.left) -
    viewportRect.left +
    dom.canvasViewport.scrollLeft;
  const y =
    rowRect.top -
    viewportRect.top +
    dom.canvasViewport.scrollTop +
    rowRect.height / 2;
  return { x, y };
}

function getTableEdgePoint(table: PlacedTable, isRightSide: boolean): CanvasPoint {
  const card = dom.canvas.querySelector(
    `.table-card[data-instance-id="${table.instanceId}"]`,
  ) as HTMLElement | null;
  const width = card ? card.offsetWidth : 280;
  return {
    x: isRightSide ? table.x + width : table.x,
    y: table.y + 36,
  };
}

function startDraggingTable(event: MouseEvent, tableId: string): void {
  if (event.button !== 0) {
    return;
  }

  const table = getPlacedTableById(tableId);
  if (!table) {
    return;
  }

  dragState = {
    tableId,
    startX: event.clientX,
    startY: event.clientY,
    originX: table.x,
    originY: table.y,
  };

  document.addEventListener("mousemove", handleDragging);
  document.addEventListener("mouseup", stopDragging);
}

function handleDragging(event: MouseEvent): void {
  if (!dragState) {
    return;
  }

  const table = getPlacedTableById(dragState.tableId);
  if (!table) {
    return;
  }

  const deltaX = event.clientX - dragState.startX;
  const deltaY = event.clientY - dragState.startY;
  const maxX = Math.max(20, dom.canvas.scrollWidth - 320);
  const maxY = Math.max(20, dom.canvas.scrollHeight - 260);

  table.x = normalizePosition(dragState.originX + deltaX, maxX);
  table.y = normalizePosition(dragState.originY + deltaY, maxY);

  const card = dom.canvas.querySelector(
    `.table-card[data-instance-id="${table.instanceId}"]`,
  ) as HTMLElement | null;
  if (card) {
    card.style.left = `${table.x}px`;
    card.style.top = `${table.y}px`;
  }
  renderJoinLines();
}

function stopDragging(): void {
  dragState = null;
  document.removeEventListener("mousemove", handleDragging);
  document.removeEventListener("mouseup", stopDragging);
}

function updateTableAlias(tableId: string, inputAlias: string): void {
  const table = getPlacedTableById(tableId);
  if (!table) {
    return;
  }

  const sanitized = sanitizeAlias(inputAlias);
  const aliasToSet = ensureUniqueAlias(tableId, sanitized);
  table.alias = aliasToSet;

  refreshJoinControls();
  updateSelectedColumnsList();
  updateSqlPreview();
}

function sanitizeAlias(alias: string): string {
  const raw = String(alias || "")
    .trim()
    .toUpperCase();
  if (!raw) {
    return "T1";
  }

  const normalized = raw.replace(/[^A-Za-z0-9_]/g, "_");
  if (!/^[A-Za-z_]/.test(normalized)) {
    return `T_${normalized}`;
  }
  return normalized;
}

function ensureUniqueAlias(tableId: string, alias: string): string {
  const used = new Set(
    state.placedTables
      .filter((table) => table.instanceId !== tableId)
      .map((table) => table.alias.toUpperCase()),
  );

  let candidate = alias;
  let index = 2;
  while (used.has(candidate.toUpperCase())) {
    candidate = `${alias}_${index}`;
    index += 1;
  }

  return candidate;
}

function removePlacedTable(tableId: string): void {
  if (columnJoinDragState && columnJoinDragState.fromTableId === tableId) {
    stopColumnJoinDrag(false);
  }
  state.placedTables = state.placedTables.filter(
    (table) => table.instanceId !== tableId,
  );
  state.joins = state.joins.filter(
    (join) => join.leftTableId !== tableId && join.rightTableId !== tableId,
  );
  renderCanvas();
  refreshJoinControls();
  updateSelectedColumnsList();
  updateSqlPreview();
}

function toggleSelectedColumn(
  tableId: string,
  columnName: string,
  selected: boolean,
): void {
  const table = getPlacedTableById(tableId);
  if (!table) {
    return;
  }

  if (selected) {
    if (!table.selectedColumns.includes(columnName)) {
      table.selectedColumns.push(columnName);
    }
  } else {
    table.selectedColumns = table.selectedColumns.filter(
      (column) => column !== columnName,
    );
  }

  updateSelectedColumnsList();
  updateSqlPreview();
}

function refreshJoinControls(): void {
  const tableOptions = state.placedTables.map((table) => ({
    value: table.instanceId,
    label: `${table.alias} (${table.tableName})`,
  }));

  renderSelectOptions(dom.joinLeftTable, tableOptions);
  renderSelectOptions(dom.joinRightTable, tableOptions);
  populateJoinColumnOptions(dom.joinLeftTable, dom.joinLeftColumn);
  populateJoinColumnOptions(dom.joinRightTable, dom.joinRightColumn);
  dom.addJoinBtn.disabled = tableOptions.length < 2;
}

function renderSelectOptions(
  selectElement: HTMLSelectElement,
  options: Array<{ value: string; label: string }>,
): void {
  const previousValue = selectElement.value;
  selectElement.innerHTML = "";

  for (const optionData of options) {
    const option = document.createElement("option");
    option.value = optionData.value;
    option.textContent = optionData.label;
    selectElement.appendChild(option);
  }

  if (options.some((option) => option.value === previousValue)) {
    selectElement.value = previousValue;
  }
}

function populateJoinColumnOptions(
  tableSelect: HTMLSelectElement,
  columnSelect: HTMLSelectElement,
): void {
  const tableId = tableSelect.value;
  const table = getPlacedTableById(tableId);
  const tableDef = table ? getTableDefinition(table) : null;
  const columns = tableDef ? tableDef.columns : [];

  const previousValue = columnSelect.value;
  columnSelect.innerHTML = "";
  for (const column of columns) {
    const option = document.createElement("option");
    option.value = column.name;
    option.textContent = column.name;
    columnSelect.appendChild(option);
  }

  if (columns.some((column) => column.name === previousValue)) {
    columnSelect.value = previousValue;
  }
}

function addManualJoin(): void {
  const leftTableId = dom.joinLeftTable.value;
  const rightTableId = dom.joinRightTable.value;
  const leftColumn = dom.joinLeftColumn.value;
  const rightColumn = dom.joinRightColumn.value;
  const joinType = normalizeJoinType(dom.joinType.value);

  if (!leftTableId || !rightTableId || !leftColumn || !rightColumn) {
    return;
  }

  if (leftTableId === rightTableId) {
    setTemporaryStatus("Manual joins require two table instances");
    return;
  }

  const added = createJoin(
    leftTableId,
    rightTableId,
    [leftColumn],
    [rightColumn],
    joinType,
    "manual",
    "",
  );
  if (!added) {
    return;
  }

  renderJoinLines();
  renderJoinList();
  updateSqlPreview();
}

function renderJoinLines(): void {
  dom.joinLines.innerHTML = "";
  dom.joinLines.setAttribute("width", String(dom.canvas.scrollWidth));
  dom.joinLines.setAttribute("height", String(dom.canvas.scrollHeight));

  for (const join of state.joins) {
    const leftTable = getPlacedTableById(join.leftTableId);
    const rightTable = getPlacedTableById(join.rightTableId);
    if (!leftTable || !rightTable) {
      continue;
    }
    const fromLeftToRight = leftTable.x <= rightTable.x;
    const joinLeftColumn = join.leftColumns[0];
    const joinRightColumn = join.rightColumns[0];

    const startPoint =
      getColumnAnchorPoint(join.leftTableId, joinLeftColumn, fromLeftToRight) ||
      getTableEdgePoint(leftTable, fromLeftToRight);
    const endPoint =
      getColumnAnchorPoint(
        join.rightTableId,
        joinRightColumn,
        !fromLeftToRight,
      ) || getTableEdgePoint(rightTable, !fromLeftToRight);

    const startX = startPoint.x;
    const endX = endPoint.x;
    const startY = startPoint.y;
    const endY = endPoint.y;
    const horizontalDistance = Math.abs(endX - startX);
    const curve = Math.max(45, horizontalDistance / 2);
    const controlA = fromLeftToRight ? startX + curve : startX - curve;
    const controlB = fromLeftToRight ? endX - curve : endX + curve;

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      `M ${startX} ${startY} C ${controlA} ${startY}, ${controlB} ${endY}, ${endX} ${endY}`,
    );
    path.setAttribute(
      "class",
      `join-line ${join.source === "relationship" ? "auto-join" : "manual-join"}`,
    );
    dom.joinLines.appendChild(path);

    const label = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "text",
    );
    const labelX = (startX + endX) / 2;
    const labelY = (startY + endY) / 2 - 6;
    label.setAttribute("x", String(labelX));
    label.setAttribute("y", String(labelY));
    label.setAttribute("class", "join-line-label");
    label.textContent = join.joinType;
    dom.joinLines.appendChild(label);
  }

  if (columnJoinDragState) {
    const start = columnJoinDragState.startPoint;
    const end = columnJoinDragState.currentPoint;
    const fromLeftToRight = end.x >= start.x;
    const horizontalDistance = Math.abs(end.x - start.x);
    const curve = Math.max(35, horizontalDistance / 2);
    const controlA = fromLeftToRight ? start.x + curve : start.x - curve;
    const controlB = fromLeftToRight ? end.x - curve : end.x + curve;

    const draftPath = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "path",
    );
    draftPath.setAttribute(
      "d",
      `M ${start.x} ${start.y} C ${controlA} ${start.y}, ${controlB} ${end.y}, ${end.x} ${end.y}`,
    );
    draftPath.setAttribute("class", "join-line-draft");
    dom.joinLines.appendChild(draftPath);
  }
}

function renderJoinList(): void {
  dom.joinList.innerHTML = "";
  if (state.joins.length === 0) {
    const empty = document.createElement("div");
    empty.className = "join-empty";
    empty.textContent = "No joins defined.";
    dom.joinList.appendChild(empty);
    return;
  }

  for (const join of state.joins) {
    const leftTable = getPlacedTableById(join.leftTableId);
    const rightTable = getPlacedTableById(join.rightTableId);
    if (!leftTable || !rightTable) {
      continue;
    }

    const row = document.createElement("div");
    row.className = "join-row";

    const description = document.createElement("div");
    description.className = "join-row-description";
    description.textContent = `${leftTable.alias}.${join.leftColumns.join(", ")} = ${rightTable.alias}.${join.rightColumns.join(", ")}`;
    row.appendChild(description);

    const actions = document.createElement("div");
    actions.className = "join-row-actions";

    const typeSelect = document.createElement("select");
    ["INNER", "LEFT", "RIGHT", "FULL"].forEach((type) => {
      const option = document.createElement("option");
      option.value = type;
      option.textContent = `${type} JOIN`;
      if (join.joinType === type) {
        option.selected = true;
      }
      typeSelect.appendChild(option);
    });
    typeSelect.addEventListener("change", () => {
      join.joinType = normalizeJoinType(typeSelect.value);
      renderJoinLines();
      updateSqlPreview();
    });
    actions.appendChild(typeSelect);

    const remove = document.createElement("button");
    remove.className = "remove-join-btn";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      state.joins = state.joins.filter((item) => item.joinId !== join.joinId);
      renderJoinLines();
      renderJoinList();
      updateSqlPreview();
    });
    actions.appendChild(remove);

    row.appendChild(actions);
    dom.joinList.appendChild(row);
  }
}

function updateSelectedColumnsList(): void {
  dom.selectedColumnsList.innerHTML = "";
  const entries: string[] = [];

  for (const table of state.placedTables) {
    for (const columnName of table.selectedColumns) {
      entries.push(`${table.alias}.${columnName}`);
    }
  }

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "selected-columns-empty";
    empty.textContent =
      "No columns selected. Query defaults to first-table alias.*";
    dom.selectedColumnsList.appendChild(empty);
    return;
  }

  for (const value of entries) {
    const item = document.createElement("div");
    item.className = "selected-column-item";
    item.textContent = value;
    dom.selectedColumnsList.appendChild(item);
  }
}

function autoLayoutTables(): void {
  const columnsPerRow = 4;
  const cardWidth = 320;
  const cardHeight = 270;
  const xStart = 48;
  const yStart = 48;

  state.placedTables.forEach((table, index) => {
    const col = index % columnsPerRow;
    const row = Math.floor(index / columnsPerRow);
    table.x = xStart + col * cardWidth;
    table.y = yStart + row * cardHeight;
  });

  renderCanvas();
}

function updateSqlPreview(): void {
  dom.sqlPreview.value = generateSql();
}

function generateSql(): string {
  if (state.placedTables.length === 0) {
    return "-- Drag tables to canvas and select columns to generate SQL.";
  }

  const baseTable = state.placedTables[0];
  const selectedColumns = collectSelectedColumns();
  const selectKeyword = state.distinct ? "SELECT DISTINCT" : "SELECT";
  const selectClause =
    selectedColumns.length > 0
      ? selectedColumns.join(",\n    ")
      : `${quoteIdentifier(baseTable.alias)}.*`;

  const joinBuild = buildJoinClauses(baseTable.instanceId);
  const sqlLines: string[] = [];
  sqlLines.push(`${selectKeyword}`);
  sqlLines.push(`    ${selectClause}`);
  sqlLines.push(
    `FROM ${qualifyTable(baseTable)} AS ${quoteIdentifier(baseTable.alias)}`,
  );

  for (const clause of joinBuild.joinClauses) {
    sqlLines.push(clause);
  }

  for (const table of state.placedTables) {
    if (joinBuild.joinedTableIds.has(table.instanceId)) {
      continue;
    }
    sqlLines.push(
      `CROSS JOIN ${qualifyTable(table)} AS ${quoteIdentifier(table.alias)}`,
    );
    joinBuild.joinedTableIds.add(table.instanceId);
  }

  const wherePredicates: string[] = [];
  const userWhere = (state.whereClause || "").trim();
  if (userWhere) {
    wherePredicates.push(`(${userWhere})`);
  }
  for (const predicate of joinBuild.extraPredicates) {
    wherePredicates.push(`(${predicate})`);
  }

  if (wherePredicates.length > 0) {
    sqlLines.push(`WHERE ${wherePredicates.join("\n  AND ")}`);
  }

  const groupBy = (state.groupByClause || "").trim();
  if (groupBy) {
    sqlLines.push(`GROUP BY ${groupBy}`);
  }

  const having = (state.havingClause || "").trim();
  if (having) {
    sqlLines.push(`HAVING ${having}`);
  }

  const orderBy = (state.orderByClause || "").trim();
  if (orderBy) {
    sqlLines.push(`ORDER BY ${orderBy}`);
  }

  const limitRaw = (state.limitValue || "").trim();
  if (limitRaw) {
    const parsedLimit = Number(limitRaw);
    if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
      sqlLines.push(`LIMIT ${Math.floor(parsedLimit)}`);
    }
  }

  return `${sqlLines.join("\n")};`;
}

function collectSelectedColumns(): string[] {
  const expressions: string[] = [];

  for (const table of state.placedTables) {
    for (const columnName of table.selectedColumns) {
      expressions.push(
        `${quoteIdentifier(table.alias)}.${quoteIdentifier(columnName)}`,
      );
    }
  }

  return expressions;
}

function buildJoinClauses(baseTableId: string): {
  joinClauses: string[];
  extraPredicates: string[];
  joinedTableIds: Set<string>;
} {
  const pending = [...state.joins];
  const joinedTableIds = new Set([baseTableId]);
  const joinClauses: string[] = [];
  const extraPredicates: string[] = [];

  let progressed = true;
  while (progressed && pending.length > 0) {
    progressed = false;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const join = pending[index];
      const leftIn = joinedTableIds.has(join.leftTableId);
      const rightIn = joinedTableIds.has(join.rightTableId);
      if (!leftIn && !rightIn) {
        continue;
      }

      const leftTable = getPlacedTableById(join.leftTableId);
      const rightTable = getPlacedTableById(join.rightTableId);
      if (!leftTable || !rightTable) {
        pending.splice(index, 1);
        progressed = true;
        continue;
      }

      const condition = buildJoinCondition(
        join,
        leftTable.alias,
        rightTable.alias,
      );
      if (!condition) {
        pending.splice(index, 1);
        progressed = true;
        continue;
      }

      if (leftIn && rightIn) {
        extraPredicates.push(condition);
        pending.splice(index, 1);
        progressed = true;
        continue;
      }

      const targetTable = leftIn ? rightTable : leftTable;
      joinClauses.push(
        `${join.joinType} JOIN ${qualifyTable(targetTable)} AS ${quoteIdentifier(targetTable.alias)} ON ${condition}`,
      );
      joinedTableIds.add(targetTable.instanceId);
      pending.splice(index, 1);
      progressed = true;
    }
  }

  for (const join of pending) {
    const leftTable = getPlacedTableById(join.leftTableId);
    const rightTable = getPlacedTableById(join.rightTableId);
    if (!leftTable || !rightTable) {
      continue;
    }

    const condition = buildJoinCondition(
      join,
      leftTable.alias,
      rightTable.alias,
    );
    if (condition) {
      extraPredicates.push(condition);
    }
  }

  return { joinClauses, extraPredicates, joinedTableIds };
}

function buildJoinCondition(
  join: VisualQueryBuilderJoin,
  leftAlias: string,
  rightAlias: string,
): string {
  const pairCount = Math.min(join.leftColumns.length, join.rightColumns.length);
  if (pairCount === 0) {
    return "";
  }

  const predicates: string[] = [];
  for (let index = 0; index < pairCount; index += 1) {
    const leftColumn = join.leftColumns[index];
    const rightColumn = join.rightColumns[index];
    predicates.push(
      `${quoteIdentifier(leftAlias)}.${quoteIdentifier(leftColumn)} = ${quoteIdentifier(rightAlias)}.${quoteIdentifier(rightColumn)}`,
    );
  }
  return predicates.join(" AND ");
}

function qualifyTable(table: PlacedTable): string {
  return `${quoteIdentifier(table.database)}.${quoteIdentifier(table.schema)}.${quoteIdentifier(table.tableName)}`;
}

function quoteIdentifier(identifier: string): string {
  if (!identifier) return identifier;
  // Check if name contains only uppercase letters, digits, and underscores
  // and starts with a letter or underscore
  const isSimpleIdentifier =
    /^[A-Z_][A-Z0-9_]*$/i.test(identifier) &&
    identifier === identifier.toUpperCase();
  if (isSimpleIdentifier) {
    return identifier;
  }
  // Quote name and double internal quotes
  const value = String(identifier).replace(/"/g, '""');
  return `"${value}"`;
}

function getPlacedTableById(tableId: string): PlacedTable | undefined {
  return state.placedTables.find((table) => table.instanceId === tableId);
}

function getTableDefinition(
  tableInstance: PlacedTable,
): VisualQueryBuilderTable | undefined {
  return state.data.tables.find(
    (table) =>
      table.tableName === tableInstance.tableName &&
      table.schema === tableInstance.schema &&
      table.database === tableInstance.database,
  );
}
