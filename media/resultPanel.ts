/**
 * Esbuild IIFE entry for the Result Panel webview bundle.
 * Window globals and `init()` wiring live in init.ts (loaded for side effects).
 */
import './resultPanel/init.js';

export {
  init,
  initializeResultView,
  onGlobalFilterChanged,
  toggleRowView,
  setupHideLoadingOverlayButton,
  setupExecutionStatusBanner,
} from './resultPanel/init.js';
export { formatCellValue, escapeCsvValue, debounce } from './resultPanel/utils.js';
export {
  grids,
  activeGridIndex,
  sourceResultsCache,
  columnFilterStates,
  aggregationStates,
  searchWorker,
  searchMatches,
  isSearching,
  globalDragState,
  isRowViewOpen,
  setActiveGridIndex,
  resetGrids,
  addGrid,
  getGrid,
  getAllGrids,
  setSearchWorker,
  setSearchMatches,
  setIsSearching,
  setGlobalDragState,
  setRowViewOpen,
} from './resultPanel/state.js';
export { injectStyles } from './resultPanel/styles.js';
export {
  setupStreamingMessageHandler,
  handleSetActiveSource,
  handleHydrate,
  handleCancelExecution,
  handleAppendRows,
  handleStreamingComplete,
  saveAllGridStates,
  getSavedStateFor,
  savePinnedState,
} from './resultPanel/messages.js';
export {
  renderDocIndicator,
  renderResultSetTabs,
  switchToResultSet,
} from './resultPanel/tabs.js';
export {
  renderGrids,
  updateLoadingState,
  createLogConsole,
  createErrorView,
} from './resultPanel/grid.js';
export {
  createHeaderCellWithFilter,
  showColumnFilterDropdown,
  showAggregationDropdown,
  updateRowCountInfo,
} from './resultPanel/filter.js';
export {
  clearLogs,
  getAllGridsExportData,
  openInExcel,
  openInExcelXlsx,
  copyAsExcel,
  exportToCsv,
  exportToJson,
  exportToXml,
  exportToSqlInsert,
  exportToMarkdown,
  onDropGroup,
  onDragOverGroup,
  onDragLeaveGroup,
  handleClickExport,
  setGlobalDragStateForExport,
} from './resultPanel/export.js';
export { setupCellSelectionEvents } from './resultPanel/selection.js';
export {
  initializeAnalysisModeControls,
  syncAnalysisView,
  setActiveResultViewMode,
  setResultViewModeForIndex,
} from './resultPanel/analysis.js';
