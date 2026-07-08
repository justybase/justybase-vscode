// Init module - Main initialization and entry point for result panel
import { ensureSearchWorkerDataAsync, GLOBAL_FILTER_WORKER_ROW_THRESHOLD } from "./searchWorkerBridge.js";
import { injectStyles } from "./styles.js";
import {
  setActiveGridIndex,
  initializeWindowState,
  setSearchWorker,
  setSearchMatches,
  setIsSearching,
  getActiveGridIndex,
  getSearchWorker,
  getGrid,
  setRowViewOpen,
  getRowViewOpen,
  getGlobalFilterState,
  setGlobalFilterState,
  getIsEditMode,
  setIsEditMode,
  getPendingEdits,
  clearPendingEdits,
  getPendingDeletes,
  clearPendingDeletes,
  resetEditSession,
  addPendingEdit,
  markRowForDelete,
  isRowMarkedForDelete,
  setGlobalDragState,
  getGlobalDragState,
} from "./state.js";
import { debounce, showError } from "./utils.js";
import {
  setupStreamingMessageHandler,
  cancelActiveQuery,
  updateExecutionStatusBanner,
  handleSaveScrollState,
} from "./messages.js";
import {
  renderDocIndicator,
  renderResultSetTabs,
  switchToResultSet,
  updateLogsTabSpinner,
} from "./tabs.js";
import { subscribeRunningUiRefresh } from "./runningUiDelay.js";
import {
  renderGrids,
  updateLoadingState,
  dismissLoadingOverlay,
  scrollToColumn,
  populateColumnSearchList,
} from "./grid.js";
import { renderRowCountInfo, reorderColumnByDrag, reorderColumnsForPinning } from "./filter.js";
import { closeRowView, syncRowViewToolbarButton } from "./rowView.js";
import { refreshDiskQueryWindow } from "./diskBackedGrid.js";
import {
  getActiveResultViewMode,
  initializeAnalysisModeControls,
  setActiveResultViewMode,
  syncAnalysisView,
} from "./analysis.js";
import {
  openResultFormattingPanel,
  closeResultFormattingPanel,
} from "./formatting.js";
import {
  openRangeChartModal,
  closeRangeChartModal,
  canCreateRangeChart,
  openRangeChartFromToolbar,
  openRangeChartForActiveResult,
} from "./rangeChart.js";
import {
  clearLogs,
  openInExcel,
  openInExcelXlsx,
  copyAsExcel,
  exportToCsv,
  exportToJson,
  exportToXml,
  exportToSqlInsert,
  exportToMarkdown,
  openInFilePreview,
  onDropGroup,
  onDragOverGroup,
  onDragLeaveGroup,
  clearGroupDropTargets,
  handleClickExport,
  toggleExportPrimaryMenu,
  handleClickQueryLocallyDuckDB,
  setGlobalDragStateForExport,
  exportAllVisibleToCsv,
  exportAllVisibleToJson,
  exportAllVisibleToXml,
  exportAllVisibleToSqlInsert,
  exportAllVisibleToMarkdown,
  exportAllVisibleToExcel,
  exportSelectionToCsv,
  exportSelectionToJson,
  exportSelectionToExcel,
  exportAllResultSetsToExcel,
  exportToMdFile,
} from "./export.js";
import { postHostMessage, getHostState, setHostState } from './protocol.js';
import { prepareDiskFilterWindow } from './diskBackedGrid.js';
import { asHtml, getElementById } from './dom.js';
import {
  callPanelMethod,
  getActiveSourceUri,
  getResultPanelWindow,
  getResultSetAt,
  getResultSets,
  setActiveSourceUri,
  setResultSets,
} from './types.js';
import type { CellDescriptor, ColumnSearchMapItem, ResultSet, TanStackColumn, TanStackTable } from './types.js';

declare const workerUri: string | undefined;
declare function setViewMode(mode: string): void;

interface ValueViewerPayload {
  columnName?: string;
  dataType?: string;
  rowNumber?: number;
  value?: unknown;
  isNull?: boolean;
}

const vscode = { postMessage: postHostMessage };

function getCanvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context unavailable');
  }
  return ctx;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Initialize search worker
function initializeSearchWorker() {
  if (typeof workerUri !== "undefined") {
    try {
      fetch(workerUri)
        .then((response) => response.text())
        .then((code) => {
          const blob = new Blob([code], { type: "application/javascript" });
          const blobUrl = URL.createObjectURL(blob);
          const searchWorker = new Worker(blobUrl);

          searchWorker.onmessage = function (e) {
            const { command, id, matchedIndices, seq } = e.data;
            if (command === "searchResult") {
              if (seq !== undefined && seq !== globalFilterSearchSeq) {
                return;
              }

              setIsSearching(false);
              updateGlobalFilterSearchUi(false);

              if (matchedIndices === null) {
                setSearchMatches(id, null);
              } else {
                setSearchMatches(id, new Set(matchedIndices));
              }

              const grid = getGrid(id);
              if (grid && grid.tanTable) {
                const resultSet = getResultSets()[id] ?? null;
                const currentGlobal = getGlobalFilterState(
                  id,
                  resultSet ? resultSet.executionTimestamp : undefined,
                  getActiveSourceUri(),
                );
                if (resultSet?.storageMode === 'sqlite' && matchedIndices !== null) {
                  prepareDiskFilterWindow(id);
                }
                grid.tanTable.setGlobalFilter(currentGlobal);
                if (grid.render) {
                  grid.render();
                }
                if (resultSet?.storageMode === 'sqlite' && matchedIndices !== null) {
                  grid.scrollToIndex?.(0, 'auto');
                }
              }

              renderRowCountInfo(id);
            } else if (command === "setDataDone") {
              // Data loaded in worker
            }
          };

    // Initialize search worker (data loaded on first global-filter search)
          setSearchWorker(searchWorker);
        })
        .catch((err) => {
          console.error("Failed to initialize search worker:", err);
        });
    } catch (e) {
      console.error("Error creating worker:", e);
    }
  }
}

// Setup cancel button handler
function setupCancelButton() {
  const cancelBtn = getElementById("cancelQueryBtn");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      cancelActiveQuery();
    });
  }
}

export function setupHideLoadingOverlayButton(): void {
  const hideBtn = getElementById("hideLoadingOverlayBtn");
  if (!hideBtn || hideBtn.dataset.hideWired === "1") {
    return;
  }

  hideBtn.dataset.hideWired = "1";
  hideBtn.addEventListener("click", () => {
    dismissLoadingOverlay();
    const logIndex = getResultSets().findIndex((resultSet) => resultSet?.isLog);
    if (logIndex >= 0) {
      switchToResultSet(logIndex);
    }
    updateExecutionStatusBanner();
  });
}

export function setupExecutionStatusBanner(): void {
  const cancelBtn = getElementById("executionStatusBannerCancel");
  if (!cancelBtn || cancelBtn.dataset.cancelWired === "1") {
    return;
  }

  cancelBtn.dataset.cancelWired = "1";
  cancelBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    cancelActiveQuery();
  });
}

// Setup global keyboard shortcuts
function isInputLikeElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

function setupWebviewFocusContexts() {
  let lastResultsFocused: boolean | null = null;
  let lastInputFocused: boolean | null = null;

  const postResultsFocused = (focused: boolean): void => {
    if (lastResultsFocused === focused) {
      return;
    }

    lastResultsFocused = focused;
    vscode.postMessage({ command: focused ? "webviewFocused" : "webviewBlurred" });
  };

  const postInputFocused = (focused: boolean): void => {
    if (lastInputFocused === focused) {
      return;
    }

    lastInputFocused = focused;
    vscode.postMessage({
      command: "setContext",
      key: "netezza.resultsInputFocused",
      value: focused,
    });
  };

  const syncInputFocus = () => {
    postInputFocused(isInputLikeElement(document.activeElement));
  };

  window.addEventListener("focus", () => {
    postResultsFocused(true);
    syncInputFocus();
  });

  window.addEventListener("focusin", () => {
    postResultsFocused(true);
    syncInputFocus();
  });

  document.addEventListener("focusout", () => {
    queueMicrotask(syncInputFocus);
  });

  window.addEventListener("blur", () => {
    postResultsFocused(false);
    postInputFocused(false);
  });

  postResultsFocused(document.hasFocus());
  syncInputFocus();
}

function setupGlobalKeyboardShortcuts() {
  setupWebviewFocusContexts();

	if (getResultPanelWindow().justybaseUseHostCopyShortcut) {
		return;
	}

	// Ctrl+C to copy selection
	document.addEventListener("keydown", function (e) {
		if ((e.ctrlKey || e.metaKey) && e.key === "c") {
			const grid = getGrid(getActiveGridIndex());
			if (grid && grid.hasSelection && grid.hasSelection()) {
				e.preventDefault();
				e.stopPropagation();
				grid.copySelection?.(true);
			}
		}
	});

	// Note: Ctrl+A is NOT handled here - use the "Select All" button in the toolbar
	// This prevents interference with SQL editor and chat
}

window.addEventListener('keydown', function(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
    if (isInputLikeElement(e.target)) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    callPanelMethod("selectAll");
  }
});

const GLOBAL_FILTER_DEBOUNCE_MS = 50;
let globalFilterSearchSeq = 0;

function updateGlobalFilterSearchUi(searching: boolean): void {
  const filterInput = getElementById<HTMLInputElement>("globalFilter");
  if (filterInput) {
    filterInput.classList.toggle("is-searching", searching);
    filterInput.setAttribute("aria-busy", searching ? "true" : "false");
  }
  const rowCountInfo = getElementById("rowCountInfo");
  if (rowCountInfo) {
    rowCountInfo.classList.toggle("is-searching", searching);
  }
}

async function runWorkerGlobalFilter(
  activeIndex: number,
  value: string,
  searchSeq: number,
): Promise<void> {
  const searchWorker = getSearchWorker();
  if (!searchWorker) {
    setIsSearching(false);
    updateGlobalFilterSearchUi(false);
    renderRowCountInfo(activeIndex);
    return;
  }

  const loaded = await ensureSearchWorkerDataAsync(activeIndex);
  if (searchSeq !== globalFilterSearchSeq) {
    return;
  }

  if (!loaded) {
    setIsSearching(false);
    updateGlobalFilterSearchUi(false);
    renderRowCountInfo(activeIndex);
    return;
  }

  searchWorker.postMessage({
    command: "search",
    id: activeIndex,
    query: value,
    seq: searchSeq,
  });
}

function applyGlobalFilter(value: string): void {
  const activeIndex = getActiveGridIndex();
  const viewMode = getActiveResultViewMode(activeIndex);
  const activeResult = getResultSetAt(activeIndex) ?? null;
  const executionTimestamp = activeResult
    ? activeResult.executionTimestamp
    : undefined;
  const rowCount = activeResult?.storageMode === 'sqlite'
    ? (activeResult.totalRowCount ?? 0)
    : (Array.isArray(activeResult?.data) ? activeResult.data.length : 0);
  const useWorkerSearch =
    rowCount >= GLOBAL_FILTER_WORKER_ROW_THRESHOLD && Boolean(getSearchWorker());

  setGlobalFilterState(
    activeIndex,
    value,
    executionTimestamp,
    getActiveSourceUri(),
  );

  const grid = getGrid(activeIndex);
  if (!grid || !grid.tanTable) {
    return;
  }

  if (activeResult?.storageMode === 'sqlite') {
    globalFilterSearchSeq++;
    setIsSearching(false);
    updateGlobalFilterSearchUi(false);
    setSearchMatches(activeIndex, null);
    // onGlobalFilterChange refreshes the SQLite window; avoid duplicate refresh here.
    grid.tanTable.setGlobalFilter(value);
    renderRowCountInfo(activeIndex);
    return;
  }

  if (!value) {
    globalFilterSearchSeq++;
    setIsSearching(false);
    updateGlobalFilterSearchUi(false);
    setSearchMatches(activeIndex, null);
    grid.tanTable.setGlobalFilter("");
    if (grid.render) {
      grid.render();
    }
    renderRowCountInfo(activeIndex);
    return;
  }

  if (!useWorkerSearch) {
    setIsSearching(false);
    setSearchMatches(activeIndex, null);
    grid.tanTable.setGlobalFilter(value);
    if (grid.render) {
      grid.render();
    }
    renderRowCountInfo(activeIndex);
    return;
  }

  const searchSeq = ++globalFilterSearchSeq;
  setIsSearching(true);
  updateGlobalFilterSearchUi(true);
  renderRowCountInfo(activeIndex);

  void runWorkerGlobalFilter(activeIndex, value, searchSeq);
}

const debouncedSearch = debounce((value: unknown) => {
  applyGlobalFilter(typeof value === 'string' ? value : '');
}, GLOBAL_FILTER_DEBOUNCE_MS);

export function onGlobalFilterChanged(): void {
  const filterInput = getElementById<HTMLInputElement>("globalFilter");
  const value = filterInput ? filterInput.value : "";
  if (!value.trim()) {
    debouncedSearch.cancel();
    applyGlobalFilter("");
    return;
  }
  debouncedSearch(value);
}

// Row view functions
export function toggleRowView(): void {
  if (getRowViewOpen()) {
    closeRowView();
    return;
  }

  setRowViewOpen(true);
  syncRowViewToolbarButton(true);
  const panel = getElementById("rowViewPanel");
  if (!panel) {
    return;
  }

  panel.classList.add("visible");
  updateRowView();
}

const _viewerPayloads = new WeakMap<HTMLElement, ValueViewerPayload | CellDescriptor | null>();

function renderValueViewerContent(payload: ValueViewerPayload | CellDescriptor | null | undefined): void {
  const title = getElementById("valueViewerTitle");
  const meta = getElementById("valueViewerMeta");
  const body = getElementById("valueViewerBody");
  if (!title || !meta || !body) {
    return;
  }

  title.textContent = payload?.columnName
    ? `Cell Value: ${payload.columnName}`
    : "Cell Value";
  const metaParts: string[] = [];
  if (payload?.dataType) {
    metaParts.push(`Type: ${payload.dataType}`);
  }
  if (payload?.rowNumber !== undefined) {
    metaParts.push(`Row: ${payload.rowNumber}`);
  }
  meta.textContent = metaParts.join(" | ");

  if (payload?.isNull) {
    body.innerHTML = '<div class="value-viewer-null">NULL</div>';
    return;
  }

  const value =
    payload?.value === undefined || payload?.value === null
      ? ""
      : String(payload.value);
  body.innerHTML = "";

  const pre = document.createElement("pre");
  pre.className = "value-viewer-pre";
  pre.textContent = value;
  body.appendChild(pre);
}

export function closeValueViewer(): void {
  const overlay = getElementById("valueViewerOverlay");
  if (overlay) {
    overlay.classList.remove("visible");
  }
}

export function openValueViewer(payload: ValueViewerPayload | CellDescriptor | null | undefined): void {
  const overlay = getElementById("valueViewerOverlay");
  if (!overlay) {
    return;
  }

  _viewerPayloads.set(overlay, payload || null);
  renderValueViewerContent(payload);
  overlay.classList.add("visible");
}

function navigateToResultColumn(colId: string, colName?: string): void {
  const input = getElementById<HTMLInputElement>("columnSearch");
  const dropdown = getElementById("columnSearchDropdown");
  if (input && colName !== undefined) {
    input.value = colName;
  }
  if (dropdown) {
    dropdown.style.display = "none";
  }
  scrollToColumn(getActiveGridIndex(), colId);
}

function getSidebarTypePresentation(typeStr: string): { typeClass: string; displayType: string } {
  const upper = (typeStr || "TEXT").toUpperCase();
  if (/^(INT|BIGINT|SMALLINT|TINYINT|FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL|NUMBER)/.test(upper)) {
    return { typeClass: "type-number", displayType: "NUMB" };
  }
  if (/^(DATE|TIME|TIMESTAMP)/.test(upper)) {
    return { typeClass: "type-temporal", displayType: "TEMP" };
  }
  if (/^(BOOL)/.test(upper)) {
    return { typeClass: "type-bool", displayType: "BOOL" };
  }
  return { typeClass: "type-text", displayType: "TEXT" };
}

interface SidebarSchemaColumn {
  id: string;
  label: string;
  type: string;
  isVisible: boolean;
  tableColumn: TanStackColumn | null;
}

function getSidebarSchemaColumns(
  rs: ResultSet,
  table: TanStackTable | null | undefined,
): SidebarSchemaColumn[] {
  if (!table) {
    return rs.columns.map((col, idx) => ({
      id: String(idx),
      label: col.name || `Col ${idx}`,
      type: col.type || "TEXT",
      isVisible: true,
      tableColumn: null,
    }));
  }

  const allColumns = table.getAllColumns();
  const columnOrder = table.getState().columnOrder?.length
    ? table.getState().columnOrder!
    : allColumns.map((col) => col.id);
  const knownIds = new Set(columnOrder);
  const orderedIds = [
    ...columnOrder,
    ...allColumns.map((col) => col.id).filter((id) => !knownIds.has(id)),
  ];

  return orderedIds.map((id) => {
    const tableColumn = allColumns.find((col) => col.id === id) ?? null;
    const rsIndex = Number.parseInt(id, 10);
    const rsCol = Number.isFinite(rsIndex) ? rs.columns[rsIndex] : undefined;
    return {
      id,
      label: tableColumn?.columnDef?.header
        ? String(tableColumn.columnDef.header)
        : (rsCol?.name || `Col ${id}`),
      type: rsCol?.type || tableColumn?.columnDef?.dataType || "TEXT",
      isVisible: tableColumn ? tableColumn.getIsVisible() : true,
      tableColumn,
    };
  });
}

function clearSidebarSchemaDropMarkers(): void {
  document.querySelectorAll(".sidebar-schema-item.drag-over-before, .sidebar-schema-item.drag-over-after")
    .forEach((item) => {
      item.classList.remove("drag-over-before", "drag-over-after");
    });
}

// Render sidebar schema list from active result set columns
function renderSidebarSchema(): void {
  const list = getElementById("sidebarSchemaList");
  if (!list) return;
  list.innerHTML = "";
  const activeIndex = getActiveGridIndex();
  const rs = getResultSetAt(activeIndex) ?? null;
  if (!rs || !rs.columns) return;

  const grid = getGrid(activeIndex);
  const table = grid?.tanTable ?? null;
  const columns = getSidebarSchemaColumns(rs, table);

  columns.forEach((column) => {
    const item = document.createElement("div");
    item.className = "sidebar-schema-item" + (column.isVisible ? "" : " is-hidden");
    const { typeClass, displayType } = getSidebarTypePresentation(column.type);
    item.title = "Drag to reorder or group · click name to scroll";
    item.draggable = true;
    item.dataset.colId = column.id;
    item.setAttribute("role", "listitem");

    const visibilityCheckbox = document.createElement("input");
    visibilityCheckbox.type = "checkbox";
    visibilityCheckbox.className = "sidebar-schema-visibility";
    visibilityCheckbox.checked = column.isVisible;
    visibilityCheckbox.disabled = !column.tableColumn;
    visibilityCheckbox.setAttribute("aria-label", `Show ${column.label}`);
    visibilityCheckbox.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    visibilityCheckbox.addEventListener("change", () => {
      column.tableColumn?.toggleVisibility(visibilityCheckbox.checked);
      item.classList.toggle("is-hidden", !visibilityCheckbox.checked);
    });

    const typeBadge = document.createElement("span");
    typeBadge.className = "sidebar-schema-type " + typeClass;
    typeBadge.textContent = displayType;

    const colName = document.createElement("span");
    colName.className = "sidebar-schema-name";
    colName.textContent = column.label;
    colName.title = "Scroll to column";
    colName.setAttribute("role", "button");
    colName.tabIndex = 0;

    let suppressNavigate = false;
    item.addEventListener("dragstart", (event) => {
      const dataTransfer = event.dataTransfer;
      if (!dataTransfer) {
        return;
      }
      suppressNavigate = true;
      dataTransfer.setData("text/plain", column.label);
      dataTransfer.setData("type", "column");
      dataTransfer.setData("columnId", column.id);
      dataTransfer.setData("columnName", column.label);
      dataTransfer.effectAllowed = "copyMove";
      item.classList.add("dragging");
      setGlobalDragState({ isDragging: true, dragType: "column", draggedItem: column.id });
    });
    item.addEventListener("dragend", () => {
      item.classList.remove("dragging");
      clearSidebarSchemaDropMarkers();
      setGlobalDragState({ isDragging: false, dragType: null, draggedItem: null });
      clearGroupDropTargets();
      setTimeout(() => {
        suppressNavigate = false;
      }, 0);
    });
    item.addEventListener("dragover", (event) => {
      const dragState = getGlobalDragState();
      if (dragState.dragType !== "column" || !dragState.draggedItem || dragState.draggedItem === column.id) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      const rect = item.getBoundingClientRect();
      const insertBefore = event.clientY < rect.top + rect.height / 2;
      clearSidebarSchemaDropMarkers();
      item.classList.add(insertBefore ? "drag-over-before" : "drag-over-after");
    });
    item.addEventListener("dragleave", (event) => {
      if (event.relatedTarget instanceof Node && item.contains(event.relatedTarget)) {
        return;
      }
      item.classList.remove("drag-over-before", "drag-over-after");
    });
    item.addEventListener("drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
      item.classList.remove("drag-over-before", "drag-over-after");
      const draggedColId = event.dataTransfer?.getData("columnId");
      if (!draggedColId || !table || draggedColId === column.id) {
        return;
      }
      const rect = item.getBoundingClientRect();
      const insertBefore = event.clientY < rect.top + rect.height / 2;
      if (reorderColumnByDrag(table, draggedColId, column.id, insertBefore)) {
        reorderColumnsForPinning(table, activeIndex, rs.executionTimestamp);
      }
    });

    const activateColumn = () => {
      if (suppressNavigate) {
        return;
      }
      navigateToResultColumn(column.id, column.label);
    };
    colName.addEventListener("click", (event) => {
      event.stopPropagation();
      activateColumn();
    });
    colName.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activateColumn();
      }
    });

    item.appendChild(visibilityCheckbox);
    item.appendChild(typeBadge);
    item.appendChild(colName);
    list.appendChild(item);
  });
}

// Entry point for resultPanelView.ts
export function init(): void {
  try {
    // Inject styles
    injectStyles();

    // Initialize window state
    initializeWindowState();

    // Initialize search worker
    initializeSearchWorker();

    // Render components
    renderDocIndicator(getActiveSourceUri());
    renderResultSetTabs();
    renderGrids();
    updateLoadingState();
    initializeAnalysisModeControls();
    syncAnalysisView();

    // Render sidebar schema if in sidebar mode
    if (document.body.classList.contains("sidebar-layout")) {
      renderSidebarSchema();
    }

    // Setup handlers
    setupGlobalKeyboardShortcuts();
    setupStreamingMessageHandler();
    subscribeRunningUiRefresh(() => {
      updateExecutionStatusBanner();
    });
    setupCancelButton();
    setupHideLoadingOverlayButton();
    setupExecutionStatusBanner();

    // Switch to correct grid if not default
    if (getActiveGridIndex() !== 0) {
      switchToResultSet(getActiveGridIndex());
    }

    // Signal ready to extension — wait for fonts to avoid FOUT (flash of wrong font/styling)
    // on large datasets where thousands of cells render with fallback font first.
    (document.fonts ? document.fonts.ready : Promise.resolve()).then(function () {
        setTimeout(function () { vscode.postMessage({ command: "ready" }); }, 20);
    });

    // Setup beforeunload handler to save scroll state when webview is hidden/destroyed
    window.addEventListener("beforeunload", () => {
      handleSaveScrollState();
    });

    // Also save on visibilitychange as a backup
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        handleSaveScrollState();
      }
    });
  } catch (e) {
    showError("Initialization error: " + getErrorMessage(e));
    console.error("[resultPanel.js] Initialization error:", e);
  }
}

// Update row view content
function updateRowView(): void {
  const grid = getGrid(getActiveGridIndex());
  if (!getRowViewOpen() || !grid?.tanTable) {
    return;
  }

  const content = getElementById("rowViewContent");
  if (!content) {
    return;
  }
  const table = grid.tanTable;

  // Get unique selected row indices
  const selectedRows = new Set<number>();
  const selectedCells = document.querySelectorAll(".selected-cell");

  selectedCells.forEach((cell) => {
    const htmlCell = asHtml(cell);
    const cellId = htmlCell?.dataset.cellId;
    if (!cellId) return;
    const [rowIdx] = cellId.split("-").map(Number);
    selectedRows.add(rowIdx);
  });

  const rowIndices = Array.from(selectedRows).sort((a, b) => a - b);

  if (rowIndices.length === 0) {
    content.innerHTML =
      '<div class="row-view-placeholder">Select 1 to 10 rows to view details or compare</div>';
    return;
  }

  if (rowIndices.length > 10) {
    content.innerHTML =
      '<div class="row-view-placeholder">Select 1 to 10 rows to compare</div>';
    return;
  }

  const rows = table.getRowModel().rows;
  const columns = table.getAllColumns().filter((col) => col.getIsVisible());

  function fmtType(dt: string | undefined): string {
    if (!dt) return '';
    var lower = dt.toLowerCase();
    if (lower.indexOf('int') >= 0 || lower.indexOf('dec') >= 0 || lower.indexOf('float') >= 0 || lower.indexOf('num') >= 0) return 'num';
    if (lower.indexOf('char') >= 0 || lower.indexOf('text') >= 0 || lower.indexOf('varchar') >= 0) return 'txt';
    if (lower.indexOf('date') >= 0 || lower.indexOf('time') >= 0) return 'dt';
    if (lower.indexOf('bool') >= 0) return 'bool';
    return 'oth';
  }

  function fmtVal(val: unknown, dt: string | undefined): string {
    if (val === null || val === undefined) return '<span class="row-view-val null">NULL</span>';
    var lower = (dt || '').toLowerCase();
    if (lower.indexOf('bool') >= 0) {
      return val ? '<span class="row-view-val boolean-t">✓ true</span>' : '<span class="row-view-val boolean-f">✕ false</span>';
    }
    if (lower.indexOf('int') >= 0 || lower.indexOf('dec') >= 0 || lower.indexOf('float') >= 0 || lower.indexOf('num') >= 0) {
      if (typeof val === 'number') return '<span class="row-view-val number">' + val.toLocaleString() + '</span>';
      return '<span class="row-view-val number">' + val + '</span>';
    }
    if (lower.indexOf('date') >= 0 || lower.indexOf('time') >= 0) {
      return '<span class="row-view-val date">' + val + '</span>';
    }
    return '<span class="row-view-val">' + String(val).replace(/</g, '&lt;') + '</span>';
  }

  var html = '<div class="row-view-table">';

  columns.forEach(function (col) {
    var values = rowIndices.map(function (rowIndex) {
      return rows[rowIndex].getValue(col.id);
    });

    var isDiff = false;
    if (rowIndices.length > 1) {
      var firstVal = String(values[0] ?? '');
      isDiff = values.some(function (v) { return String(v ?? '') !== firstVal; });
    }

    html += '<div class="row-view-section' + (isDiff ? ' diff' : '') + '">';
    html += '<div class="row-view-key">';
    html += '<span class="row-view-key-name">' + col.columnDef.header + '</span>';
    html += '<span class="row-view-key-type">' + fmtType(col.columnDef.dataType) + '</span>';
    html += '</div>';
    html += '<div class="row-view-vals">';
    values.forEach(function (val, vi) {
      if (rowIndices.length > 1) {
        html += '<span class="row-view-val label' + (isDiff ? ' diff' : '') + '">Row ' + (vi + 1) + '</span>';
      }
      html += fmtVal(val, col.columnDef.dataType);
    });
    html += '</div></div>';
  });

  html += '</div>';
  content.innerHTML = html;
}

// Row view export functions
function getSelectedRowIndices() {
  var selectedRows = new Set<number>();
  document.querySelectorAll(".selected-cell").forEach(function (cell) {
    var htmlCell = asHtml(cell);
    var cellId = htmlCell?.dataset.cellId;
    if (!cellId) return;
    var parts = cellId.split("-");
    selectedRows.add(parseInt(parts[0], 10));
  });
  return Array.from(selectedRows).sort(function (a, b) { return a - b; });
}

function hasRowViewData() {
  var content = getElementById("rowViewContent");
  return content
    && !content.querySelector(".row-view-placeholder")
    && content.querySelector(".row-view-table");
}

async function copyRowViewAsMarkdown() {
  if (!hasRowViewData()) return;
  var activeIndex = getActiveGridIndex();
  var table = getGrid(activeIndex)?.tanTable;
  if (!table) return;

  var rowIndices = getSelectedRowIndices();
  if (rowIndices.length === 0 || rowIndices.length > 10) return;

  var columns = table.getAllColumns().filter(function (col) { return col.getIsVisible(); });
  var rows = table.getRowModel().rows;

  var md = "| " + columns.map(function (col) { return col.columnDef.header; }).join(" | ") + " |\n";
  md += "| " + columns.map(function () { return "---"; }).join(" | ") + " |\n";

  rowIndices.forEach(function (ri) {
    var row = rows[ri];
    if (!row) return;
    md += "| " + columns.map(function (col) {
      var val = row.getValue(col.id);
      if (val === null || val === undefined) return "NULL";
      return String(val).replace(/\|/g, "\\|");
    }).join(" | ") + " |\n";
  });

  try {
    await navigator.clipboard.writeText(md);
    vscode.postMessage({ command: "info", text: "Row view copied as Markdown" });
  } catch (_err) {
    vscode.postMessage({ command: "info", text: "Failed to copy to clipboard" });
  }
}

async function copyRowViewAsImage() {
  if (!hasRowViewData()) return;
  var activeIndex = getActiveGridIndex();
  var table = getGrid(activeIndex)?.tanTable;
  if (!table) return;

  var rowIndices = getSelectedRowIndices();
  if (rowIndices.length === 0 || rowIndices.length > 10) return;

  var columns = table.getAllColumns().filter(function (col) { return col.getIsVisible(); });
  var rows = table.getRowModel().rows;

  // Read theme colors from computed styles
  var bodyStyle = getComputedStyle(document.body);
  var readCSS = function (prop: string, fallback: string): string {
    var v = bodyStyle.getPropertyValue(prop).trim();
    return v || fallback;
  };
  var bg = readCSS("--vscode-editor-background", "#1e1e1e");
  var fg = readCSS("--vscode-editor-foreground", "#cccccc");
  var border = readCSS("--vscode-panel-border", "#333333");
  var badgeBg = readCSS("--vscode-badge-background", "#4a4a4a");
  var badgeFg = readCSS("--vscode-badge-foreground", "#ffffff");
  var blue = readCSS("--vscode-charts-blue", "#519aba");
  var green = readCSS("--vscode-charts-green", "#89d185");
  var dim = readCSS("--vscode-descriptionForeground", "#888888");
  var purple = "#d8b4fe";

  // Layout constants
  var pad = 14;
  var cellH = 34;
  var keyW = 140;
  var badgeW = 32;
  var gap = 6;
  var font = "12px " + (getComputedStyle(getElementById("rowViewContent") ?? document.body).fontFamily || "monospace");
  var fontBold = "600 12px " + (getComputedStyle(getElementById("rowViewContent") ?? document.body).fontFamily || "monospace");

  // Calculate width and height
  var totalW = 460;
  var totalH = pad * 2 + columns.length * cellH;

  // Create canvas with 2x scale
  var dpr = window.devicePixelRatio || 2;
  var canvas = document.createElement("canvas");
  canvas.width = totalW * dpr;
  canvas.height = totalH * dpr;
  var ctx = getCanvasContext(canvas);
  ctx.scale(dpr, dpr);

  // Helpers
  function getValColor(val: unknown, dt: string | undefined): string {
    if (val === null || val === undefined) return dim;
    var t = (dt || "").toLowerCase();
    if (t.indexOf("bool") >= 0) return val ? green : dim;
    if (t.indexOf("int") >= 0 || t.indexOf("dec") >= 0 || t.indexOf("float") >= 0 || t.indexOf("num") >= 0) return blue;
    if (t.indexOf("date") >= 0 || t.indexOf("time") >= 0) return purple;
    return fg;
  }

  function fmtVal(val: unknown, dt: string | undefined): string {
    if (val === null || val === undefined) return "NULL";
    var t = (dt || "").toLowerCase();
    if (t.indexOf("bool") >= 0) return val ? "true" : "false";
    if (t.indexOf("int") >= 0 || t.indexOf("dec") >= 0 || t.indexOf("float") >= 0 || t.indexOf("num") >= 0) {
      if (typeof val === "number") return val.toLocaleString();
      return String(val);
    }
    return String(val);
  }

  function fmtType(dt: string | undefined): string {
    if (!dt) return "";
    var lower = dt.toLowerCase();
    if (lower.indexOf("int") >= 0 || lower.indexOf("dec") >= 0 || lower.indexOf("float") >= 0 || lower.indexOf("num") >= 0) return "num";
    if (lower.indexOf("char") >= 0 || lower.indexOf("text") >= 0 || lower.indexOf("varchar") >= 0) return "txt";
    if (lower.indexOf("date") >= 0 || lower.indexOf("time") >= 0) return "dt";
    if (lower.indexOf("bool") >= 0) return "bool";
    return "";
  }

  function roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // Draw background
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, totalW, totalH);

  // Draw each column section
  columns.forEach(function (col, i) {
    var y = pad + i * cellH;

    // Alternating row tint
    if (i % 2 === 1) {
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      ctx.fillRect(0, y, totalW, cellH);
    }

    // Bottom border
    ctx.strokeStyle = border;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y + cellH);
    ctx.lineTo(totalW, y + cellH);
    ctx.stroke();

    // Column name
    var name = col.columnDef.header || col.id;
    ctx.fillStyle = fg;
    ctx.font = fontBold;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(name, pad, y + cellH / 2);

    // Type badge
    var typeLabel = fmtType(col.columnDef.dataType);
    if (typeLabel) {
      ctx.font = "9px " + (getComputedStyle(getElementById("rowViewContent") ?? document.body).fontFamily || "monospace");
      var nameW = ctx.measureText(name).width;
      var badgeX = pad + Math.min(nameW + 8, keyW - badgeW - 4);
      var badgeH = 16;
      var badgeY = y + (cellH - badgeH) / 2;
      ctx.fillStyle = badgeBg;
      roundRect(ctx, badgeX, badgeY, badgeW, badgeH, 3);
      ctx.fill();
      ctx.fillStyle = badgeFg;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(typeLabel, badgeX + badgeW / 2, y + cellH / 2);
      ctx.textAlign = "left";
    }

    // Values
    var values = rowIndices.map(function (ri) {
      return rows[ri] ? rows[ri].getValue(col.id) : null;
    });

    var valueX = pad + keyW + gap;

    if (rowIndices.length === 1) {
      // Single row - draw value directly
      var val = values[0];
      ctx.fillStyle = getValColor(val, col.columnDef.dataType);
      ctx.font = font;
      ctx.textBaseline = "middle";
      var display = fmtVal(val, col.columnDef.dataType);
      if (val === null || val === undefined) {
        ctx.font = "italic 12px " + (getComputedStyle(getElementById("rowViewContent") ?? document.body).fontFamily || "monospace");
      }
      ctx.fillText(display, valueX, y + cellH / 2, totalW - valueX - pad);
    } else {
      // Multiple rows - stack vertically
      var lineH = 16;
      var startY = y + (cellH - (values.length * lineH)) / 2 + lineH / 2;
      values.forEach(function (val, vi) {
        var vy = startY + vi * lineH;
        // Row label
        ctx.fillStyle = dim;
        ctx.font = "10px " + (getComputedStyle(getElementById("rowViewContent") ?? document.body).fontFamily || "monospace");
        ctx.textBaseline = "middle";
        ctx.fillText("Row " + (vi + 1) + ":", valueX, vy);
        // Value
        var labelW = ctx.measureText("Row " + (vi + 1) + ":").width + 4;
        ctx.fillStyle = getValColor(val, col.columnDef.dataType);
        ctx.font = font;
        var display = fmtVal(val, col.columnDef.dataType);
        ctx.fillText(display, valueX + labelW, vy, totalW - valueX - labelW - pad);
      });
    }
  });

  // Convert to blob and copy to clipboard
  try {
    var blob = await new Promise<Blob | null>((resolve) => { canvas.toBlob(resolve, "image/png"); });
    if (!blob) throw new Error("Failed to create image");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    vscode.postMessage({ command: "info", text: "Row view copied as image" });
  } catch (err) {
    vscode.postMessage({ command: "info", text: "Failed to copy image: " + getErrorMessage(err) });
  }
}

function copyGridAsImage() {
  var activeIndex = getActiveGridIndex();
  var table = getGrid(activeIndex)?.tanTable;
  if (!table) return;

  var columns = table.getVisibleLeafColumns().filter(function (col) { return col.getIsVisible(); });
  if (columns.length === 0) return;
  var filteredRows = table.getFilteredRowModel().rows;
  if (filteredRows.length === 0) return;
  var MAX_ROWS = 500;
  var rows = filteredRows.slice(0, MAX_ROWS);

  // Theme colors
  var bodyStyle = getComputedStyle(document.body);
  function readCSS(prop: string, fallback: string): string {
    var v = bodyStyle.getPropertyValue(prop).trim();
    return v || fallback;
  }
  var bg = readCSS("--vscode-editor-background", "#1e1e1e");
  var fg = readCSS("--vscode-editor-foreground", "#cccccc");
  var border = readCSS("--vscode-panel-border", "#333333");
  var headerBg = readCSS("--vscode-sideBar-background", "#252526");
  var badgeBg = readCSS("--vscode-badge-background", "#4a4a4a");
  var badgeFg = readCSS("--vscode-badge-foreground", "#ffffff");
  var blue = readCSS("--vscode-charts-blue", "#519aba");
  var green = readCSS("--vscode-charts-green", "#89d185");
  var dim = readCSS("--vscode-descriptionForeground", "#888888");
  var purple = "#d8b4fe";

  var fontFam = getComputedStyle(getElementById("gridContainer") ?? document.body).fontFamily || "monospace";
  var pad = 8;
  var headerH = 36;
  var rowH = 30;
  var font = "12px " + fontFam;
  var fontBold = "600 12px " + fontFam;
  var altColor = "rgba(255,255,255,0.04)";

  function getValColor(val: unknown, dt: string | undefined): string {
    if (val === null || val === undefined) return dim;
    var t = (dt || "").toLowerCase();
    if (t.indexOf("bool") >= 0) return val ? green : dim;
    if (t.indexOf("int") >= 0 || t.indexOf("dec") >= 0 || t.indexOf("float") >= 0 || t.indexOf("num") >= 0) return blue;
    if (t.indexOf("date") >= 0 || t.indexOf("time") >= 0) return purple;
    return fg;
  }

  function fmtVal(val: unknown, dt: string | undefined): string {
    if (val === null || val === undefined) return "NULL";
    var t = (dt || "").toLowerCase();
    if (t.indexOf("bool") >= 0) return val ? "true" : "false";
    if (t.indexOf("int") >= 0 || t.indexOf("dec") >= 0 || t.indexOf("float") >= 0 || t.indexOf("num") >= 0) {
      if (typeof val === "number") return val.toLocaleString();
      return String(val);
    }
    return String(val);
  }

  function fmtType(dt: string | undefined): string {
    if (!dt) return "";
    var lower = dt.toLowerCase();
    if (lower.indexOf("int") >= 0 || lower.indexOf("dec") >= 0 || lower.indexOf("float") >= 0 || lower.indexOf("num") >= 0) return "num";
    if (lower.indexOf("char") >= 0 || lower.indexOf("text") >= 0 || lower.indexOf("varchar") >= 0) return "txt";
    if (lower.indexOf("date") >= 0 || lower.indexOf("time") >= 0) return "dt";
    if (lower.indexOf("bool") >= 0) return "bool";
    return "";
  }

  // Measure column widths
  var colWidths: number[] = [];
  var totalW = 0;
  var tmpCanvas = document.createElement("canvas");
  var tmpCtx = getCanvasContext(tmpCanvas);
  var maxTotalW = 800;

  columns.forEach(function (col, ci) {
    tmpCtx.font = fontBold;
    var headerW = tmpCtx.measureText(col.columnDef.header || col.id).width + 30 + pad * 3;
    var maxW = headerW;
    tmpCtx.font = font;
    rows.forEach(function (row) {
      var val = row.getValue(col.id);
      var display = fmtVal(val, col.columnDef.dataType);
      var w = tmpCtx.measureText(display).width + pad * 2;
      if (w > maxW) maxW = w;
    });
    maxW = Math.max(maxW, 60);
    maxW = Math.min(maxW, 300);
    // If total would exceed maxTotalW, shrink remaining proportionally
    totalW += maxW;
    colWidths.push(maxW);
  });

  // If too wide, scale down
  if (totalW > maxTotalW) {
    var scale = maxTotalW / totalW;
    colWidths = colWidths.map(function (w) { return Math.max(Math.floor(w * scale), 50); });
    totalW = colWidths.reduce(function (a, b) { return a + b; }, 0);
  }

  var visRows = rows.length;
  var totalH = headerH + visRows * rowH;

  // Canvas
  var dpr = window.devicePixelRatio || 2;
  var canvas = document.createElement("canvas");
  canvas.width = totalW * dpr;
  canvas.height = totalH * dpr;
  var ctx = getCanvasContext(canvas);
  ctx.scale(dpr, dpr);

  function roundRect(x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // Background
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, totalW, totalH);

  // Header row
  ctx.fillStyle = headerBg;
  ctx.fillRect(0, 0, totalW, headerH);
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, headerH);
  ctx.lineTo(totalW, headerH);
  ctx.stroke();

  var cx = 0;
  columns.forEach(function (col, ci) {
    var cw = colWidths[ci];
    // Vertical separator
    if (ci > 0) {
      ctx.strokeStyle = border;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, totalH);
      ctx.stroke();
    }
    // Header text
    ctx.fillStyle = fg;
    ctx.font = fontBold;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    var name = col.columnDef.header || col.id;
    ctx.fillText(name, cx + pad, headerH / 2);

    // Type badge
    var typeLabel = fmtType(col.columnDef.dataType);
    if (typeLabel) {
      var nameW = ctx.measureText(name).width;
      var badgeX = cx + pad + nameW + 6;
      var badgeW2 = 28;
      var badgeH = 16;
      var badgeY = (headerH - badgeH) / 2;
      ctx.fillStyle = badgeBg;
      roundRect(badgeX, badgeY, badgeW2, badgeH, 3);
      ctx.fill();
      ctx.fillStyle = badgeFg;
      ctx.font = "9px " + fontFam;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(typeLabel, badgeX + badgeW2 / 2, headerH / 2);
      ctx.font = fontBold;
      ctx.textAlign = "left";
    }
    cx += cw;
  });

  // Data rows
  rows.forEach(function (row, ri) {
    var y = headerH + ri * rowH;
    // Alternating row bg
    if (ri % 2 === 1) {
      ctx.fillStyle = altColor;
      ctx.fillRect(0, y, totalW, rowH);
    }
    // Bottom border
    ctx.strokeStyle = border;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y + rowH);
    ctx.lineTo(totalW, y + rowH);
    ctx.stroke();

    var cx2 = 0;
    columns.forEach(function (col, ci) {
      var cw = colWidths[ci];
      var val = row.getValue(col.id);
      var display = fmtVal(val, col.columnDef.dataType);
      ctx.fillStyle = getValColor(val, col.columnDef.dataType);
      ctx.font = val === null || val === undefined ? ("italic " + font) : font;
      ctx.textBaseline = "middle";
      var align = col.columnDef.align === "right" || (col.columnDef.dataType && col.columnDef.dataType.toLowerCase().indexOf("int") >= 0);
      if (align) {
        ctx.textAlign = "right";
        ctx.fillText(display, cx2 + cw - pad, y + rowH / 2);
      } else {
        ctx.textAlign = "left";
        ctx.fillText(display, cx2 + pad, y + rowH / 2, cw - pad * 2);
      }
      cx2 += cw;
    });
  });

  // Copy to clipboard
  try {
    canvas.toBlob(async function (blob) {
      if (!blob) { vscode.postMessage({ command: "info", text: "Failed to create image" }); return; }
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        vscode.postMessage({ command: "info", text: "Grid copied as image (" + visRows + " rows)" });
      } catch (e) {
        vscode.postMessage({ command: "info", text: "Failed to copy image" });
      }
    }, "image/png");
  } catch (err) {
    vscode.postMessage({ command: "info", text: "Failed to copy image: " + getErrorMessage(err) });
  }
}

function exportRowViewAsXlsb() {
  if (!hasRowViewData()) return;
  var activeIndex = getActiveGridIndex();
  var table = getGrid(activeIndex)?.tanTable;
  if (!table) return;

  var rowIndices = getSelectedRowIndices();
  if (rowIndices.length === 0 || rowIndices.length > 10) return;

  var columns = table.getAllColumns().filter(function (col) { return col.getIsVisible(); });
  var columnIds = columns.map(function (col) { return col.id; });
  var rs = getResultSetAt(activeIndex) ?? null;

  var data = {
    sourceUri: getActiveSourceUri(),
    results: [{
      resultSetIndex: activeIndex,
      rowIndices: rowIndices,
      columnIds: columnIds,
      name: "Row View - " + (rs ? rs.name : "Result " + (activeIndex + 1)),
      isActive: true,
    }],
  };

  vscode.postMessage({ command: "openInExcel", data: data, sql: "" });
}

// Entry point for resultView.ts
export function initializeResultView(data: unknown[][], columns: Array<{ header: string; accessorKey?: string | number }>): void {
  try {
    injectStyles();
    initializeWindowState();
    initializeSearchWorker();

    // Adapt to resultSets format
    setResultSets([
      {
        data: data,
        columns: columns.map((c, i) => ({
          name: c.header,
          index: i,
          accessorKey: c.accessorKey,
        })),
      },
    ]);
    getResultPanelWindow().sources = ["Result"];
    setActiveSourceUri("Result");

    // Hide doc indicator for single result view
    const docIndicator = getElementById("docIndicator");
    if (docIndicator) docIndicator.style.display = "none";

    renderGrids();
    setupGlobalKeyboardShortcuts();
    updateLoadingState();
  } catch (e) {
    showError("Initialization error: " + getErrorMessage(e));
    console.error(e);
  }
}

let _colSearchHighlightIdx = -1;

function renderColumnSearchDropdown(filterText: string): void {
  const dropdown = getElementById("columnSearchDropdown");
  if (!dropdown) return;

  const activeIndex = getActiveGridIndex();
  const mapping = getResultPanelWindow().columnSearchMap?.[activeIndex] ?? null;

  if (!mapping || mapping.length === 0) {
    dropdown.style.display = "none";
    return;
  }

  const lower = (filterText || "").toLowerCase();
  let items: ColumnSearchMapItem[];
  if (!lower) {
    items = mapping;
  } else {
    items = mapping.filter(item => item.name.toLowerCase().includes(lower));
  }

  if (items.length === 0 && lower) {
    dropdown.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "column-search-dropdown-empty";
    empty.textContent = "No matching columns";
    dropdown.appendChild(empty);
    dropdown.style.display = "block";
    return;
  }

  dropdown.innerHTML = "";
  items.forEach((item, idx) => {
    const div = document.createElement("div");
    div.className = "column-search-dropdown-item" + (idx === _colSearchHighlightIdx ? " highlight" : "");
    div.textContent = item.name;
    div.dataset.colId = item.id;
    div.onmousedown = (e) => {
      e.preventDefault();
      selectColumnSearchItem(item);
    };
    dropdown.appendChild(div);
  });

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "column-search-dropdown-empty";
    empty.textContent = "No matching columns";
    dropdown.appendChild(empty);
  }

  dropdown.style.display = "block";
  _colSearchHighlightIdx = -1;
}

function selectColumnSearchItem(item: ColumnSearchMapItem): void {
  navigateToResultColumn(item.id, item.name);
}

export function onColumnSearchChanged(): void {
  const input = getElementById<HTMLInputElement>("columnSearch");
  if (!input) return;
  _colSearchHighlightIdx = -1;
  renderColumnSearchDropdown(input.value);
}

export function onColumnSearchKeydown(event: KeyboardEvent): void {
  const dropdown = getElementById("columnSearchDropdown");
  if (!dropdown || dropdown.style.display === "none") return;

  const items = dropdown.querySelectorAll(".column-search-dropdown-item");
  if (items.length === 0) return;

  if (event.key === "ArrowDown") {
    event.preventDefault();
    _colSearchHighlightIdx = Math.min(_colSearchHighlightIdx + 1, items.length - 1);
    updateHighlight(items);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    _colSearchHighlightIdx = Math.max(_colSearchHighlightIdx - 1, 0);
    updateHighlight(items);
  } else if (event.key === "Enter") {
    event.preventDefault();
    const input = getElementById<HTMLInputElement>("columnSearch");
    if (!input) return;

    if (_colSearchHighlightIdx >= 0 && _colSearchHighlightIdx < items.length) {
      const activeIndex = getActiveGridIndex();
      const mapping = getResultPanelWindow().columnSearchMap?.[activeIndex] ?? null;
      if (!mapping) return;
      const itemId = (items[_colSearchHighlightIdx] as HTMLElement).dataset.colId;
      const item = mapping.find(m => m.id === itemId);
      if (item) {
        selectColumnSearchItem(item);
      }
    } else {
      // No highlight - try to match first item in dropdown
      const firstItem = items[0];
      const activeIndex = getActiveGridIndex();
      const mapping = getResultPanelWindow().columnSearchMap?.[activeIndex] ?? null;
      if (!mapping) return;
      const item = mapping.find(m => m.id === (firstItem as HTMLElement).dataset.colId);
      if (item) {
        selectColumnSearchItem(item);
      }
    }
  } else if (event.key === "Escape") {
    event.preventDefault();
    dropdown.style.display = "none";
  }
}

function updateHighlight(items: NodeListOf<Element>): void {
  items.forEach((el, idx) => {
    el.classList.toggle("highlight", idx === _colSearchHighlightIdx);
    if (idx === _colSearchHighlightIdx) {
      el.scrollIntoView({ block: "nearest" });
    }
  });
}

export function onColumnSearchBlur(): void {
  // Delay to allow mousedown on dropdown item to fire first
  setTimeout(() => {
    const dropdown = getElementById("columnSearchDropdown");
    if (dropdown) {
      dropdown.style.display = "none";
    }
  }, 150);
}

export function onColumnSearchFocus(): void {
  renderColumnSearchDropdown("");
}

// Close dropdown on any click outside
document.addEventListener("mousedown", (e) => {
  const target = e.target instanceof Node ? e.target : null;
  const wrapper = document.querySelector(".column-search-wrapper");
  if (wrapper && target && !wrapper.contains(target)) {
    const dropdown = getElementById("columnSearchDropdown");
    if (dropdown) {
      dropdown.style.display = "none";
    }
  }
  // Close export menus when clicking outside
  var splitBtn = getElementById("exportSplitBtn");
  if (splitBtn && target && !splitBtn.contains(target)) {
    var sm = getElementById("exportSplitMenu");
    if (sm) sm.style.display = "none";
    var primaryMenu = getElementById("exportPrimaryMenu");
    if (primaryMenu) primaryMenu.style.display = "none";
    var exportBtn = document.querySelector("#exportSplitBtn .split-btn__primary");
    if (exportBtn) exportBtn.setAttribute("aria-expanded", "false");
  }
  // Close view split menu when clicking outside
  var viewBtn = getElementById("viewSplitBtn");
  if (viewBtn && target && !viewBtn.contains(target)) {
    var vm = getElementById("viewSplitMenu");
    if (vm) vm.style.display = "none";
  }
  // Close toolbar more menu when clicking outside
  var moreBtn = getElementById("toolbarMoreBtn");
  if (moreBtn && target && !moreBtn.contains(target)) {
    var moreMenu = getElementById("toolbarMoreMenu");
    if (moreMenu) moreMenu.style.display = "none";
  }
  // Close row view export menu when clicking outside
  var rvExport = getElementById("rowViewExportMenu");
  if (rvExport && rvExport.style.display !== "none") {
    var rvExportBtn = document.querySelector(".row-view-export-wrapper");
    if (rvExportBtn && target && !rvExportBtn.contains(target)) {
      rvExport.style.display = "none";
    }
  }
});

getResultPanelWindow().toggleExportSplitMenu = function (event: Event) {
  event.stopPropagation();
  var primaryMenu = getElementById("exportPrimaryMenu");
  if (primaryMenu) primaryMenu.style.display = "none";
  var exportBtn = document.querySelector("#exportSplitBtn .split-btn__primary");
  if (exportBtn) exportBtn.setAttribute("aria-expanded", "false");
  var m = getElementById("exportSplitMenu");
  if (!m) return;
  m.style.display = m.style.display === "none" ? "block" : "none";
};

getResultPanelWindow().toggleExportPrimaryMenu = toggleExportPrimaryMenu;

getResultPanelWindow().toggleToolbarMoreMenu = function (event) {
  event.stopPropagation();
  var menu = getElementById("toolbarMoreMenu");
  if (!menu) return;
  menu.style.display = menu.style.display === "none" ? "block" : "none";
};

getResultPanelWindow().handleToolbarMoreMenuClick = function (event: MouseEvent) {
  const target = asHtml(event.target);
  const item = target?.closest(".split-btn__menu-item") as HTMLElement | null;
  if (!item || item.classList.contains("toolbar-more-menu__section-label")) return;
  const action = item.dataset.action;
  const menu = getElementById("toolbarMoreMenu");
  if (menu) menu.style.display = "none";
  if (!action) return;

  if (action === "view-chart") { setViewMode("chart"); return; }
  if (action === "view-diff") { setViewMode("diff"); return; }
  if (action === "formatting") {
    callPanelMethod('openResultFormattingPanel', { scope: "result" });
    return;
  }
  if (action === "clear-filters") {
    callPanelMethod('clearAllFilters');
    return;
  }

  if (action === "move-to-disk") {
    const sourceUri = getActiveSourceUri();
    if (!sourceUri) {
      vscode.postMessage({ command: 'info', text: 'No active SQL result source.' });
      return;
    }
    const rs = getResultSetAt(getActiveGridIndex());
    if (!rs) {
      vscode.postMessage({ command: 'info', text: 'No result set available.' });
      return;
    }
    if (rs.storageMode === 'sqlite') {
      vscode.postMessage({ command: 'info', text: 'Result is already on disk.' });
      return;
    }
    vscode.postMessage({
      command: 'moveToDisk',
      sourceUri,
      resultSetIndex: getActiveGridIndex(),
    });
    return;
  }

  if (action === "move-all-to-disk") {
    const sourceUri = getActiveSourceUri();
    if (!sourceUri) {
      vscode.postMessage({ command: 'info', text: 'No active SQL result source.' });
      return;
    }
    const rsList = getResultSets();
    const nonDisk = rsList.filter(rs => rs && rs.storageMode !== 'sqlite' && !rs.isLog);
    if (nonDisk.length === 0) {
      vscode.postMessage({ command: 'info', text: 'No in-memory result sets to move.' });
      return;
    }
    vscode.postMessage({
      command: 'moveAllToDisk',
      sourceUri,
    });
    return;
  }
};

getResultPanelWindow().handleExportSplitMenuClick = function (event: MouseEvent) {
  const target = asHtml(event.target);
  const item = target?.closest(".split-btn__menu-item") as HTMLElement | null;
  if (!item) return;
  const action = item.dataset.action;
  const splitMenu = getElementById("exportSplitMenu");
  if (splitMenu) splitMenu.style.display = "none";
  if (action === "current-view") { handleClickExport(); }
  else if (action === "all-rows") { exportAllVisibleToExcel(); }
  else if (action === "excel") { openInExcel(); }
  else if (action === "markdown") { exportToMdFile(); }
  else if (action === "json") { exportToJson(); }
  else if (action === "csv") { exportToCsv(); }
  else if (action === "copy-html") { callPanelMethod('copySelectionAsHtml'); }
  else if (action === "copy-md") { callPanelMethod('copySelection', true); }
  else if (action === "copy-image") { copyGridAsImage(); }
  else if (action === "export-all-excel") { exportAllResultSetsToExcel(); }
  else if (action === "query-duckdb") { handleClickQueryLocallyDuckDB(); }
};

function updateEditButtonsState(): void {
  const editBtn = getElementById('editToggleBtn');
  const saveBtn = getElementById('saveEditsBtn');
  const discardBtn = getElementById('discardEditsBtn');
  const rs = getResultSetAt(getActiveGridIndex());
  const isEditable = rs && rs.isEditable;
  const inEdit = getIsEditMode();

  if (editBtn) {
    editBtn.style.display = isEditable ? 'inline-flex' : 'none';
    editBtn.textContent = (inEdit ? '✕ ' : '✎ ') + 'Edit';
    editBtn.title = inEdit ? 'Exit edit mode' : 'Toggle edit mode';
  }
  if (saveBtn) {
    saveBtn.style.display = (isEditable && inEdit) ? 'inline-flex' : 'none';
  }
  if (discardBtn) {
    discardBtn.style.display = (isEditable && inEdit) ? 'inline-flex' : 'none';
  }
}

// Setup window functions
function setupWindowFunctions(): void {
  const panel = getResultPanelWindow();
  panel.postToHost = postHostMessage as (message: Record<string, unknown>) => void;
  panel.__getHostState = getHostState as () => Record<string, unknown> | null;
  panel.__setHostState = setHostState;
  panel.renderSidebarSchema = renderSidebarSchema;
  panel.onDropGroup = onDropGroup;
  panel.onDragOverGroup = onDragOverGroup;
  panel.onDragLeaveGroup = onDragLeaveGroup;
  panel.clearGroupDropTargets = clearGroupDropTargets;
  panel.toggleRowView = toggleRowView;
  panel.openInExcel = openInExcel;
  panel.openInExcelXlsx = openInExcelXlsx;
  panel.openInFilePreview = openInFilePreview;
  panel.copyAsExcel = copyAsExcel;
  panel.exportToCsv = exportToCsv;
  panel.exportToJson = exportToJson;
  panel.exportToXml = exportToXml;
  panel.exportToSqlInsert = exportToSqlInsert;
  panel.exportToMarkdown = exportToMarkdown;
  panel.onFilterChanged = onGlobalFilterChanged;
  panel.clearFilter = function () {
    const filter = getElementById<HTMLInputElement>("globalFilter");
    if (filter) filter.value = "";

    const activeIndex = getActiveGridIndex();
    const activeResult = getResultSetAt(activeIndex) ?? null;
    setGlobalFilterState(
      activeIndex,
      "",
      activeResult ? activeResult.executionTimestamp : undefined,
      getActiveSourceUri(),
    );
  };
  panel.clearAllFilters = function () {
    const globalFilter = getElementById<HTMLInputElement>("globalFilter");
    if (globalFilter) globalFilter.value = "";

    const activeIndex = getActiveGridIndex();
    const activeResult = getResultSetAt(activeIndex) ?? null;
    setGlobalFilterState(
      activeIndex,
      "",
      activeResult ? activeResult.executionTimestamp : undefined,
      getActiveSourceUri(),
    );
    // Handle grid view
    const activeGrid = getGrid(activeIndex);
    if (activeGrid && activeGrid.tanTable) {
      activeGrid.tanTable.resetColumnFilters();
      activeGrid.tanTable.setGlobalFilter("");
      if (activeGrid.render) {
        activeGrid.render();
      }
    }
  };
  panel.clearLogs = function () {
    vscode.postMessage({
      command: "clearLogs",
      sourceUri: getActiveSourceUri(),
    });
  };
  panel.refreshRowView = updateRowView;
  panel.copyRowViewAsImage = copyRowViewAsImage;
  panel.copyRowViewAsMarkdown = copyRowViewAsMarkdown;
  panel.exportRowViewAsXlsb = exportRowViewAsXlsb;
  panel.openValueViewer = openValueViewer;
  panel.closeValueViewer = closeValueViewer;
  panel.handleClickExport = handleClickExport;
  panel.toggleExportPrimaryMenu = toggleExportPrimaryMenu;
  panel.setResultViewMode = setActiveResultViewMode;
  panel.initializeResultView = initializeResultView;
  panel.openResultFormattingPanel = openResultFormattingPanel;
  panel.closeResultFormattingPanel = closeResultFormattingPanel;
  panel.openRangeChartModal = openRangeChartModal;
  panel.closeRangeChartModal = closeRangeChartModal;
  panel.canCreateRangeChart = canCreateRangeChart;
  panel.openRangeChartFromToolbar = openRangeChartFromToolbar;
  panel.openRangeChartForActiveResult = openRangeChartForActiveResult;
  panel.refreshResultsGrid = function () {
    renderGrids();
    updateLoadingState();
  };
  panel.handleClickQueryLocallyDuckDB = handleClickQueryLocallyDuckDB;
  panel.exportAllVisibleToCsv = exportAllVisibleToCsv;
  panel.exportAllVisibleToJson = exportAllVisibleToJson;
  panel.exportAllVisibleToXml = exportAllVisibleToXml;
  panel.exportAllVisibleToSqlInsert = exportAllVisibleToSqlInsert;
  panel.exportAllVisibleToMarkdown = exportAllVisibleToMarkdown;
  panel.exportAllVisibleToExcel = exportAllVisibleToExcel;
  panel.exportSelectionToCsv = exportSelectionToCsv;
  panel.exportSelectionToJson = exportSelectionToJson;
  panel.exportSelectionToExcel = exportSelectionToExcel;
  panel.exportAllResultSetsToExcel = exportAllResultSetsToExcel;
  panel.exportToMdFile = exportToMdFile;
  panel.copySelection = function (withHeaders, copyFormat) {
    const activeIndex = getActiveGridIndex();
    const grid = getGrid(activeIndex);
    if (grid && grid.copySelection) {
      const format = copyFormat || panel.defaultCopyFormat || 'markdown';
      grid.copySelection(withHeaders, format);
    }
  };
  panel.copySelectionAsHtml = function () {
    const activeIndex = getActiveGridIndex();
    const grid = getGrid(activeIndex);
    if (grid && grid.copySelectionAsHtml) {
      grid.copySelectionAsHtml();
    }
  };
  panel.copySelectionAsMd = function (withHeaders) {
    const activeIndex = getActiveGridIndex();
    const grid = getGrid(activeIndex);
    if (grid && grid.copySelectionAsMd) {
      grid.copySelectionAsMd(withHeaders);
    }
  };
  panel.selectAll = function () {
    const activeIndex = getActiveGridIndex();
    const viewMode = getActiveResultViewMode(activeIndex);
    const grid = getGrid(activeIndex);
    if (grid && grid.selectAll) {
      grid.selectAll();
    }
  };
  panel.toggleEditMode = function () {
    const rs = getResultSetAt(getActiveGridIndex());
    if (!rs || !rs.isEditable) return;
    var newMode = !getIsEditMode();
    setIsEditMode(newMode);
    clearPendingEdits();
    updateEditButtonsState();
    // Re-render grid to show/hide edit indicators
    const grid = getGrid(getActiveGridIndex());
    if (grid && grid.render) grid.render();
  };
  panel.saveEdits = function () {
    const rs = getResultSetAt(getActiveGridIndex());
    if (!rs || !rs.isEditable) return;
    var edits = getPendingEdits();
    var deletes = Array.from(getPendingDeletes());
    if (edits.length === 0 && deletes.length === 0) {
      vscode.postMessage({ command: 'info', text: 'No pending changes to save.' });
      return;
    }
    vscode.postMessage({
      command: 'saveEdits',
      sourceUri: getActiveSourceUri(),
      resultSetIndex: getActiveGridIndex(),
      editSource: rs.editSource,
      edits: edits,
      deleteRowIndices: deletes
    });
  };
  panel.toggleColumnVisibilityDropdown = function () {
    var existing = document.querySelector('.column-visibility-dropdown');
    if (existing) { existing.remove(); return; }

    var activeIndex = getActiveGridIndex();
    var grid = getGrid(activeIndex);
    if (!grid || !grid.tanTable) return;

    var allColumns = grid.tanTable.getAllLeafColumns?.() ?? grid.tanTable.getVisibleLeafColumns();
    var dropdown = document.createElement('div');
    dropdown.className = 'column-visibility-dropdown';
    dropdown.style.position = 'fixed';
    dropdown.style.zIndex = '10000';
    dropdown.style.backgroundColor = 'var(--vscode-dropdown-background)';
    dropdown.style.border = '1px solid var(--vscode-dropdown-border)';
    dropdown.style.borderRadius = '4px';
    dropdown.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
    dropdown.style.maxHeight = '300px';
    dropdown.style.overflowY = 'auto';
    dropdown.style.minWidth = '180px';
    dropdown.style.padding = '4px 0';

    // Header
    var headerDiv = document.createElement('div');
    headerDiv.style.padding = '6px 12px';
    headerDiv.style.fontWeight = '600';
    headerDiv.style.fontSize = '12px';
    headerDiv.style.borderBottom = '1px solid var(--vscode-panel-border)';
    headerDiv.textContent = 'Columns';
    dropdown.appendChild(headerDiv);

    // Show All / Hide All
    var actionsDiv = document.createElement('div');
    actionsDiv.style.display = 'flex';
    actionsDiv.style.gap = '4px';
    actionsDiv.style.padding = '4px 12px';
    actionsDiv.style.borderBottom = '1px solid var(--vscode-panel-border)';

    var showAllBtn = document.createElement('button');
    showAllBtn.textContent = 'Show All';
    showAllBtn.style.fontSize = '11px';
    showAllBtn.style.cursor = 'pointer';
    showAllBtn.style.border = '1px solid var(--vscode-panel-border)';
    showAllBtn.style.borderRadius = '2px';
    showAllBtn.style.background = 'transparent';
    showAllBtn.style.color = 'var(--vscode-foreground)';
    showAllBtn.style.padding = '2px 6px';

    var hideAllBtn = document.createElement('button');
    hideAllBtn.textContent = 'Hide All';
    hideAllBtn.style.fontSize = '11px';
    hideAllBtn.style.cursor = 'pointer';
    hideAllBtn.style.border = '1px solid var(--vscode-panel-border)';
    hideAllBtn.style.borderRadius = '2px';
    hideAllBtn.style.background = 'transparent';
    hideAllBtn.style.color = 'var(--vscode-foreground)';
    hideAllBtn.style.padding = '2px 6px';

    actionsDiv.appendChild(showAllBtn);
    actionsDiv.appendChild(hideAllBtn);
    dropdown.appendChild(actionsDiv);

    // Column list
    var listDiv = document.createElement('div');
    listDiv.style.padding = '2px 0';

    allColumns.forEach(function (col) {
        var colId = col.id;
        var colDef = col.columnDef;
        var isVisible = col.getIsVisible();

        var item = document.createElement('div');
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.padding = '4px 12px';
        item.style.cursor = 'pointer';
        item.style.gap = '6px';
        item.style.fontSize = '12px';

        item.onmouseenter = function () { item.style.backgroundColor = 'var(--vscode-list-hoverBackground)'; };
        item.onmouseleave = function () { item.style.backgroundColor = ''; };

        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = isVisible;
        cb.style.margin = '0';
        cb.style.cursor = 'pointer';
        cb.style.accentColor = 'var(--vscode-focusBorder)';

        var label = document.createElement('span');
        label.textContent = colDef && colDef.header ? colDef.header : colId;
        label.style.flex = '1';

        var typeSpan = document.createElement('span');
        typeSpan.textContent = colDef && colDef.dataType ? colDef.dataType : '';
        typeSpan.style.fontSize = '10px';
        typeSpan.style.opacity = '0.5';

        item.appendChild(cb);
        item.appendChild(label);
        item.appendChild(typeSpan);

        item.onclick = function (e) {
            if (e.target !== cb) {
                cb.checked = !cb.checked;
                cb.dispatchEvent(new Event('change', { bubbles: true }));
            }
        };

        cb.addEventListener('change', function () {
            col.toggleVisibility(cb.checked);
            grid?.render?.();
        });

        listDiv.appendChild(item);
    });

    dropdown.appendChild(listDiv);

    // Show All / Hide All handlers
    showAllBtn.onclick = function () {
        allColumns.forEach(function (c) { c.toggleVisibility(true); });
        var cbs = dropdown.querySelectorAll('input[type="checkbox"]');
        cbs.forEach(function (cb2) { (cb2 as HTMLInputElement).checked = true; });
        grid?.render?.();
    };

    hideAllBtn.onclick = function () {
        allColumns.forEach(function (c) { c.toggleVisibility(false); });
        var cbs = dropdown.querySelectorAll('input[type="checkbox"]');
        cbs.forEach(function (cb2) { (cb2 as HTMLInputElement).checked = false; });
        grid?.render?.();
    };

    // Position dropdown below the button
    var btn = getElementById('columnVisibilityBtn');
    if (btn) {
        var rect = btn.getBoundingClientRect();
        dropdown.style.top = (rect.bottom + 4) + 'px';
        dropdown.style.left = Math.max(4, Math.min(rect.left, panel.innerWidth - 200)) + 'px';
    } else {
        dropdown.style.top = '40px';
        dropdown.style.right = '10px';
    }

    document.body.appendChild(dropdown);

    // Close on click outside
    setTimeout(function () {
        function closeHandler(e: MouseEvent): void {
            const target = e.target;
            if (!(target instanceof Node)) {
                return;
            }
            if (!dropdown.contains(target) && (target instanceof HTMLElement ? target.id !== 'columnVisibilityBtn' : true)) {
                dropdown.remove();
                document.removeEventListener('click', closeHandler);
            }
        }
        document.addEventListener('click', closeHandler);
    }, 100);
  };

  panel.discardEdits = function () {
    resetEditSession();
    updateEditButtonsState();
    const grid = getGrid(getActiveGridIndex());
    if (grid && grid.render) grid.render();
  };

  panel.getIsEditMode = getIsEditMode;
  panel.addPendingEdit = addPendingEdit;
  panel.markRowForDelete = markRowForDelete;
  panel.isRowMarkedForDelete = isRowMarkedForDelete;
  panel.getGrid = getGrid;
  panel.getActiveGridIndex = getActiveGridIndex;

  panel.updateEditButtons = updateEditButtonsState;

  panel.onColumnSearchChanged = onColumnSearchChanged;
  panel.onColumnSearchKeydown = onColumnSearchKeydown;
  panel.onColumnSearchBlur = onColumnSearchBlur;
  panel.onColumnSearchFocus = onColumnSearchFocus;
  panel.init = init;
}

// Initialize window functions
setupWindowFunctions();

document.addEventListener("DOMContentLoaded", () => {
  const overlay = getElementById("valueViewerOverlay");
  if (!overlay) {
    return;
  }
  const closeBtn = getElementById("valueViewerCloseBtn");
  const dismissBtn = getElementById("valueViewerDismissBtn");
  const copyBtn = getElementById("valueViewerCopyBtn");

  const close = () => closeValueViewer();

  closeBtn?.addEventListener("click", close);
  dismissBtn?.addEventListener("click", close);
  overlay?.addEventListener("click", (event) => {
    if (event.target === overlay) {
      close();
    }
  });
  copyBtn?.addEventListener("click", () => {
    const payload = _viewerPayloads.get(overlay);
    const text = payload?.isNull ? "NULL" : String(payload?.value ?? "");
    navigator.clipboard
      .writeText(text)
      .then(() => {
        vscode.postMessage({
          command: "info",
          text: "Copied cell value to clipboard",
        });
      })
      .catch((err) => {
        vscode.postMessage({
          command: "error",
          text: "Failed to copy to clipboard",
        });
        console.error("[valueViewer] Clipboard write failed:", err);
      });
  });

  window.addEventListener("result-panel-selection-changed", () => {
    if (getRowViewOpen()) {
      updateRowView();
    }
  });
});
