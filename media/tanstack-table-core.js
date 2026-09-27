"use strict";
var TableCore = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // media/tanstack-table-core-entry.ts
  var tanstack_table_core_entry_exports = {};
  __export(tanstack_table_core_entry_exports, {
    constructTable: () => constructTable2,
    createColumnHelper: () => createColumnHelper,
    webviewFeatures: () => webviewFeatures
  });

  // node_modules/@tanstack/table-core/dist/utils.js
  function functionalUpdate(updater, input) {
    return typeof updater === "function" ? updater(input) : updater;
  }
  function cloneState(value) {
    if (Array.isArray(value)) return value.map(cloneState);
    if (value && typeof value === "object") {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return value;
      const copy = proto === null ? makeObjectMap() : {};
      const keys = Object.keys(value);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        Object.defineProperty(copy, key, {
          configurable: true,
          enumerable: true,
          value: cloneState(value[key]),
          writable: true
        });
      }
      return copy;
    }
    return value;
  }
  function copyInstancePropertiesWithoutMemos(target, source) {
    const keys = Object.keys(source);
    const targetRecord = target;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (!key.startsWith("_memo_") && key !== "_cellsCache") targetRecord[key] = source[key];
    }
    return target;
  }
  function makeObjectMap() {
    return /* @__PURE__ */ Object.create(null);
  }
  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }
  function makeStateUpdater(key, instance) {
    return (updater) => {
      (instance.options.atoms?.[key] ?? instance.baseAtoms[key]).set((old) => functionalUpdate(updater, old));
    };
  }
  function isPlainContainer(value) {
    if (typeof value !== "object" || value === null) return false;
    if (Array.isArray(value)) return true;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }
  function getEnumerableOwnKeys(value) {
    return Reflect.ownKeys(value).filter((key) => Object.prototype.propertyIsEnumerable.call(value, key));
  }
  var MAX_STATE_COMPARE_DEPTH = 3;
  function stateSlicesEqual(a, b) {
    return stateSlicesEqualAtDepth(a, b, MAX_STATE_COMPARE_DEPTH);
  }
  function stateSlicesEqualAtDepth(a, b, depth) {
    if (Object.is(a, b)) return true;
    if (depth <= 0 || !isPlainContainer(a) || !isPlainContainer(b)) return false;
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    }
    const keysA = getEnumerableOwnKeys(a);
    const keysB = getEnumerableOwnKeys(b);
    if (keysA.length !== keysB.length) return false;
    const recordA = a;
    const recordB = b;
    for (let i = 0; i < keysA.length; i++) {
      const key = keysA[i];
      if (!Object.prototype.propertyIsEnumerable.call(b, key)) return false;
      if (!stateSlicesEqualAtDepth(recordA[key], recordB[key], depth - 1)) return false;
    }
    return true;
  }
  function setStateSlice(instance, key, updater, isEqual = stateSlicesEqual) {
    const onChangeKey = `on${key.charAt(0).toUpperCase()}${key.slice(1)}Change`;
    const onChange = instance.options[onChangeKey];
    if (!onChange) return;
    onChange((current) => {
      const next = functionalUpdate(updater, current);
      return isEqual(current, next) ? current : next;
    });
  }
  function isFunction(d) {
    return d instanceof Function;
  }
  function flattenBy(arr, getChildren) {
    const flat = [];
    const recurse = (subArr) => {
      subArr.forEach((item) => {
        flat.push(item);
        const children = getChildren(item);
        if (children.length) recurse(children);
      });
    };
    recurse(arr);
    return flat;
  }
  var memo = ({ fn, memoDeps, onAfterCompare, onAfterUpdate, onBeforeCompare, onBeforeUpdate }) => {
    let deps = [];
    let result;
    const memoizedFn = (depArgs) => {
      onBeforeCompare?.();
      const newDeps = memoDeps?.(depArgs);
      let depsChanged = !newDeps || newDeps.length !== deps?.length;
      if (!depsChanged && newDeps) {
        for (let i = 0; i < newDeps.length; i++) if (newDeps[i] !== deps[i]) {
          depsChanged = true;
          break;
        }
      }
      onAfterCompare?.(depsChanged);
      if (!depsChanged) return result;
      deps = newDeps;
      onBeforeUpdate?.();
      result = fn(...newDeps ?? []);
      onAfterUpdate?.(result);
      return result;
    };
    return memoizedFn;
  };
  function skipFirstRun(fn) {
    let hasRun = false;
    return () => {
      if (!hasRun) {
        hasRun = true;
        return;
      }
      fn();
    };
  }
  var pad = (str, num) => {
    str = String(str);
    while (str.length < num) str = " " + str;
    return str;
  };
  function tableMemo({ feature, fnName, objectId, onAfterUpdate, table, ...memoOptions }) {
    let startCalcTime;
    let endCalcTime;
    let runCount = 0;
    let debug;
    if (true) {
      const { debugAll } = table.options;
      const { parentName } = getFunctionNameInfo(fnName, ".");
      const debugByParent = table.options[`debug${(parentName != "table" ? parentName + "s" : parentName).replace(parentName, parentName.charAt(0).toUpperCase() + parentName.slice(1))}`];
      const debugByFeature = feature ? table.options[`debug${feature.charAt(0).toUpperCase() + feature.slice(1)}`] : false;
      debug = debugAll || debugByParent || debugByFeature;
    }
    function logTime(time, depsChanged) {
      const runType = runCount === 0 ? "(1st run)" : depsChanged ? "(rerun #" + runCount + ")" : "(cache)";
      runCount++;
      console.groupCollapsed(`%c\u23F1 ${pad(`${time.toFixed(1)} ms`, 12)} %c${runType}%c ${fnName}%c ${objectId ? `(${fnName.split(".")[0]}Id: ${objectId})` : ""}`, `font-size: .6rem; font-weight: bold; ${depsChanged ? `color: hsl(
        ${Math.max(0, Math.min(120 - Math.log10(time) * 60, 120))}deg 100% 31%);` : ""} `, `color: ${runCount < 2 ? "#FF00FF" : "#FF1493"}`, "color: #666", "color: #87CEEB");
      console.info({
        feature,
        state: table.store.state,
        deps: memoOptions.memoDeps?.toString()
      });
      console.trace();
      console.groupEnd();
    }
    const onAfterUpdateHandler = () => {
      if (!onAfterUpdate) return;
      const { schedule, untrack } = table._reactivity;
      schedule(() => untrack(() => onAfterUpdate()));
    };
    const debugOptions = true ? {
      onBeforeCompare: () => {
      },
      onAfterCompare: (depsChanged) => {
      },
      onBeforeUpdate: () => {
        if (debug) startCalcTime = performance.now();
      },
      onAfterUpdate: () => {
        if (debug) {
          endCalcTime = performance.now();
          logTime(Math.round((endCalcTime - startCalcTime) * 100) / 100, true);
        }
        onAfterUpdateHandler();
      }
    } : { onAfterUpdate: () => {
      onAfterUpdateHandler();
    } };
    return memo({
      ...memoOptions,
      ...debugOptions
    });
  }
  function getFunctionNameInfo(staticFnName, splitBy = "_") {
    const [parentName, fnKey] = staticFnName.split(splitBy);
    return {
      fnKey,
      fnName: `${parentName}.${fnKey}`,
      parentName
    };
  }
  function assignTableAPIs(feature, table, apis) {
    for (const [staticFnName, { fn, memoDeps }] of Object.entries(apis)) {
      const { fnKey, fnName } = getFunctionNameInfo(staticFnName);
      table[fnKey] = memoDeps ? tableMemo({
        memoDeps,
        fn,
        fnName,
        table,
        feature
      }) : fn;
    }
  }
  function assignPrototypeAPIs(feature, prototype, table, apis) {
    for (const [staticFnName, { fn, memoDeps }] of Object.entries(apis)) {
      const { fnKey, fnName } = getFunctionNameInfo(staticFnName);
      if (memoDeps) {
        const memoKey = `_memo_${fnKey}`;
        prototype[fnKey] = function(...args) {
          if (!this[memoKey]) {
            const self = this;
            this[memoKey] = tableMemo({
              memoDeps: (depArgs) => memoDeps(self, depArgs),
              fn: (...deps) => fn(self, ...deps),
              fnName,
              objectId: self.id,
              table,
              feature
            });
          }
          return this[memoKey](...args);
        };
      } else prototype[fnKey] = function(...args) {
        return fn(this, ...args);
      };
    }
  }
  function callMemoOrStaticFn(obj, fnKey, staticFn, ...args) {
    return obj[fnKey]?.(...args) ?? staticFn(obj, ...args);
  }

  // node_modules/@tanstack/table-core/dist/core/cells/coreCellsFeature.utils.js
  function cell_getValue(cell) {
    return cell.row.getValue(cell.column.id);
  }
  function cell_renderValue(cell) {
    return cell.getValue() ?? cell.table.options.renderFallbackValue;
  }
  function cell_getContext(cell) {
    return {
      table: cell.table,
      column: cell.column,
      row: cell.row,
      cell,
      getValue: () => cell.getValue(),
      renderValue: () => cell.renderValue()
    };
  }

  // node_modules/@tanstack/table-core/dist/core/cells/coreCellsFeature.js
  var coreCellsFeature = { assignCellPrototype: (prototype, table) => {
    assignPrototypeAPIs("coreCellsFeature", prototype, table, {
      cell_getValue: { fn: (cell) => cell_getValue(cell) },
      cell_renderValue: { fn: (cell) => cell_renderValue(cell) },
      cell_getContext: {
        fn: (cell) => cell_getContext(cell),
        memoDeps: (cell) => [cell]
      }
    });
  } };

  // node_modules/@tanstack/table-core/dist/core/headers/constructHeader.js
  function getHeaderPrototype(table) {
    if (!table._headerPrototype) {
      table._headerPrototype = { table };
      const features = Object.values(table._features);
      for (let i = 0; i < features.length; i++) features[i].assignHeaderPrototype?.(table._headerPrototype, table);
    }
    return table._headerPrototype;
  }
  function constructHeader(table, column, options) {
    const headerPrototype = getHeaderPrototype(table);
    const header = Object.create(headerPrototype);
    header.colSpan = 0;
    header.column = column;
    header.depth = options.depth;
    header.headerGroup = null;
    header.id = options.id ?? column.id;
    header.index = options.index;
    header.isPlaceholder = !!options.isPlaceholder;
    header.placeholderId = options.placeholderId;
    header.rowSpan = 0;
    header.subHeaders = [];
    const initFns = table._headerInstanceInitFns;
    for (let i = 0; i < initFns.length; i++) initFns[i](header);
    return header;
  }

  // node_modules/@tanstack/table-core/dist/features/column-pinning/columnPinningFeature.utils.js
  function getDefaultColumnPinningState() {
    return {
      start: [],
      end: []
    };
  }
  function column_pin(column, position) {
    const leafColumns = column.getLeafColumns();
    const columnIds = [];
    for (let i = 0; i < leafColumns.length; i++) {
      const id = leafColumns[i].id;
      if (id) columnIds.push(id);
    }
    table_setColumnPinning(column.table, (old) => {
      if (position === "end") return {
        start: old.start.filter((d) => !columnIds.includes(d)),
        end: [...old.end.filter((d) => !columnIds.includes(d)), ...columnIds]
      };
      if (position === "start") return {
        start: [...old.start.filter((d) => !columnIds.includes(d)), ...columnIds],
        end: old.end.filter((d) => !columnIds.includes(d))
      };
      return {
        start: old.start.filter((d) => !columnIds.includes(d)),
        end: old.end.filter((d) => !columnIds.includes(d))
      };
    });
  }
  function column_getCanPin(column) {
    return column.getLeafColumns().some((leafColumn) => (leafColumn.columnDef.enablePinning ?? true) && (column.table.options.enableColumnPinning ?? true));
  }
  function column_getIsPinned(column) {
    const leafColumns = column.getLeafColumns();
    const { start, end } = column.table.atoms.columnPinning?.get() ?? getDefaultColumnPinningState();
    for (let i = 0; i < leafColumns.length; i++) if (start.includes(leafColumns[i].id)) return "start";
    for (let i = 0; i < leafColumns.length; i++) if (end.includes(leafColumns[i].id)) return "end";
    return false;
  }
  function column_getPinnedIndex(column) {
    const position = column_getIsPinned(column);
    return position ? column.table.atoms.columnPinning?.get()?.[position].indexOf(column.id) ?? -1 : 0;
  }
  function row_getCenterVisibleCells(row) {
    const allCells = callMemoOrStaticFn(row, "getVisibleCells", row_getVisibleCells);
    const { start, end } = row.table.atoms.columnPinning?.get() ?? getDefaultColumnPinningState();
    if (!start.length && !end.length) return allCells;
    const startAndEnd = [...start, ...end];
    return allCells.filter((d) => !startAndEnd.includes(d.column.id));
  }
  function row_getStartVisibleCells(row) {
    const { start } = row.table.atoms.columnPinning?.get() ?? getDefaultColumnPinningState();
    if (!start.length) return [];
    const allVisibleCells = callMemoOrStaticFn(row, "getVisibleCellsByColumnId", row_getVisibleCellsByColumnId);
    const cells = [];
    for (let i = 0; i < start.length; i++) {
      const cell = allVisibleCells[start[i]];
      if (cell) {
        cell.position = "start";
        cells.push(cell);
      }
    }
    return cells;
  }
  function row_getEndVisibleCells(row) {
    const { end } = row.table.atoms.columnPinning?.get() ?? getDefaultColumnPinningState();
    if (!end.length) return [];
    const allVisibleCells = callMemoOrStaticFn(row, "getVisibleCellsByColumnId", row_getVisibleCellsByColumnId);
    const cells = [];
    for (let i = 0; i < end.length; i++) {
      const cell = allVisibleCells[end[i]];
      if (cell) {
        cell.position = "end";
        cells.push(cell);
      }
    }
    return cells;
  }
  function table_setColumnPinning(table, updater) {
    setStateSlice(table, "columnPinning", updater);
  }
  function table_resetColumnPinning(table, defaultState) {
    table_setColumnPinning(table, defaultState ? getDefaultColumnPinningState() : cloneState(table.initialState.columnPinning ?? getDefaultColumnPinningState()));
  }
  function table_getIsSomeColumnsPinned(table, position) {
    const pinningState = table.atoms.columnPinning?.get();
    if (!position) return Boolean(pinningState?.start.length || pinningState?.end.length);
    return Boolean(pinningState?.[position].length);
  }
  function table_getStartHeaderGroups(table) {
    const allColumns = table.getAllColumns();
    const leafColumnsById = table.getAllLeafColumnsById();
    const { start } = table.atoms.columnPinning?.get() ?? getDefaultColumnPinningState();
    const orderedLeafColumns = [];
    for (let i = 0; i < start.length; i++) {
      const column = leafColumnsById[start[i]];
      if (column && callMemoOrStaticFn(column, "getIsVisible", column_getIsVisible)) orderedLeafColumns.push(column);
    }
    return buildHeaderGroups(allColumns, orderedLeafColumns, table, "start");
  }
  function table_getEndHeaderGroups(table) {
    const allColumns = table.getAllColumns();
    const leafColumnsById = table.getAllLeafColumnsById();
    const { end } = table.atoms.columnPinning?.get() ?? getDefaultColumnPinningState();
    const orderedLeafColumns = [];
    for (let i = 0; i < end.length; i++) {
      const column = leafColumnsById[end[i]];
      if (column && callMemoOrStaticFn(column, "getIsVisible", column_getIsVisible)) orderedLeafColumns.push(column);
    }
    return buildHeaderGroups(allColumns, orderedLeafColumns, table, "end");
  }
  function table_getCenterHeaderGroups(table) {
    const allColumns = table.getAllColumns();
    let leafColumns = callMemoOrStaticFn(table, "getVisibleLeafColumns", table_getVisibleLeafColumns);
    const { start, end } = table.atoms.columnPinning?.get() ?? getDefaultColumnPinningState();
    if (start.length || end.length) {
      const startAndEnd = [...start, ...end];
      leafColumns = leafColumns.filter((column) => !startAndEnd.includes(column.id));
    }
    return buildHeaderGroups(allColumns, leafColumns, table, "center");
  }
  function table_getStartFooterGroups(table) {
    return [...callMemoOrStaticFn(table, "getStartHeaderGroups", table_getStartHeaderGroups)].reverse();
  }
  function table_getEndFooterGroups(table) {
    return [...callMemoOrStaticFn(table, "getEndHeaderGroups", table_getEndHeaderGroups)].reverse();
  }
  function table_getCenterFooterGroups(table) {
    return [...callMemoOrStaticFn(table, "getCenterHeaderGroups", table_getCenterHeaderGroups)].reverse();
  }
  function table_getStartFlatHeaders(table) {
    const leftHeaderGroups = callMemoOrStaticFn(table, "getStartHeaderGroups", table_getStartHeaderGroups);
    const result = [];
    for (let i = 0; i < leftHeaderGroups.length; i++) {
      const headers = leftHeaderGroups[i].headers;
      for (let j = 0; j < headers.length; j++) result.push(headers[j]);
    }
    return result;
  }
  function table_getEndFlatHeaders(table) {
    const rightHeaderGroups = callMemoOrStaticFn(table, "getEndHeaderGroups", table_getEndHeaderGroups);
    const result = [];
    for (let i = 0; i < rightHeaderGroups.length; i++) {
      const headers = rightHeaderGroups[i].headers;
      for (let j = 0; j < headers.length; j++) result.push(headers[j]);
    }
    return result;
  }
  function table_getCenterFlatHeaders(table) {
    const centerHeaderGroups = callMemoOrStaticFn(table, "getCenterHeaderGroups", table_getCenterHeaderGroups);
    const result = [];
    for (let i = 0; i < centerHeaderGroups.length; i++) {
      const headers = centerHeaderGroups[i].headers;
      for (let j = 0; j < headers.length; j++) result.push(headers[j]);
    }
    return result;
  }
  function table_getStartLeafHeaders(table) {
    return callMemoOrStaticFn(table, "getStartFlatHeaders", table_getStartFlatHeaders).filter((header) => !header.subHeaders.length);
  }
  function table_getEndLeafHeaders(table) {
    return callMemoOrStaticFn(table, "getEndFlatHeaders", table_getEndFlatHeaders).filter((header) => !header.subHeaders.length);
  }
  function table_getCenterLeafHeaders(table) {
    return callMemoOrStaticFn(table, "getCenterFlatHeaders", table_getCenterFlatHeaders).filter((header) => !header.subHeaders.length);
  }
  function table_getStartLeafColumns(table) {
    const { start } = table.atoms.columnPinning?.get() ?? getDefaultColumnPinningState();
    const leafColumnsById = table.getAllLeafColumnsById();
    const result = [];
    for (let i = 0; i < start.length; i++) {
      const column = leafColumnsById[start[i]];
      if (column) result.push(column);
    }
    return result;
  }
  function table_getEndLeafColumns(table) {
    const { end } = table.atoms.columnPinning?.get() ?? getDefaultColumnPinningState();
    const leafColumnsById = table.getAllLeafColumnsById();
    const result = [];
    for (let i = 0; i < end.length; i++) {
      const column = leafColumnsById[end[i]];
      if (column) result.push(column);
    }
    return result;
  }
  function table_getCenterLeafColumns(table) {
    const { start, end } = table.atoms.columnPinning?.get() ?? getDefaultColumnPinningState();
    if (!start.length && !end.length) return table.getAllLeafColumns();
    const startAndEnd = [...start, ...end];
    return table.getAllLeafColumns().filter((d) => !startAndEnd.includes(d.id));
  }
  function table_getPinnedLeafColumns(table, position) {
    return !position ? table.getAllLeafColumns() : position === "start" ? callMemoOrStaticFn(table, "getStartLeafColumns", table_getStartLeafColumns) : position === "end" ? callMemoOrStaticFn(table, "getEndLeafColumns", table_getEndLeafColumns) : callMemoOrStaticFn(table, "getCenterLeafColumns", table_getCenterLeafColumns);
  }
  function table_getStartVisibleLeafColumns(table) {
    return callMemoOrStaticFn(table, "getStartLeafColumns", table_getStartLeafColumns).filter((column) => callMemoOrStaticFn(column, "getIsVisible", column_getIsVisible));
  }
  function table_getEndVisibleLeafColumns(table) {
    return callMemoOrStaticFn(table, "getEndLeafColumns", table_getEndLeafColumns).filter((column) => callMemoOrStaticFn(column, "getIsVisible", column_getIsVisible));
  }
  function table_getCenterVisibleLeafColumns(table) {
    return callMemoOrStaticFn(table, "getCenterLeafColumns", table_getCenterLeafColumns).filter((column) => callMemoOrStaticFn(column, "getIsVisible", column_getIsVisible));
  }
  function table_getPinnedVisibleLeafColumns(table, position) {
    return !position ? callMemoOrStaticFn(table, "getVisibleLeafColumns", table_getVisibleLeafColumns) : position === "start" ? callMemoOrStaticFn(table, "getStartVisibleLeafColumns", table_getStartVisibleLeafColumns) : position === "end" ? callMemoOrStaticFn(table, "getEndVisibleLeafColumns", table_getEndVisibleLeafColumns) : callMemoOrStaticFn(table, "getCenterVisibleLeafColumns", table_getCenterVisibleLeafColumns);
  }

  // node_modules/@tanstack/table-core/dist/features/column-visibility/columnVisibilityFeature.utils.js
  function getDefaultColumnVisibilityState() {
    return makeObjectMap();
  }
  function column_toggleVisibility(column, visible) {
    if (column_getCanHide(column)) table_setColumnVisibility(column.table, (old) => {
      const next = Object.assign(makeObjectMap(), old);
      const nextVisible = visible ?? !callMemoOrStaticFn(column, "getIsVisible", column_getIsVisible);
      const leafColumns = column.getLeafColumns();
      for (let i = 0; i < leafColumns.length; i++) {
        const leafColumn = leafColumns[i];
        if (column_getCanHide(leafColumn)) next[leafColumn.id] = nextVisible;
      }
      return next;
    });
  }
  function column_getIsVisible(column) {
    const columnVisibility = column.table.atoms.columnVisibility?.get();
    if (!columnVisibility) return true;
    const childColumns = column.columns;
    if (childColumns.length) return childColumns.some((childColumn) => callMemoOrStaticFn(childColumn, "getIsVisible", column_getIsVisible));
    return (hasOwn(columnVisibility, column.id) ? columnVisibility[column.id] : void 0) ?? true;
  }
  function column_getCanHide(column) {
    return (column.columnDef.enableHiding ?? true) && (column.table.options.enableHiding ?? true);
  }
  function column_getToggleVisibilityHandler(column) {
    return (e) => {
      column_toggleVisibility(column, e.target.checked);
    };
  }
  function row_getVisibleCells(row) {
    const allCells = row.getAllCells();
    const visibleCells = [];
    for (let i = 0; i < allCells.length; i++) {
      const cell = allCells[i];
      if (callMemoOrStaticFn(cell.column, "getIsVisible", column_getIsVisible)) visibleCells.push(cell);
    }
    const { start, end } = row.table.atoms.columnPinning?.get() ?? getDefaultColumnPinningState();
    if (!start.length && !end.length) return visibleCells;
    const visibleCellsByColumnId = callMemoOrStaticFn(row, "getVisibleCellsByColumnId", row_getVisibleCellsByColumnId);
    const startCells = [];
    for (let i = 0; i < start.length; i++) {
      const cell = visibleCellsByColumnId[start[i]];
      if (cell) startCells.push(cell);
    }
    const endCells = [];
    for (let i = 0; i < end.length; i++) {
      const cell = visibleCellsByColumnId[end[i]];
      if (cell) endCells.push(cell);
    }
    const centerCells = [];
    for (let i = 0; i < visibleCells.length; i++) {
      const cell = visibleCells[i];
      const id = cell.column.id;
      if (!start.includes(id) && !end.includes(id)) centerCells.push(cell);
    }
    return [
      ...startCells,
      ...centerCells,
      ...endCells
    ];
  }
  function row_getVisibleCellsByColumnId(row) {
    const result = makeObjectMap();
    const allCells = row.getAllCells();
    for (let i = 0; i < allCells.length; i++) {
      const cell = allCells[i];
      if (callMemoOrStaticFn(cell.column, "getIsVisible", column_getIsVisible)) result[cell.column.id] = cell;
    }
    return result;
  }
  function table_getVisibleFlatColumns(table) {
    return table.getAllFlatColumns().filter((column) => callMemoOrStaticFn(column, "getIsVisible", column_getIsVisible));
  }
  function table_getVisibleLeafColumns(table) {
    return table.getAllLeafColumns().filter((column) => callMemoOrStaticFn(column, "getIsVisible", column_getIsVisible));
  }
  function table_setColumnVisibility(table, updater) {
    setStateSlice(table, "columnVisibility", updater);
  }
  function table_resetColumnVisibility(table, defaultState) {
    table_setColumnVisibility(table, defaultState ? makeObjectMap() : Object.assign(makeObjectMap(), cloneState(table.initialState.columnVisibility ?? {})));
  }
  function table_toggleAllColumnsVisible(table, value) {
    value = value ?? !table_getIsAllColumnsVisible(table);
    const visibility = makeObjectMap();
    const leafColumns = table.getAllLeafColumns();
    for (let i = 0; i < leafColumns.length; i++) {
      const column = leafColumns[i];
      visibility[column.id] = !value ? !column_getCanHide(column) : value;
    }
    table_setColumnVisibility(table, visibility);
  }
  function table_getIsAllColumnsVisible(table) {
    return !table.getAllLeafColumns().some((column) => !callMemoOrStaticFn(column, "getIsVisible", column_getIsVisible));
  }
  function table_getIsSomeColumnsVisible(table) {
    return table.getAllLeafColumns().some((column) => callMemoOrStaticFn(column, "getIsVisible", column_getIsVisible));
  }
  function table_getToggleAllColumnsVisibilityHandler(table) {
    return (e) => {
      table_toggleAllColumnsVisible(table, e.target.checked);
    };
  }

  // node_modules/@tanstack/table-core/dist/core/headers/buildHeaderGroups.js
  function getMaxHeaderDepth(columns, depth = 1) {
    let maxDepth = depth;
    for (let i = 0; i < columns.length; i++) {
      const column = columns[i];
      if (callMemoOrStaticFn(column, "getIsVisible", column_getIsVisible) && column.columns.length) maxDepth = Math.max(maxDepth, getMaxHeaderDepth(column.columns, depth + 1));
    }
    return maxDepth;
  }
  function formatHeaderGroupId(headerFamily, depth) {
    return headerFamily ? `${headerFamily}_${depth}` : String(depth);
  }
  function formatHeaderId(headerFamily, depth, columnId, childHeaderId) {
    let id = headerFamily ?? "";
    if (depth) id = id ? `${id}_${depth}` : String(depth);
    if (columnId) id = id ? `${id}_${columnId}` : columnId;
    if (childHeaderId) id = id ? `${id}_${childHeaderId}` : childHeaderId;
    return id;
  }
  function countPendingHeadersForColumn(headers, column) {
    let count = 0;
    for (let i = 0; i < headers.length; i++) if (headers[i].column === column) count++;
    return count;
  }
  function constructHeaderGroup(headersToGroup, depth, table, headerFamily, headerGroups, headerGroupInitFns) {
    const headerGroup = {
      depth,
      id: formatHeaderGroupId(headerFamily, depth),
      headers: []
    };
    const pendingParentHeaders = [];
    for (let i = 0; i < headersToGroup.length; i++) {
      if (!(i in headersToGroup)) continue;
      const headerToGroup = headersToGroup[i];
      const latestPendingParentHeader = pendingParentHeaders[pendingParentHeaders.length - 1];
      const isLeafHeader = headerToGroup.column.depth === headerGroup.depth;
      let column;
      let isPlaceholder = false;
      if (isLeafHeader && headerToGroup.column.parent) column = headerToGroup.column.parent;
      else {
        column = headerToGroup.column;
        isPlaceholder = true;
      }
      if (latestPendingParentHeader && latestPendingParentHeader.column === column) latestPendingParentHeader.subHeaders.push(headerToGroup);
      else {
        const header = constructHeader(table, column, {
          id: formatHeaderId(headerFamily, depth, column.id, headerToGroup.id),
          isPlaceholder,
          placeholderId: isPlaceholder ? String(countPendingHeadersForColumn(pendingParentHeaders, column)) : void 0,
          depth,
          index: pendingParentHeaders.length
        });
        header.subHeaders.push(headerToGroup);
        pendingParentHeaders.push(header);
      }
      headerGroup.headers.push(headerToGroup);
      headerToGroup.headerGroup = headerGroup;
    }
    for (let i = 0; i < headerGroupInitFns.length; i++) headerGroupInitFns[i](headerGroup);
    headerGroups.push(headerGroup);
    if (depth > 0) constructHeaderGroup(pendingParentHeaders, depth - 1, table, headerFamily, headerGroups, headerGroupInitFns);
  }
  function updateHeaderSpans(headers) {
    for (let i = 0; i < headers.length; i++) {
      const header = headers[i];
      if (!callMemoOrStaticFn(header.column, "getIsVisible", column_getIsVisible)) continue;
      let colSpan = 0;
      if (header.subHeaders.length) {
        updateHeaderSpans(header.subHeaders);
        for (let j = 0; j < header.subHeaders.length; j++) {
          const child = header.subHeaders[j];
          if (!callMemoOrStaticFn(child.column, "getIsVisible", column_getIsVisible)) continue;
          colSpan += child.colSpan;
        }
      } else colSpan = 1;
      header.colSpan = colSpan;
      if (header.isPlaceholder && header.subHeaders.length === 1 && header.subHeaders[0].column === header.column) {
        let rowSpan = 1;
        let chainChild = header.subHeaders[0];
        while (chainChild) {
          chainChild.rowSpan = 0;
          rowSpan++;
          chainChild = chainChild.subHeaders.length === 1 && chainChild.subHeaders[0].column === header.column ? chainChild.subHeaders[0] : void 0;
        }
        header.rowSpan = rowSpan;
      } else header.rowSpan = 1;
    }
  }
  function buildHeaderGroups(allColumns, columnsToGroup, table, headerFamily) {
    const maxDepth = getMaxHeaderDepth(allColumns);
    const headerGroups = [];
    const headerGroupInitFns = table._headerGroupInstanceInitFns;
    const bottomHeaders = new Array(columnsToGroup.length);
    for (let i = 0; i < columnsToGroup.length; i++) {
      if (!(i in columnsToGroup)) continue;
      bottomHeaders[i] = constructHeader(table, columnsToGroup[i], {
        depth: maxDepth,
        index: i
      });
    }
    constructHeaderGroup(bottomHeaders, maxDepth - 1, table, headerFamily, headerGroups, headerGroupInitFns);
    headerGroups.reverse();
    updateHeaderSpans(headerGroups[0]?.headers ?? []);
    return headerGroups;
  }

  // node_modules/@tanstack/table-core/dist/core/columns/constructColumn.js
  function getColumnPrototype(table) {
    if (!table._columnPrototype) {
      table._columnPrototype = { table };
      const features = Object.values(table._features);
      for (let i = 0; i < features.length; i++) features[i].assignColumnPrototype?.(table._columnPrototype, table);
    }
    return table._columnPrototype;
  }
  function constructColumn(table, columnDef, depth, parent) {
    const resolvedColumnDef = {
      ...table.getDefaultColumnDef(),
      ...columnDef
    };
    const accessorKey = resolvedColumnDef.accessorKey;
    const accessorKeyString = accessorKey === void 0 ? void 0 : String(accessorKey);
    const id = resolvedColumnDef.id ?? accessorKeyString?.replaceAll(".", "_") ?? (typeof resolvedColumnDef.header === "string" ? resolvedColumnDef.header : void 0);
    let accessorFn;
    if (resolvedColumnDef.accessorFn) accessorFn = resolvedColumnDef.accessorFn;
    else if (accessorKey !== void 0) if (typeof accessorKey === "string" && accessorKey.includes(".")) {
      const keys = accessorKey.split(".");
      accessorFn = (originalRow) => {
        let result = originalRow;
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          result = result?.[key];
          if (result === void 0) console.warn(`"${key}" in deeply nested key "${accessorKey}" returned undefined.`);
        }
        return result;
      };
    } else accessorFn = (originalRow) => originalRow[resolvedColumnDef.accessorKey];
    if (!id) {
      if (true) throw new Error(resolvedColumnDef.accessorFn ? `coreColumnsFeature require an id when using an accessorFn` : `coreColumnsFeature require an id when using a non-string header`);
      throw new Error();
    }
    const columnPrototype = getColumnPrototype(table);
    const column = Object.create(columnPrototype);
    column.accessorFn = accessorFn;
    column.columnDef = resolvedColumnDef;
    column.columns = [];
    column.depth = depth;
    column.id = `${String(id)}`;
    column.parent = parent;
    const initFns = table._columnInstanceInitFns;
    for (let i = 0; i < initFns.length; i++) initFns[i](column);
    return column;
  }

  // node_modules/@tanstack/table-core/dist/features/column-ordering/columnOrderingFeature.utils.js
  function getDefaultColumnOrderState() {
    return [];
  }
  function table_getColumnIndexes(table) {
    const buildIndexes = (columns) => {
      const indexes = makeObjectMap();
      for (let i = 0; i < columns.length; i++) indexes[columns[i].id] = i;
      return indexes;
    };
    return {
      all: buildIndexes(table_getPinnedVisibleLeafColumns(table)),
      center: buildIndexes(table_getPinnedVisibleLeafColumns(table, "center")),
      start: buildIndexes(table_getPinnedVisibleLeafColumns(table, "start")),
      end: buildIndexes(table_getPinnedVisibleLeafColumns(table, "end"))
    };
  }
  function column_getIndex(column, position) {
    return callMemoOrStaticFn(column.table, "getColumnIndexes", table_getColumnIndexes)[position === "start" ? "start" : position === "end" ? "end" : position === "center" ? "center" : "all"][column.id] ?? -1;
  }
  function column_getIsFirstColumn(column, position) {
    return table_getPinnedVisibleLeafColumns(column.table, position)[0]?.id === column.id;
  }
  function column_getIsLastColumn(column, position) {
    const columns = table_getPinnedVisibleLeafColumns(column.table, position);
    return columns[columns.length - 1]?.id === column.id;
  }
  function table_setColumnOrder(table, updater) {
    setStateSlice(table, "columnOrder", updater);
  }
  function table_resetColumnOrder(table, defaultState) {
    table_setColumnOrder(table, defaultState ? [] : cloneState(table.initialState.columnOrder ?? []));
  }
  function table_getOrderColumnsFn(table) {
    const columnOrder = table.atoms.columnOrder?.get();
    return (columns) => {
      let orderedColumns = [];
      if (!columnOrder?.length) orderedColumns = columns;
      else {
        const remaining = /* @__PURE__ */ new Map();
        for (let i = 0; i < columns.length; i++) {
          const column = columns[i];
          remaining.set(column.id, column);
        }
        for (let i = 0; i < columnOrder.length; i++) {
          const id = columnOrder[i];
          const column = remaining.get(id);
          if (column) {
            orderedColumns.push(column);
            remaining.delete(id);
          }
        }
        for (let i = 0; i < columns.length; i++) {
          const column = columns[i];
          if (remaining.has(column.id)) orderedColumns.push(column);
        }
      }
      return orderColumns(table, orderedColumns);
    };
  }
  function orderColumns(table, leafColumns) {
    const grouping = table.atoms.grouping?.get() ?? [];
    const { groupedColumnMode } = table.options;
    if (!grouping.length || !groupedColumnMode) return leafColumns;
    const nonGroupingColumns = leafColumns.filter((col) => !grouping.includes(col.id));
    if (groupedColumnMode === "remove") return nonGroupingColumns;
    const leafColumnsById = /* @__PURE__ */ new Map();
    for (let i = 0; i < leafColumns.length; i++) {
      const col = leafColumns[i];
      leafColumnsById.set(col.id, col);
    }
    const groupingColumns = [];
    for (let i = 0; i < grouping.length; i++) {
      const col = leafColumnsById.get(grouping[i]);
      if (col) groupingColumns.push(col);
    }
    return [...groupingColumns, ...nonGroupingColumns];
  }

  // node_modules/@tanstack/table-core/dist/core/columns/coreColumnsFeature.utils.js
  function column_getFlatColumns(column) {
    return [column, ...column.columns.flatMap((col) => col.getFlatColumns())];
  }
  function column_getLeafColumns(column) {
    if (column.columns.length) {
      const leafColumns = column.columns.flatMap((col) => col.getLeafColumns());
      return callMemoOrStaticFn(column.table, "getOrderColumns", table_getOrderColumnsFn)(leafColumns);
    }
    return [column];
  }
  function table_getDefaultColumnDef(table) {
    return {
      header: (props) => {
        const resolvedColumnDef = props.header.column.columnDef;
        if (resolvedColumnDef.accessorKey) return resolvedColumnDef.accessorKey;
        if (resolvedColumnDef.accessorFn) return resolvedColumnDef.id;
        return null;
      },
      cell: (props) => props.renderValue()?.toString?.() ?? null,
      ...Object.values(table._features).reduce((obj, feature) => {
        return Object.assign(obj, feature.getDefaultColumnDef?.());
      }, {}),
      ...table.options.defaultColumn
    };
  }
  function constructColumns(table, columnDefs, parent, depth = 0) {
    const columns = new Array(columnDefs.length);
    for (let i = 0; i < columnDefs.length; i++) {
      if (!(i in columnDefs)) continue;
      const columnDef = columnDefs[i];
      const column = constructColumn(table, columnDef, depth, parent);
      const groupingColumnDef = columnDef;
      column.columns = groupingColumnDef.columns ? constructColumns(table, groupingColumnDef.columns, column, depth + 1) : [];
      columns[i] = column;
    }
    return columns;
  }
  function table_getAllColumns(table) {
    return constructColumns(table, table.options.columns);
  }
  function table_getAllFlatColumns(table) {
    return table.getAllColumns().flatMap((column) => column.getFlatColumns());
  }
  function table_getAllFlatColumnsById(table) {
    const result = makeObjectMap();
    const flatColumns = table.getAllFlatColumns();
    for (let i = 0; i < flatColumns.length; i++) {
      const column = flatColumns[i];
      result[column.id] = column;
    }
    return result;
  }
  function table_getAllLeafColumns(table) {
    const leafColumns = table.getAllColumns().flatMap((c) => c.getLeafColumns());
    return callMemoOrStaticFn(table, "getOrderColumns", table_getOrderColumnsFn)(leafColumns);
  }
  function table_getAllLeafColumnsById(table) {
    const result = makeObjectMap();
    const leafColumns = table.getAllLeafColumns();
    for (let i = 0; i < leafColumns.length; i++) {
      const column = leafColumns[i];
      result[column.id] = column;
    }
    return result;
  }
  function table_getColumn(table, columnId) {
    const column = table.getAllFlatColumnsById()[columnId];
    if (!column) console.warn(`[Table] Column with id '${columnId}' does not exist.`);
    return column;
  }

  // node_modules/@tanstack/table-core/dist/core/columns/coreColumnsFeature.js
  var coreColumnsFeature = {
    assignColumnPrototype: (prototype, table) => {
      assignPrototypeAPIs("coreColumnsFeature", prototype, table, {
        column_getFlatColumns: {
          fn: (column) => column_getFlatColumns(column),
          memoDeps: (column) => [column.table.options.columns]
        },
        column_getLeafColumns: {
          fn: (column) => column_getLeafColumns(column),
          memoDeps: (column) => [
            column.table.atoms.columnOrder?.get(),
            column.table.atoms.grouping?.get(),
            column.table.options.columns,
            column.table.options.groupedColumnMode
          ]
        }
      });
    },
    constructTableAPIs: (table) => {
      assignTableAPIs("coreColumnsFeature", table, {
        table_getDefaultColumnDef: {
          fn: () => table_getDefaultColumnDef(table),
          memoDeps: () => [table.options.defaultColumn]
        },
        table_getAllColumns: {
          fn: () => table_getAllColumns(table),
          memoDeps: () => [table.options.columns]
        },
        table_getAllFlatColumns: {
          fn: () => table_getAllFlatColumns(table),
          memoDeps: () => [table.options.columns]
        },
        table_getAllFlatColumnsById: {
          fn: () => table_getAllFlatColumnsById(table),
          memoDeps: () => [table.options.columns]
        },
        table_getAllLeafColumns: {
          fn: () => table_getAllLeafColumns(table),
          memoDeps: () => [
            table.atoms.columnOrder?.get(),
            table.atoms.grouping?.get(),
            table.options.columns,
            table.options.groupedColumnMode
          ]
        },
        table_getAllLeafColumnsById: {
          fn: () => table_getAllLeafColumnsById(table),
          memoDeps: () => [table.getAllLeafColumns()]
        },
        table_getColumn: { fn: (columnId) => table_getColumn(table, columnId) }
      });
    }
  };

  // node_modules/@tanstack/table-core/dist/core/headers/coreHeadersFeature.utils.js
  function collectLeafHeaders(header, leafHeaders) {
    for (let i = 0; i < header.subHeaders.length; i++) collectLeafHeaders(header.subHeaders[i], leafHeaders);
    leafHeaders.push(header);
  }
  function header_getLeafHeaders(header) {
    const leafHeaders = [];
    collectLeafHeaders(header, leafHeaders);
    return leafHeaders;
  }
  function header_getContext(header) {
    return {
      column: header.column,
      header,
      table: header.column.table
    };
  }
  function table_getHeaderGroups(table) {
    const { start, end } = table.atoms.columnPinning?.get() ?? getDefaultColumnPinningState();
    const allColumns = table.getAllColumns();
    const leafColumns = callMemoOrStaticFn(table, "getVisibleLeafColumns", table_getVisibleLeafColumns);
    if (!start.length && !end.length) return buildHeaderGroups(allColumns, leafColumns, table);
    const leafColumnsById = table.getAllLeafColumnsById();
    const leftColumns = [];
    for (let i = 0; i < start.length; i++) {
      const column = leafColumnsById[start[i]];
      if (column && callMemoOrStaticFn(column, "getIsVisible", column_getIsVisible)) leftColumns.push(column);
    }
    const rightColumns = [];
    for (let i = 0; i < end.length; i++) {
      const column = leafColumnsById[end[i]];
      if (column && callMemoOrStaticFn(column, "getIsVisible", column_getIsVisible)) rightColumns.push(column);
    }
    const centerColumns = leafColumns.filter((column) => !start.includes(column.id) && !end.includes(column.id));
    return buildHeaderGroups(allColumns, [
      ...leftColumns,
      ...centerColumns,
      ...rightColumns
    ], table);
  }
  function table_getFooterGroups(table) {
    return [...table.getHeaderGroups()].reverse();
  }
  function table_getFlatHeaders(table) {
    const headerGroups = table.getHeaderGroups();
    const result = [];
    for (let i = 0; i < headerGroups.length; i++) {
      const headers = headerGroups[i].headers;
      for (let j = 0; j < headers.length; j++) result.push(headers[j]);
    }
    return result;
  }
  function table_getLeafHeaders(table) {
    const topHeaders = table.getHeaderGroups()[0]?.headers ?? [];
    const result = [];
    for (let i = 0; i < topHeaders.length; i++) {
      const leafHeaders = topHeaders[i].getLeafHeaders();
      for (let j = 0; j < leafHeaders.length; j++) result.push(leafHeaders[j]);
    }
    return result;
  }

  // node_modules/@tanstack/table-core/dist/core/headers/coreHeadersFeature.js
  var coreHeadersFeature = {
    assignHeaderPrototype: (prototype, table) => {
      assignPrototypeAPIs("coreHeadersFeature", prototype, table, {
        header_getLeafHeaders: {
          fn: (header) => header_getLeafHeaders(header),
          memoDeps: (header) => [header.column.table.options.columns]
        },
        header_getContext: {
          fn: (header) => header_getContext(header),
          memoDeps: (header) => [header.column.table.options.columns]
        }
      });
    },
    constructTableAPIs: (table) => {
      assignTableAPIs("coreHeadersFeature", table, {
        table_getHeaderGroups: {
          fn: () => table_getHeaderGroups(table),
          memoDeps: () => [
            table.options.columns,
            table.atoms.columnOrder?.get(),
            table.atoms.grouping?.get(),
            table.atoms.columnPinning?.get(),
            table.atoms.columnVisibility?.get(),
            table.options.groupedColumnMode
          ]
        },
        table_getFooterGroups: {
          fn: () => table_getFooterGroups(table),
          memoDeps: () => [table.getHeaderGroups()]
        },
        table_getFlatHeaders: {
          fn: () => table_getFlatHeaders(table),
          memoDeps: () => [table.getHeaderGroups()]
        },
        table_getLeafHeaders: {
          fn: () => table_getLeafHeaders(table),
          memoDeps: () => [table.getHeaderGroups()]
        }
      });
    }
  };

  // node_modules/@tanstack/table-core/dist/core/rows/constructRow.js
  function getRowPrototype(table) {
    if (!table._rowPrototype) {
      table._rowPrototype = { table };
      const features = Object.values(table._features);
      for (let i = 0; i < features.length; i++) features[i].assignRowPrototype?.(table._rowPrototype, table);
    }
    return table._rowPrototype;
  }
  var constructRow = (table, id, original, rowIndex, depth, subRows, parentId) => {
    const rowPrototype = getRowPrototype(table);
    const row = Object.create(rowPrototype);
    row._displayIndexCache = -1;
    row._uniqueValuesCache = makeObjectMap();
    row._valuesCache = makeObjectMap();
    row.depth = depth;
    row.id = id;
    row.index = rowIndex;
    row.original = original;
    row.parentId = parentId;
    row.subRows = subRows ?? [];
    const initFns = table._rowInstanceInitFns;
    for (let i = 0; i < initFns.length; i++) initFns[i](row);
    return row;
  };

  // node_modules/@tanstack/table-core/dist/features/row-sorting/sortFns.js
  var reSplitAlphaNumeric = /([0-9]+)/gm;
  function constructSortFn(def) {
    const sortFn = Object.assign((rowA, rowB, columnId) => {
      let dataValueA = rowA.getValue(columnId);
      let dataValueB = rowB.getValue(columnId);
      const resolveDataValue = sortFn.resolveDataValue;
      if (resolveDataValue) {
        dataValueA = resolveDataValue(dataValueA);
        dataValueB = resolveDataValue(dataValueB);
      }
      return sortFn.sort(dataValueA, dataValueB, rowA, rowB, columnId);
    }, def);
    return sortFn;
  }
  var sortFn_alphanumeric = constructSortFn({
    resolveDataValue: (dataValue) => toString(dataValue).toLowerCase(),
    sort: (dataValueA, dataValueB) => compareAlphanumeric(dataValueA, dataValueB)
  });
  var sortFn_alphanumericCaseSensitive = constructSortFn({
    resolveDataValue: (dataValue) => toString(dataValue),
    sort: (dataValueA, dataValueB) => compareAlphanumeric(dataValueA, dataValueB)
  });
  var sortFn_text = constructSortFn({
    resolveDataValue: (dataValue) => toString(dataValue).toLowerCase(),
    sort: (dataValueA, dataValueB) => compareBasic(dataValueA, dataValueB)
  });
  var sortFn_textCaseSensitive = constructSortFn({
    resolveDataValue: (dataValue) => toString(dataValue),
    sort: (dataValueA, dataValueB) => compareBasic(dataValueA, dataValueB)
  });
  var sortFn_datetime = constructSortFn({
    resolveDataValue: (dataValue) => toDateSortValue(dataValue),
    sort: (dataValueA, dataValueB) => dataValueA > dataValueB ? 1 : dataValueA < dataValueB ? -1 : 0
  });
  var sortFn_basic = constructSortFn({ sort: (dataValueA, dataValueB) => compareBasic(dataValueA, dataValueB) });
  function compareBasic(a, b) {
    return a === b ? 0 : a > b ? 1 : -1;
  }
  function toDateSortValue(value) {
    return value instanceof Date ? value.getTime() : value;
  }
  function toString(a) {
    if (typeof a === "number") {
      if (isNaN(a) || a === Infinity || a === -Infinity) return "";
      return String(a);
    }
    if (typeof a === "string") return a;
    return "";
  }
  function compareAlphanumeric(aStr, bStr) {
    let ai = 0;
    let bi = 0;
    const aLen = aStr.length;
    const bLen = bStr.length;
    while (ai < aLen && bi < bLen) {
      const aIsNumeric = isDigit(aStr.charCodeAt(ai));
      const bIsNumeric = isDigit(bStr.charCodeAt(bi));
      const aEnd = findChunkEnd(aStr, ai, aIsNumeric);
      const bEnd = findChunkEnd(bStr, bi, bIsNumeric);
      if (!aIsNumeric && !bIsNumeric) {
        const stringComparison = compareStringChunks(aStr, ai, aEnd, bStr, bi, bEnd);
        if (stringComparison) return stringComparison;
        ai = aEnd;
        bi = bEnd;
        continue;
      }
      if (aIsNumeric !== bIsNumeric) return aIsNumeric ? 1 : -1;
      const numericComparison = compareNumericChunks(aStr, ai, aEnd, bStr, bi, bEnd);
      if (numericComparison) return numericComparison;
      ai = aEnd;
      bi = bEnd;
    }
    return countRemainingChunks(aStr, ai) - countRemainingChunks(bStr, bi);
  }
  function isDigit(charCode) {
    return charCode >= 48 && charCode <= 57;
  }
  function findChunkEnd(str, start, isNumeric) {
    let end = start + 1;
    while (end < str.length && isDigit(str.charCodeAt(end)) === isNumeric) end++;
    return end;
  }
  function compareStringChunks(aStr, aStart, aEnd, bStr, bStart, bEnd) {
    const aLength = aEnd - aStart;
    const bLength = bEnd - bStart;
    const minLength = aLength < bLength ? aLength : bLength;
    for (let i = 0; i < minLength; i++) {
      const aCode = aStr.charCodeAt(aStart + i);
      const bCode = bStr.charCodeAt(bStart + i);
      if (aCode > bCode) return 1;
      if (bCode > aCode) return -1;
    }
    if (aLength > bLength) return 1;
    if (bLength > aLength) return -1;
    return 0;
  }
  function compareNumericChunks(aStr, aStart, aEnd, bStr, bStart, bEnd) {
    let aSignificantStart = aStart;
    while (aSignificantStart < aEnd && aStr.charCodeAt(aSignificantStart) === 48) aSignificantStart++;
    let bSignificantStart = bStart;
    while (bSignificantStart < bEnd && bStr.charCodeAt(bSignificantStart) === 48) bSignificantStart++;
    const aSignificantLength = aEnd - aSignificantStart;
    const bSignificantLength = bEnd - bSignificantStart;
    if (aSignificantLength === 0 && bSignificantLength === 0) return 0;
    if (aSignificantLength <= 15 && bSignificantLength <= 15) {
      const an2 = parseSmallInt(aStr, aSignificantStart, aEnd);
      const bn2 = parseSmallInt(bStr, bSignificantStart, bEnd);
      if (an2 > bn2) return 1;
      if (bn2 > an2) return -1;
      return 0;
    }
    const an = parseInt(aStr.slice(aStart, aEnd), 10);
    const bn = parseInt(bStr.slice(bStart, bEnd), 10);
    if (an > bn) return 1;
    if (bn > an) return -1;
    return 0;
  }
  function parseSmallInt(str, start, end) {
    let result = 0;
    for (let i = start; i < end; i++) result = result * 10 + str.charCodeAt(i) - 48;
    return result;
  }
  function countRemainingChunks(str, start) {
    let count = 0;
    let index = start;
    while (index < str.length) {
      count++;
      index = findChunkEnd(str, index, isDigit(str.charCodeAt(index)));
    }
    return count;
  }

  // node_modules/@tanstack/table-core/dist/features/cell-selection/cellSelectionFeature.utils.js
  function getDefaultCellSelectionState() {
    return [];
  }
  function table_resetCellSelection(table, defaultState) {
    setStateSlice(table, "cellSelection", defaultState ? getDefaultCellSelectionState() : cloneState(table.initialState.cellSelection) ?? getDefaultCellSelectionState());
  }
  function table_autoResetCellSelection(table) {
    if (!table.atoms.cellSelection) return;
    if (table.options.autoResetAll ?? table.options.autoResetCellSelection ?? true) table._reactivity.schedule(() => table_resetCellSelection(table));
  }

  // node_modules/@tanstack/table-core/dist/features/row-expanding/rowExpandingFeature.utils.js
  function getDefaultExpandedState() {
    return makeObjectMap();
  }
  function table_autoResetExpanded(table) {
    if (!table.atoms.expanded) return;
    if (table.options.autoResetAll ?? table.options.autoResetExpanded ?? !table.options.manualExpanding) table._reactivity.schedule(() => table_resetExpanded(table));
  }
  function table_setExpanded(table, updater) {
    table.options.onExpandedChange?.(updater);
  }
  function table_toggleAllRowsExpanded(table, expanded) {
    const currentExpanded = table.atoms.expanded?.get() ?? {};
    if (expanded ?? !table_getIsAllRowsExpanded(table)) {
      if (currentExpanded === true) return;
      if (!table_getCanSomeRowsExpand(table)) return;
      table_setExpanded(table, true);
    } else {
      if (currentExpanded !== true && !Object.keys(currentExpanded).length) return;
      table_setExpanded(table, makeObjectMap());
    }
  }
  function table_resetExpanded(table, defaultState) {
    const initialExpanded = table.initialState.expanded;
    setStateSlice(table, "expanded", defaultState ? makeObjectMap() : initialExpanded === true ? true : Object.assign(makeObjectMap(), cloneState(initialExpanded ?? {})));
  }
  function table_getCanSomeRowsExpand(table) {
    return table.getPrePaginatedRowModel().flatRows.some((row) => row_getCanExpand(row));
  }
  function table_getToggleAllRowsExpandedHandler(table) {
    return (_e) => {
      table_toggleAllRowsExpanded(table);
    };
  }
  function table_getIsSomeRowsExpanded(table) {
    const expanded = table.atoms.expanded?.get() ?? {};
    return expanded === true || Object.values(expanded).some(Boolean);
  }
  function table_getIsAllRowsExpanded(table) {
    const expanded = table.atoms.expanded?.get() ?? {};
    if (expanded === true) return true;
    if (!Object.keys(expanded).length) return false;
    const expandableRows = table.getRowModel().flatRows.filter((row) => row_getCanExpand(row));
    if (!expandableRows.length) return false;
    if (expandableRows.some((row) => !row_getIsExpanded(row))) return false;
    return true;
  }
  function table_getExpandedDepth(table) {
    let maxDepth = 0;
    const expanded = table.atoms.expanded?.get();
    (expanded === true ? Object.values(table.getRowModel().rowsById).filter((row) => row_getCanExpand(row)).map((row) => row.id) : Object.keys(expanded ?? {})).forEach((id) => {
      const splitId = id.split(".");
      maxDepth = Math.max(maxDepth, splitId.length);
    });
    return maxDepth;
  }
  function row_toggleExpanded(row, expanded) {
    const currentExpanded = row.table.atoms.expanded?.get() ?? {};
    const currentExists = currentExpanded === true || isExpandedRowId(currentExpanded, row.id);
    const targetExpanded = expanded ?? !currentExists;
    if (targetExpanded === currentExists) return;
    if (targetExpanded && !row_getCanExpand(row)) return;
    table_setExpanded(row.table, (old) => {
      const exists = old === true ? true : isExpandedRowId(old, row.id);
      let oldExpanded = makeObjectMap();
      if (old === true) Object.values(row.table.getRowModel().rowsById).forEach((rowModelRow) => {
        if (row_getCanExpand(rowModelRow)) oldExpanded[rowModelRow.id] = true;
      });
      else oldExpanded = Object.assign(makeObjectMap(), old);
      if (!exists && targetExpanded) {
        oldExpanded[row.id] = true;
        return oldExpanded;
      }
      if (exists && !targetExpanded) {
        const rest = makeObjectMap();
        const rowIds = Object.keys(oldExpanded);
        for (let i = 0; i < rowIds.length; i++) {
          const rowId = rowIds[i];
          if (rowId !== row.id && oldExpanded[rowId]) rest[rowId] = true;
        }
        return rest;
      }
      return old;
    });
  }
  function row_getIsExpanded(row) {
    const expanded = row.table.atoms.expanded?.get() ?? {};
    return !!(row.table.options.getIsRowExpanded?.(row) ?? (expanded === true || isExpandedRowId(expanded, row.id)));
  }
  function isExpandedRowId(expanded, rowId) {
    return !!(expanded && expanded !== true && hasOwn(expanded, rowId) && expanded[rowId]);
  }
  function row_getCanExpand(row) {
    return row.table.options.getRowCanExpand?.(row) ?? ((row.table.options.enableExpanding ?? true) && !!row.subRows.length);
  }
  function row_getIsAllParentsExpanded(row) {
    let isFullyExpanded = true;
    let currentRow = row;
    while (isFullyExpanded && currentRow.parentId) {
      currentRow = row.table.getRow(currentRow.parentId, true);
      isFullyExpanded = row_getIsExpanded(currentRow);
    }
    return isFullyExpanded;
  }
  function row_getToggleExpandedHandler(row) {
    const canExpand = row_getCanExpand(row);
    return () => {
      if (!canExpand) return;
      row_toggleExpanded(row);
    };
  }

  // node_modules/@tanstack/table-core/dist/features/row-pagination/rowPaginationFeature.utils.js
  var defaultPageIndex = 0;
  function table_autoResetPageIndex(table) {
    if (table.options.autoResetAll ?? table.options.autoResetPageIndex ?? !table.options.manualPagination) {
      if ((table.atoms.pagination?.get()?.pageIndex ?? defaultPageIndex) === defaultPageIndex) return;
      table_resetPageIndex(table, true);
    }
  }
  function table_setPagination(table, updater) {
    setStateSlice(table, "pagination", updater);
  }
  function table_setPageIndex(table, updater) {
    table_setPagination(table, (old) => {
      let pageIndex = functionalUpdate(updater, old.pageIndex);
      const maxPageIndex = typeof table.options.pageCount === "undefined" || table.options.pageCount === -1 ? Number.MAX_SAFE_INTEGER : table.options.pageCount - 1;
      pageIndex = Math.max(0, Math.min(pageIndex, maxPageIndex));
      return {
        ...old,
        pageIndex
      };
    });
  }
  function table_resetPageIndex(table, defaultState) {
    table_setPageIndex(table, defaultState ? defaultPageIndex : table.initialState.pagination?.pageIndex ?? defaultPageIndex);
  }

  // node_modules/@tanstack/table-core/dist/features/row-sorting/rowSortingFeature.utils.js
  function getDefaultSortingState() {
    return [];
  }
  function table_setSorting(table, updater) {
    setStateSlice(table, "sorting", updater);
  }
  function table_resetSorting(table, defaultState) {
    table_setSorting(table, defaultState ? [] : cloneState(table.initialState.sorting ?? []));
  }
  function table_autoResetSorting(table) {
    if (!table.atoms.sorting) return;
    if (table.options.autoResetAll ?? table.options.autoResetSorting ?? false) table_resetSorting(table);
  }
  function column_getAutoSortFn(column) {
    const sortFns2 = column.table._rowModelFns.sortFns;
    const firstRows = column.table.getFilteredRowModel().flatRows.slice(0, 10);
    let sortFnName;
    let isString = false;
    for (let i = 0; i < firstRows.length; i++) {
      const value = firstRows[i].getValue(column.id);
      if (Object.prototype.toString.call(value) === "[object Date]") {
        sortFnName = "datetime";
        break;
      }
      if (typeof value === "string") {
        isString = true;
        if (value.split(reSplitAlphaNumeric).length > 1) {
          sortFnName = "alphanumeric";
          break;
        }
      }
    }
    if (!sortFnName && isString) sortFnName = "text";
    if (sortFnName) {
      let sortFn = sortFns2?.[sortFnName];
      if (!sortFn) {
        if (true) console.warn(`sortFn '${sortFnName}' (auto) for column '${column.id}' is not registered`);
        if (sortFnName === "alphanumeric") sortFn = sortFns2?.text;
      }
      if (sortFn) return sortFn;
    }
    return sortFn_basic;
  }
  function column_getAutoSortDir(column) {
    const firstRows = column.table.getFilteredRowModel().flatRows.slice(0, 10);
    for (let i = 0; i < firstRows.length; i++) {
      const value = firstRows[i].getValue(column.id);
      if (value == null) continue;
      return typeof value === "string" ? "asc" : "desc";
    }
    return "desc";
  }
  function column_getSortFn(column) {
    const sortFns2 = column.table._rowModelFns.sortFns;
    if (isFunction(column.columnDef.sortFn)) return column.columnDef.sortFn;
    if (column.columnDef.sortFn === "auto") return column_getAutoSortFn(column);
    const sortFn = sortFns2?.[column.columnDef.sortFn];
    if (!sortFn) console.warn(`sortFn '${String(column.columnDef.sortFn)}' for column '${column.id}' is not registered`);
    return sortFn ?? sortFn_basic;
  }
  function column_toggleSorting(column, desc, multi) {
    const nextSortingOrder = column_getNextSortingOrder(column, multi && column_getCanMultiSort(column));
    const hasManualValue = typeof desc !== "undefined";
    table_setSorting(column.table, (old) => {
      const existingIndex = old.findIndex((d) => d.id === column.id);
      const existingSorting = existingIndex === -1 ? void 0 : old[existingIndex];
      let newSorting = [];
      let sortAction;
      const nextDesc = hasManualValue ? desc : nextSortingOrder === "desc";
      const isMultiMode = !!(old.length && column_getCanMultiSort(column) && multi);
      if (isMultiMode) if (existingSorting) sortAction = "toggle";
      else sortAction = "add";
      else if (existingSorting) sortAction = "toggle";
      else sortAction = "replace";
      if (sortAction === "toggle") {
        if (!hasManualValue) {
          if (!nextSortingOrder) sortAction = "remove";
        }
      }
      if (sortAction === "add") {
        newSorting = [...old, {
          id: column.id,
          desc: nextDesc
        }];
        newSorting.splice(0, newSorting.length - (column.table.options.maxMultiSortColCount ?? Number.MAX_SAFE_INTEGER));
      } else if (sortAction === "toggle") newSorting = isMultiMode ? old.map((d) => {
        if (d.id === column.id) return {
          ...d,
          desc: nextDesc
        };
        return d;
      }) : [{
        id: column.id,
        desc: nextDesc
      }];
      else if (sortAction === "remove") newSorting = isMultiMode ? old.filter((d) => d.id !== column.id) : [];
      else newSorting = [{
        id: column.id,
        desc: nextDesc
      }];
      return newSorting;
    });
  }
  function column_getFirstSortDir(column) {
    return column.columnDef.sortDescFirst ?? column.table.options.sortDescFirst ?? column_getAutoSortDir(column) === "desc" ? "desc" : "asc";
  }
  function column_getNextSortingOrder(column, multi) {
    const firstSortDirection = column_getFirstSortDir(column);
    const isSorted = column_getIsSorted(column);
    if (!isSorted) return firstSortDirection;
    if (isSorted !== firstSortDirection && (column.table.options.enableSortingRemoval ?? true) && (multi ? column.table.options.enableMultiRemove ?? true : true)) return false;
    return isSorted === "desc" ? "asc" : "desc";
  }
  function column_getCanSort(column) {
    return (column.columnDef.enableSorting ?? true) && (column.table.options.enableSorting ?? true) && !!column.accessorFn;
  }
  function column_getCanMultiSort(column) {
    return column.columnDef.enableMultiSort ?? column.table.options.enableMultiSort ?? !!column.accessorFn;
  }
  function column_getIsSorted(column) {
    const columnSort = column.table.atoms.sorting?.get()?.find((d) => d.id === column.id);
    return !columnSort ? false : columnSort.desc ? "desc" : "asc";
  }
  function column_getSortIndex(column) {
    return column.table.atoms.sorting?.get()?.findIndex((d) => d.id === column.id) ?? -1;
  }
  function column_clearSorting(column) {
    table_setSorting(column.table, (old) => old.length ? old.filter((d) => d.id !== column.id) : []);
  }
  function column_getToggleSortingHandler(column) {
    const canSort = column_getCanSort(column);
    return (e) => {
      if (!canSort) return;
      column_toggleSorting(column, void 0, column_getCanMultiSort(column) ? column.table.options.isMultiSortEvent?.(e) : false);
    };
  }

  // node_modules/@tanstack/table-core/dist/core/row-models/createCoreRowModel.js
  function createCoreRowModel() {
    return (table) => {
      return tableMemo({
        feature: "coreRowModelsFeature",
        table,
        fnName: "table.getCoreRowModel",
        memoDeps: () => [table.options.data],
        fn: () => _createCoreRowModel(table, table.options.data),
        onAfterUpdate: skipFirstRun(() => {
          table_autoResetExpanded(table);
          table_autoResetPageIndex(table);
          table_autoResetSorting(table);
          table_autoResetCellSelection(table);
        })
      });
    };
  }
  function accessRows(table, rowModel, originalRows, depth = 0, parentRow) {
    const rows = [];
    for (let i = 0; i < originalRows.length; i++) {
      const originalRow = originalRows[i];
      const row = constructRow(table, table.getRowId(originalRow, i, parentRow), originalRow, i, depth, void 0, parentRow?.id);
      rowModel.flatRows.push(row);
      rowModel.rowsById[row.id] = row;
      rows.push(row);
      if (table.options.getSubRows) {
        row.originalSubRows = table.options.getSubRows(originalRow, i);
        if (row.originalSubRows?.length) row.subRows = accessRows(table, rowModel, row.originalSubRows, depth + 1, row);
      }
    }
    return rows;
  }
  function _createCoreRowModel(table, data) {
    const rowModel = {
      rows: [],
      flatRows: [],
      rowsById: makeObjectMap()
    };
    rowModel.rows = accessRows(table, rowModel, data);
    return rowModel;
  }

  // node_modules/@tanstack/table-core/dist/core/row-models/coreRowModelsFeature.utils.js
  function table_getCoreRowModel(table) {
    if (!table._rowModels.coreRowModel) table._rowModels.coreRowModel = table.options.features.coreRowModel?.(table) ?? createCoreRowModel()(table);
    return table._rowModels.coreRowModel();
  }
  function table_getPreFilteredRowModel(table) {
    return table.getCoreRowModel();
  }
  function table_getFilteredRowModel(table) {
    if (!table._rowModels.filteredRowModel) table._rowModels.filteredRowModel = table.options.features.filteredRowModel?.(table);
    if (table.options.manualFiltering || !table._rowModels.filteredRowModel) return table.getPreFilteredRowModel();
    return table._rowModels.filteredRowModel();
  }
  function table_getPreGroupedRowModel(table) {
    return table.getFilteredRowModel();
  }
  function table_getGroupedRowModel(table) {
    if (!table._rowModels.groupedRowModel) table._rowModels.groupedRowModel = table.options.features.groupedRowModel?.(table);
    if (table.options.manualGrouping || !table._rowModels.groupedRowModel) return table.getPreGroupedRowModel();
    return table._rowModels.groupedRowModel();
  }
  function table_getPreSortedRowModel(table) {
    return table.getGroupedRowModel();
  }
  function table_getSortedRowModel(table) {
    if (!table._rowModels.sortedRowModel) table._rowModels.sortedRowModel = table.options.features.sortedRowModel?.(table);
    if (table.options.manualSorting || !table._rowModels.sortedRowModel) return table.getPreSortedRowModel();
    return table._rowModels.sortedRowModel();
  }
  function table_getPreExpandedRowModel(table) {
    return table.getSortedRowModel();
  }
  function table_getExpandedRowModel(table) {
    if (!table._rowModels.expandedRowModel) table._rowModels.expandedRowModel = table.options.features.expandedRowModel?.(table);
    if (table.options.manualExpanding || !table._rowModels.expandedRowModel) return table.getPreExpandedRowModel();
    return table._rowModels.expandedRowModel();
  }
  function table_getPrePaginatedRowModel(table) {
    return table.getExpandedRowModel();
  }
  function table_getPaginatedRowModel(table) {
    if (!table._rowModels.paginatedRowModel) table._rowModels.paginatedRowModel = table.options.features.paginatedRowModel?.(table);
    if (table.options.manualPagination || !table._rowModels.paginatedRowModel) return table.getPrePaginatedRowModel();
    return table._rowModels.paginatedRowModel();
  }
  function table_getRowModel(table) {
    return table.getPaginatedRowModel();
  }

  // node_modules/@tanstack/table-core/dist/core/row-models/coreRowModelsFeature.js
  var coreRowModelsFeature = { constructTableAPIs: (table) => {
    assignTableAPIs("coreRowModelsFeature", table, {
      table_getCoreRowModel: { fn: () => table_getCoreRowModel(table) },
      table_getPreFilteredRowModel: { fn: () => table_getPreFilteredRowModel(table) },
      table_getFilteredRowModel: { fn: () => table_getFilteredRowModel(table) },
      table_getPreGroupedRowModel: { fn: () => table_getPreGroupedRowModel(table) },
      table_getGroupedRowModel: { fn: () => table_getGroupedRowModel(table) },
      table_getPreSortedRowModel: { fn: () => table_getPreSortedRowModel(table) },
      table_getSortedRowModel: { fn: () => table_getSortedRowModel(table) },
      table_getPreExpandedRowModel: { fn: () => table_getPreExpandedRowModel(table) },
      table_getExpandedRowModel: { fn: () => table_getExpandedRowModel(table) },
      table_getPrePaginatedRowModel: { fn: () => table_getPrePaginatedRowModel(table) },
      table_getPaginatedRowModel: { fn: () => table_getPaginatedRowModel(table) },
      table_getRowModel: { fn: () => table_getRowModel(table) }
    });
  } };

  // node_modules/@tanstack/table-core/dist/core/cells/constructCell.js
  function getCellPrototype(table) {
    if (!table._cellPrototype) {
      table._cellPrototype = { table };
      const features = Object.values(table._features);
      for (let i = 0; i < features.length; i++) features[i].assignCellPrototype?.(table._cellPrototype, table);
    }
    return table._cellPrototype;
  }
  function constructCell(column, row, table) {
    const cellPrototype = getCellPrototype(table);
    const cell = Object.create(cellPrototype);
    cell.column = column;
    cell.id = `${row.id}_${column.id}`;
    cell.row = row;
    const initFns = table._cellInstanceInitFns;
    for (let i = 0; i < initFns.length; i++) initFns[i](cell);
    return cell;
  }

  // node_modules/@tanstack/table-core/dist/core/rows/coreRowsFeature.utils.js
  function row_getDisplayIndex(row) {
    const rows = row.table.getRowsInDisplayOrder();
    const displayIndex = row._displayIndexCache;
    return rows[displayIndex] === row ? displayIndex : -1;
  }
  function table_getRowsInDisplayOrder(table) {
    const rows = table.getPrePaginatedRowModel().rows;
    if (table.options.paginateExpandedRows === false) {
      const displayRows = [];
      const handleRow = (row) => {
        row._displayIndexCache = displayRows.length;
        displayRows.push(row);
        if (row.subRows.length && row.getIsExpanded?.()) row.subRows.forEach(handleRow);
      };
      rows.forEach(handleRow);
      return displayRows;
    }
    for (let i = 0; i < rows.length; i++) rows[i]._displayIndexCache = i;
    return rows;
  }
  function row_getValue(row, columnId) {
    if (hasOwn(row._valuesCache, columnId)) return row._valuesCache[columnId];
    const column = row.table.getColumn(columnId);
    if (!column?.accessorFn) return;
    row._valuesCache[columnId] = column.accessorFn(row.original, row.index);
    return row._valuesCache[columnId];
  }
  function row_getUniqueValues(row, columnId) {
    if (hasOwn(row._uniqueValuesCache, columnId)) return row._uniqueValuesCache[columnId];
    const column = row.table.getColumn(columnId);
    if (!column?.accessorFn) return;
    if (!column.columnDef.getUniqueValues) {
      row._uniqueValuesCache[columnId] = [row.getValue(columnId)];
      return row._uniqueValuesCache[columnId];
    }
    row._uniqueValuesCache[columnId] = column.columnDef.getUniqueValues(row.original, row.index);
    return row._uniqueValuesCache[columnId];
  }
  function row_renderValue(row, columnId) {
    return row.getValue(columnId) ?? row.table.options.renderFallbackValue;
  }
  function row_getLeafRows(row) {
    return flattenBy(row.subRows, (d) => d.subRows);
  }
  function table_getMaxSubRowDepth(table) {
    const rows = table.getCoreRowModel().flatRows;
    let maxDepth = 0;
    for (let i = 0; i < rows.length; i++) maxDepth = Math.max(maxDepth, rows[i].depth);
    return maxDepth;
  }
  function row_getParentRow(row) {
    if (!row.parentId) return;
    return row.table.getCoreRowModel().rowsById[row.parentId] ?? row.table.getRow(row.parentId, true);
  }
  function row_getParentRows(row) {
    const parentRows = [];
    let currentRow = row;
    while (true) {
      const parentRow = currentRow.getParentRow();
      if (!parentRow) break;
      parentRows.push(parentRow);
      currentRow = parentRow;
    }
    return parentRows.reverse();
  }
  function row_getAllCells(row) {
    const columns = row.table.getAllLeafColumns();
    let cache = row._cellsCache;
    if (!cache) cache = row._cellsCache = /* @__PURE__ */ new WeakMap();
    const cells = new Array(columns.length);
    for (let i = 0; i < columns.length; i++) {
      const column = columns[i];
      let cell = cache.get(column);
      if (!cell) {
        cell = constructCell(column, row, row.table);
        cache.set(column, cell);
      }
      cells[i] = cell;
    }
    return cells;
  }
  function row_getAllCellsByColumnId(row) {
    const result = makeObjectMap();
    const cells = row.getAllCells();
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      result[cell.column.id] = cell;
    }
    return result;
  }
  function table_getRowId(originalRow, table, index, parent) {
    return table.options.getRowId?.(originalRow, index, parent) ?? (parent ? `${parent.id}.${index}` : String(index));
  }
  function table_getRow(table, rowId, searchAll) {
    let row = (searchAll ? table.getPrePaginatedRowModel() : table.getRowModel()).rowsById[rowId];
    if (!row) {
      row = table.getCoreRowModel().rowsById[rowId];
      if (!row) {
        if (true) throw new Error(`getRow could not find row with ID: ${rowId}`);
        throw new Error();
      }
    }
    return row;
  }

  // node_modules/@tanstack/table-core/dist/core/rows/coreRowsFeature.js
  var coreRowsFeature = {
    assignRowPrototype: (prototype, table) => {
      assignPrototypeAPIs("coreRowsFeature", prototype, table, {
        row_getDisplayIndex: { fn: (row) => row_getDisplayIndex(row) },
        row_getAllCellsByColumnId: {
          fn: (row) => row_getAllCellsByColumnId(row),
          memoDeps: (row) => [row.getAllCells()]
        },
        row_getAllCells: {
          fn: (row) => row_getAllCells(row),
          memoDeps: (row) => [row.table.getAllLeafColumns()]
        },
        row_getLeafRows: {
          fn: (row) => row_getLeafRows(row),
          memoDeps: (row) => [row.subRows]
        },
        row_getParentRow: { fn: (row) => row_getParentRow(row) },
        row_getParentRows: { fn: (row) => row_getParentRows(row) },
        row_getUniqueValues: { fn: (row, columnId) => row_getUniqueValues(row, columnId) },
        row_getValue: { fn: (row, columnId) => row_getValue(row, columnId) },
        row_renderValue: { fn: (row, columnId) => row_renderValue(row, columnId) }
      });
    },
    constructTableAPIs: (table) => {
      assignTableAPIs("coreRowsFeature", table, {
        table_getRowsInDisplayOrder: {
          fn: () => table_getRowsInDisplayOrder(table),
          memoDeps: () => [
            table.getPrePaginatedRowModel().rows,
            table.options.paginateExpandedRows,
            table.options.paginateExpandedRows === false ? table.atoms.expanded?.get() : void 0
          ]
        },
        table_getRowId: { fn: (originalRow, index, parent) => table_getRowId(originalRow, table, index, parent) },
        table_getRow: { fn: (id, searchAll) => table_getRow(table, id, searchAll) },
        table_getMaxSubRowDepth: {
          fn: () => table_getMaxSubRowDepth(table),
          memoDeps: () => [table.getCoreRowModel()]
        }
      });
    }
  };

  // node_modules/@tanstack/table-core/dist/core/table/coreTablesFeature.utils.js
  function table_syncExternalStateToBaseAtoms(table, capturedState, compare = (currentState, externalState) => currentState === externalState) {
    const state = capturedState === void 0 ? table.options.state : capturedState;
    table._reactivity.batch(() => {
      if (state) for (const key in state) {
        const baseAtom = table.baseAtoms[key];
        if (!baseAtom) continue;
        const rawExternalState = state[key];
        const externalState = rawExternalState === void 0 ? table.initialState[key] : rawExternalState;
        if (!compare(table._reactivity.untrack(() => baseAtom.get()), externalState)) baseAtom.set(() => externalState);
      }
    });
  }
  function table_publishExternalState(table, state, compare = (currentState, externalState) => currentState === externalState) {
    table._reactivity.batch(() => {
      table_syncExternalStateToBaseAtoms(table, state, compare);
      table._reactivity.commit?.();
    });
  }
  function table_reset(table) {
    const snap = cloneState(table.initialState);
    table._reactivity.batch(() => {
      const keys = Object.keys(snap);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        table.baseAtoms[key].set(snap[key]);
      }
    });
    const features = Object.values(table._features);
    for (let i = 0; i < features.length; i++) features[i].resetTableInstanceData?.(table);
  }
  function table_mergeOptions(table, newOptions) {
    const { features, atoms, initialState } = table.options;
    if (!table.options.mergeOptions) return {
      ...table.options,
      ...newOptions,
      features,
      atoms,
      initialState
    };
    const mergedOptions = table.options.mergeOptions(table.options, newOptions);
    const descriptors = { ...Object.getOwnPropertyDescriptors(mergedOptions) };
    return Object.defineProperties(Object.create(Object.getPrototypeOf(mergedOptions)), {
      ...descriptors,
      features: {
        value: features,
        enumerable: true,
        configurable: true,
        writable: true
      },
      atoms: {
        value: atoms,
        enumerable: true,
        configurable: true,
        writable: true
      },
      initialState: {
        value: initialState,
        enumerable: true,
        configurable: true,
        writable: true
      }
    });
  }
  function table_setOptions(table, updater, options) {
    const mergedOptions = table_mergeOptions(table, functionalUpdate(updater, table.options));
    if (table.optionsStore) table.optionsStore.set(() => mergedOptions);
    else table.options = mergedOptions;
    if (options?.syncExternalState !== false) table_publishExternalState(table, mergedOptions.state ?? null);
  }

  // node_modules/@tanstack/table-core/dist/core/table/coreTablesFeature.js
  var coreTablesFeature = { constructTableAPIs: (table) => {
    assignTableAPIs("coreTablesFeature", table, {
      table_reset: { fn: () => table_reset(table) },
      table_setOptions: { fn: (updater) => table_setOptions(table, updater) }
    });
  } };

  // node_modules/@tanstack/table-core/dist/core/coreFeatures.js
  var coreFeatures = {
    coreCellsFeature,
    coreColumnsFeature,
    coreHeadersFeature,
    coreRowModelsFeature,
    coreRowsFeature,
    coreTablesFeature
  };

  // node_modules/@tanstack/table-core/dist/helpers/columnHelper.js
  function createColumnHelper() {
    return {
      accessor: (accessor, column) => {
        return typeof accessor === "function" ? {
          ...column,
          accessorFn: accessor
        } : {
          ...column,
          accessorKey: accessor
        };
      },
      columns: (columns) => columns,
      display: (column) => column,
      group: (column) => column
    };
  }

  // node_modules/@tanstack/table-core/dist/helpers/tableFeatures.js
  function tableFeatures(features) {
    return features;
  }

  // node_modules/@tanstack/table-core/dist/core/reactivity/coreReactivityFeature.utils.js
  function atomToStore(atom) {
    const store = atom;
    Object.defineProperty(atom, "state", { get() {
      return atom.get();
    } });
    if ("set" in atom) store.setState = atom.set.bind(atom);
    return store;
  }

  // node_modules/@tanstack/store/dist/alien.js
  // @__NO_SIDE_EFFECTS__
  function createReactiveSystem({ update, notify, unwatched }) {
    return {
      link: link2,
      unlink: unlink2,
      propagate: propagate2,
      checkDirty: checkDirty2,
      shallowPropagate: shallowPropagate2
    };
    function link2(dep, sub, version) {
      const prevDep = sub.depsTail;
      if (prevDep !== void 0 && prevDep.dep === dep) return;
      const nextDep = prevDep !== void 0 ? prevDep.nextDep : sub.deps;
      if (nextDep !== void 0 && nextDep.dep === dep) {
        nextDep.version = version;
        sub.depsTail = nextDep;
        return;
      }
      const prevSub = dep.subsTail;
      if (prevSub !== void 0 && prevSub.version === version && prevSub.sub === sub) return;
      const newLink = sub.depsTail = dep.subsTail = {
        version,
        dep,
        sub,
        prevDep,
        nextDep,
        prevSub,
        nextSub: void 0
      };
      if (nextDep !== void 0) nextDep.prevDep = newLink;
      if (prevDep !== void 0) prevDep.nextDep = newLink;
      else sub.deps = newLink;
      if (prevSub !== void 0) prevSub.nextSub = newLink;
      else dep.subs = newLink;
    }
    function unlink2(link3, sub = link3.sub) {
      const dep = link3.dep;
      const prevDep = link3.prevDep;
      const nextDep = link3.nextDep;
      const nextSub = link3.nextSub;
      const prevSub = link3.prevSub;
      if (nextDep !== void 0) nextDep.prevDep = prevDep;
      else sub.depsTail = prevDep;
      if (prevDep !== void 0) prevDep.nextDep = nextDep;
      else sub.deps = nextDep;
      if (nextSub !== void 0) nextSub.prevSub = prevSub;
      else dep.subsTail = prevSub;
      if (prevSub !== void 0) prevSub.nextSub = nextSub;
      else if ((dep.subs = nextSub) === void 0) unwatched(dep);
      return nextDep;
    }
    function propagate2(link3) {
      let next = link3.nextSub;
      let stack;
      top: do {
        const sub = link3.sub;
        let flags = sub.flags;
        if (!(flags & 60)) sub.flags = flags | 32;
        else if (!(flags & (4 | 8))) flags = 0;
        else if (!(flags & 4)) sub.flags = flags & ~8 | 32;
        else if (!(flags & (16 | 32)) && isValidLink(link3, sub)) {
          sub.flags = flags | (8 | 32);
          flags &= 1;
        } else flags = 0;
        if (flags & 2) notify(sub);
        if (flags & 1) {
          const subSubs = sub.subs;
          if (subSubs !== void 0) {
            const nextSub = (link3 = subSubs).nextSub;
            if (nextSub !== void 0) {
              stack = {
                value: next,
                prev: stack
              };
              next = nextSub;
            }
            continue;
          }
        }
        if ((link3 = next) !== void 0) {
          next = link3.nextSub;
          continue;
        }
        while (stack !== void 0) {
          link3 = stack.value;
          stack = stack.prev;
          if (link3 !== void 0) {
            next = link3.nextSub;
            continue top;
          }
        }
        break;
      } while (true);
    }
    function checkDirty2(link3, sub) {
      let stack;
      let checkDepth = 0;
      let dirty = false;
      top: do {
        const dep = link3.dep;
        const flags = dep.flags;
        if (sub.flags & 16) dirty = true;
        else if ((flags & (1 | 16)) === (1 | 16)) {
          if (update(dep)) {
            const subs = dep.subs;
            if (subs.nextSub !== void 0) shallowPropagate2(subs);
            dirty = true;
          }
        } else if ((flags & (1 | 32)) === (1 | 32)) {
          if (link3.nextSub !== void 0 || link3.prevSub !== void 0) stack = {
            value: link3,
            prev: stack
          };
          link3 = dep.deps;
          sub = dep;
          ++checkDepth;
          continue;
        }
        if (!dirty) {
          const nextDep = link3.nextDep;
          if (nextDep !== void 0) {
            link3 = nextDep;
            continue;
          }
        }
        while (checkDepth--) {
          const firstSub = sub.subs;
          const hasMultipleSubs = firstSub.nextSub !== void 0;
          if (hasMultipleSubs) {
            link3 = stack.value;
            stack = stack.prev;
          } else link3 = firstSub;
          if (dirty) {
            if (update(sub)) {
              if (hasMultipleSubs) shallowPropagate2(firstSub);
              sub = link3.sub;
              continue;
            }
            dirty = false;
          } else sub.flags &= ~32;
          sub = link3.sub;
          const nextDep = link3.nextDep;
          if (nextDep !== void 0) {
            link3 = nextDep;
            continue top;
          }
        }
        return dirty;
      } while (true);
    }
    function shallowPropagate2(link3) {
      do {
        const sub = link3.sub;
        const flags = sub.flags;
        if ((flags & (32 | 16)) === 32) {
          sub.flags = flags | 16;
          if ((flags & (2 | 4)) === 2) notify(sub);
        }
      } while ((link3 = link3.nextSub) !== void 0);
    }
    function isValidLink(checkLink, sub) {
      let link3 = sub.depsTail;
      while (link3 !== void 0) {
        if (link3 === checkLink) return true;
        link3 = link3.prevDep;
      }
      return false;
    }
  }

  // node_modules/@tanstack/store/dist/atom.js
  function toObserver(nextHandler, errorHandler, completionHandler) {
    const isObserver = typeof nextHandler === "object";
    const self = isObserver ? nextHandler : void 0;
    return {
      next: (isObserver ? nextHandler.next : nextHandler)?.bind(self),
      error: (isObserver ? nextHandler.error : errorHandler)?.bind(self),
      complete: (isObserver ? nextHandler.complete : completionHandler)?.bind(self)
    };
  }
  var queuedEffects = [];
  var cycle = 0;
  var { link, unlink, propagate, checkDirty, shallowPropagate } = /* @__PURE__ */ createReactiveSystem({
    update(atom) {
      return atom._update();
    },
    notify(effect2) {
      queuedEffects[queuedEffectsLength++] = effect2;
      effect2.flags &= ~2;
    },
    unwatched(atom) {
      if (atom.depsTail !== void 0) {
        atom.depsTail = void 0;
        atom.flags = 1 | 16;
        purgeDeps(atom);
      }
    }
  });
  var notifyIndex = 0;
  var queuedEffectsLength = 0;
  var activeSub;
  var batchDepth = 0;
  function batch(fn) {
    try {
      ++batchDepth;
      fn();
    } finally {
      if (!--batchDepth) flush();
    }
  }
  function purgeDeps(sub) {
    const depsTail = sub.depsTail;
    let dep = depsTail !== void 0 ? depsTail.nextDep : sub.deps;
    while (dep !== void 0) dep = unlink(dep, sub);
  }
  function flush() {
    if (batchDepth > 0) return;
    while (notifyIndex < queuedEffectsLength) {
      const effect2 = queuedEffects[notifyIndex];
      queuedEffects[notifyIndex++] = void 0;
      effect2.notify();
    }
    notifyIndex = 0;
    queuedEffectsLength = 0;
  }
  function createAtom(valueOrFn, options) {
    const isComputed = typeof valueOrFn === "function";
    const getter = valueOrFn;
    const atom = {
      _snapshot: isComputed ? void 0 : valueOrFn,
      subs: void 0,
      subsTail: void 0,
      deps: void 0,
      depsTail: void 0,
      flags: isComputed ? 0 : 1,
      get() {
        if (activeSub !== void 0) link(atom, activeSub, cycle);
        return atom._snapshot;
      },
      subscribe(observerOrFn) {
        const obs = toObserver(observerOrFn);
        const observed = { current: false };
        const e = effect(() => {
          atom.get();
          if (!observed.current) observed.current = true;
          else obs.next?.(atom._snapshot);
        });
        return { unsubscribe: () => {
          e.stop();
        } };
      },
      _update(getValue) {
        const prevSub = activeSub;
        const compare = options?.compare ?? Object.is;
        if (isComputed) {
          activeSub = atom;
          ++cycle;
          atom.depsTail = void 0;
        } else if (getValue === void 0) return false;
        if (isComputed) atom.flags = 1 | 4;
        try {
          const oldValue = atom._snapshot;
          const newValue = typeof getValue === "function" ? getValue(oldValue) : getValue === void 0 && isComputed ? getter(oldValue) : getValue;
          if (oldValue === void 0 || !compare(oldValue, newValue)) {
            atom._snapshot = newValue;
            return true;
          }
          return false;
        } finally {
          activeSub = prevSub;
          if (isComputed) atom.flags &= ~4;
          purgeDeps(atom);
        }
      }
    };
    if (isComputed) {
      atom.flags = 1 | 16;
      atom.get = function() {
        const flags = atom.flags;
        if (flags & 16 || flags & 32 && checkDirty(atom.deps, atom)) {
          if (atom._update()) {
            const subs = atom.subs;
            if (subs !== void 0) shallowPropagate(subs);
          }
        } else if (flags & 32) atom.flags = flags & ~32;
        if (activeSub !== void 0) link(atom, activeSub, cycle);
        return atom._snapshot;
      };
    } else atom.set = function(valueOrFn2) {
      if (atom._update(valueOrFn2)) {
        const subs = atom.subs;
        if (subs !== void 0) {
          propagate(subs);
          shallowPropagate(subs);
          flush();
        }
      }
    };
    return atom;
  }
  function effect(fn) {
    const run = () => {
      const prevSub = activeSub;
      activeSub = effectObj;
      ++cycle;
      effectObj.depsTail = void 0;
      effectObj.flags = 2 | 4;
      try {
        return fn();
      } finally {
        activeSub = prevSub;
        effectObj.flags &= ~4;
        purgeDeps(effectObj);
      }
    };
    const effectObj = {
      deps: void 0,
      depsTail: void 0,
      subs: void 0,
      subsTail: void 0,
      flags: 2 | 4,
      notify() {
        const flags = this.flags;
        if (flags & 16 || flags & 32 && checkDirty(this.deps, this)) run();
        else this.flags = 2;
      },
      stop() {
        this.flags = 0;
        this.depsTail = void 0;
        purgeDeps(this);
      }
    };
    run();
    return effectObj;
  }

  // node_modules/@tanstack/store/dist/shallow.js
  function shallow(objA, objB) {
    if (Object.is(objA, objB)) return true;
    if (typeof objA !== "object" || objA === null || typeof objB !== "object" || objB === null) return false;
    if (objA instanceof Map && objB instanceof Map) {
      if (objA.size !== objB.size) return false;
      for (const [k, v] of objA) if (!objB.has(k) || !Object.is(v, objB.get(k))) return false;
      return true;
    }
    if (objA instanceof Set && objB instanceof Set) {
      if (objA.size !== objB.size) return false;
      for (const v of objA) if (!objB.has(v)) return false;
      return true;
    }
    if (objA instanceof Date && objB instanceof Date) {
      if (objA.getTime() !== objB.getTime()) return false;
      return true;
    }
    const keysA = getOwnKeys(objA);
    if (keysA.length !== getOwnKeys(objB).length) return false;
    for (let i = 0; i < keysA.length; i++) if (!Object.prototype.hasOwnProperty.call(objB, keysA[i]) || !Object.is(objA[keysA[i]], objB[keysA[i]])) return false;
    return true;
  }
  function getOwnKeys(obj) {
    return Object.keys(obj).concat(Object.getOwnPropertySymbols(obj));
  }

  // node_modules/@tanstack/table-core/dist/core/table/constructTable.js
  function getInitialTableState(features, initialState = {}) {
    Object.values(features).forEach((feature) => {
      initialState = feature.getInitialState?.(initialState) ?? initialState;
    });
    return cloneState(initialState);
  }
  function constructTable(tableOptions) {
    const _reactivity = tableOptions.features.coreReactivityFeature;
    const { aggregationFns, columnMeta: _columnMeta, coreRowModel, expandedRowModel, facetedMinMaxValues, facetedRowModel, facetedUniqueValues, filterFns, filterMeta: _filterMeta, filteredRowModel, groupedRowModel, paginatedRowModel, sortFns: sortFns2, sortedRowModel, tableMeta: _tableMeta, ...features } = tableOptions.features;
    const table = {
      _cellInstanceInitFns: [],
      _columnInstanceInitFns: [],
      _features: {
        ...coreFeatures,
        ...features
      },
      _headerGroupInstanceInitFns: [],
      _headerInstanceInitFns: [],
      _reactivity,
      _rowInstanceInitFns: [],
      _rowModelFns: {
        aggregationFns,
        filterFns,
        sortFns: sortFns2
      },
      _rowModels: {},
      atoms: {},
      baseAtoms: {}
    };
    const featuresList = Object.values(table._features);
    const mergedOptions = {
      ...featuresList.reduce((obj, feature) => {
        return Object.assign(obj, feature.getDefaultTableOptions?.(table));
      }, {}),
      ...tableOptions
    };
    if (_reactivity.wrapExternalAtoms && mergedOptions.atoms) for (const [atomKey, _atom] of Object.entries(mergedOptions.atoms)) {
      const atom = _atom;
      const wrappedAtom = _reactivity.createWritableAtom(atom.get(), { debugName: `externalAtom/${atomKey}` });
      mergedOptions.atoms[atomKey] = wrappedAtom;
      let syncExternal = false;
      const syncAtomToWrappedSub = atom.subscribe((value) => {
        if (syncExternal) return;
        wrappedAtom.set(value);
      });
      const syncWrappedToAtomSub = wrappedAtom.subscribe((value) => {
        syncExternal = true;
        atom.set(value);
        syncExternal = false;
      });
      _reactivity.addSubscription(syncAtomToWrappedSub);
      _reactivity.addSubscription(syncWrappedToAtomSub);
    }
    if (_reactivity.createOptionsStore) {
      table.optionsStore = _reactivity.createWritableAtom(mergedOptions, { debugName: "table/optionsStore" });
      Object.defineProperty(table, "options", {
        configurable: true,
        enumerable: true,
        get() {
          return table.optionsStore.get();
        },
        set(value) {
          table.optionsStore.set(() => value);
        }
      });
    } else table.options = mergedOptions;
    table.initialState = getInitialTableState(table._features, table.options.initialState);
    const stateKeys = Object.keys(table.initialState);
    for (let i = 0; i < stateKeys.length; i++) {
      const key = stateKeys[i];
      table.baseAtoms[key] = _reactivity.createWritableAtom(table.initialState[key], { debugName: `table/baseAtoms/${key}` });
      table.atoms[key] = _reactivity.createReadonlyAtom(() => {
        const options = table.options;
        const externalAtom = options.atoms?.[key];
        const reactiveState = externalAtom ? externalAtom.get() : table.baseAtoms[key].get();
        if (externalAtom) return reactiveState;
        const controlledState = options.state;
        if (controlledState && hasOwn(controlledState, key)) {
          const controlledValue = controlledState[key];
          return controlledValue === void 0 ? table.initialState[key] : controlledValue;
        }
        return reactiveState;
      }, { debugName: `table/atoms/${key}` });
    }
    table_syncExternalStateToBaseAtoms(table);
    table.store = atomToStore(_reactivity.createReadonlyAtom(() => {
      const snapshot = {};
      for (let i = 0; i < stateKeys.length; i++) {
        const key = stateKeys[i];
        snapshot[key] = table.atoms[key].get();
      }
      return snapshot;
    }, {
      compare: shallow,
      debugName: "table/store"
    }));
    for (let i = 0; i < featuresList.length; i++) {
      const feature = featuresList[i];
      feature.initTableInstanceData?.(table);
      if (feature.initCellInstanceData) table._cellInstanceInitFns.push(feature.initCellInstanceData.bind(feature));
      if (feature.initColumnInstanceData) table._columnInstanceInitFns.push(feature.initColumnInstanceData.bind(feature));
      if (feature.initHeaderGroupInstanceData) table._headerGroupInstanceInitFns.push(feature.initHeaderGroupInstanceData.bind(feature));
      if (feature.initHeaderInstanceData) table._headerInstanceInitFns.push(feature.initHeaderInstanceData.bind(feature));
      if (feature.initRowInstanceData) table._rowInstanceInitFns.push(feature.initRowInstanceData.bind(feature));
      feature.constructTableAPIs?.(table);
    }
    if (tableOptions.debugAll || tableOptions.debugTable) {
      const features2 = Object.keys(table._features);
      const rowModels = Object.entries({
        coreRowModel,
        filteredRowModel,
        groupedRowModel,
        sortedRowModel,
        expandedRowModel,
        paginatedRowModel,
        facetedRowModel,
        facetedMinMaxValues,
        facetedUniqueValues
      }).filter(([, factory]) => factory).map(([key]) => key);
      const states = Object.keys(table.initialState);
      console.log(`Constructing Table Instance

  Features:   ${features2.join("\n              ")}

  Row Models: ${rowModels.length ? rowModels.join("\n              ") : "(none)"}

  States:     ${states.join("\n              ")}
`, { table });
    }
    return table;
  }

  // node_modules/@tanstack/table-core/dist/features/row-aggregation/rowAggregationFeature.utils.js
  function isAggregationFnDef(value) {
    return !!value && typeof value === "object" && "aggregate" in value;
  }
  function isAggregationFnDescriptor(value) {
    return !!value && typeof value === "object" && "id" in value && "aggregationFn" in value;
  }
  function warn(message) {
    if (true) console.warn(message);
  }
  function resolveMaxAggregationDepth(maxDepth) {
    return maxDepth === void 0 || Number.isNaN(maxDepth) ? 0 : Math.max(0, Math.floor(maxDepth));
  }
  function collectNormalizedAggregationRow(row, depth, maxDepth, seen, result) {
    if (row.subRows.length && depth < maxDepth) {
      for (let i = 0; i < row.subRows.length; i++) collectNormalizedAggregationRow(row.subRows[i], depth + 1, maxDepth, seen, result);
      return;
    }
    if (!seen.has(row.id)) {
      seen.add(row.id);
      result.push(row);
    }
  }
  function collectUniqueAggregationRow(row, depth, maxDepth, result) {
    if (row.subRows.length && depth < maxDepth) {
      for (let i = 0; i < row.subRows.length; i++) collectUniqueAggregationRow(row.subRows[i], depth + 1, maxDepth, result);
      return;
    }
    result.push(row);
  }
  function normalizeAggregationRows(rows, maxDepth = 0) {
    const result = [];
    const seen = /* @__PURE__ */ new Set();
    const normalizedMaxDepth = resolveMaxAggregationDepth(maxDepth);
    for (let i = 0; i < rows.length; i++) collectNormalizedAggregationRow(rows[i], 0, normalizedMaxDepth, seen, result);
    return result;
  }
  function normalizeUniqueAggregationRows(rows, maxDepth = 0) {
    const normalizedMaxDepth = resolveMaxAggregationDepth(maxDepth);
    let needsDescent = false;
    if (normalizedMaxDepth > 0) {
      for (let i = 0; i < rows.length; i++) if (rows[i].subRows.length) {
        needsDescent = true;
        break;
      }
    }
    if (!needsDescent) return rows;
    const result = [];
    for (let i = 0; i < rows.length; i++) collectUniqueAggregationRow(rows[i], 0, normalizedMaxDepth, result);
    return result;
  }
  function getAutoAggregationFnName(value) {
    if (typeof value === "number") return "sum";
    if (value instanceof Date && !Number.isNaN(value.getTime())) return "extent";
  }
  function column_getAutoAggregationFn(column) {
    const value = column.table.getCoreRowModel().flatRows[0]?.getValue(column.id);
    const name = getAutoAggregationFnName(value);
    if (!name) return void 0;
    const aggregationFn = column.table._rowModelFns.aggregationFns?.[name];
    if (!aggregationFn) warn(`aggregationFn '${name}' (auto) for column '${column.id}' is not registered`);
    return aggregationFn;
  }
  function resolveAggregationFn(column, ref) {
    if (isAggregationFnDef(ref)) return ref;
    if (ref === "auto") return column_getAutoAggregationFn(column);
    const aggregationFn = column.table._rowModelFns.aggregationFns?.[ref];
    if (!aggregationFn) warn(`aggregationFn '${String(ref)}' for column '${column.id}' is not registered`);
    return aggregationFn;
  }
  function column_getAggregationFns(column) {
    const option = column.columnDef.aggregationFn;
    const registry = column.table._rowModelFns.aggregationFns;
    const coreRowModel = column.table.getCoreRowModel();
    const previous = column._resolvedAggregationFnsCache;
    if (previous && previous.option === option && previous.registry === registry && previous.coreRowModel === coreRowModel) return previous.value;
    const finish = (value) => {
      column._resolvedAggregationFnsCache = {
        coreRowModel,
        option,
        registry,
        value
      };
      return value;
    };
    if (option == null) return finish([]);
    if (!Array.isArray(option)) return finish([{
      aggregationFn: resolveAggregationFn(column, option),
      id: typeof option === "string" ? option : void 0
    }]);
    const ids = makeObjectMap();
    for (let i = 0; i < option.length; i++) {
      const item = option[i];
      const id = typeof item === "string" ? item : isAggregationFnDescriptor(item) ? item.id : void 0;
      if (id !== void 0) ids[id] = (ids[id] ?? 0) + 1;
    }
    const resolved = [];
    for (let i = 0; i < option.length; i++) {
      const item = option[i];
      const id = typeof item === "string" ? item : isAggregationFnDescriptor(item) ? item.id : void 0;
      if (id === void 0) {
        warn(`aggregationFn at index ${i} for column '${column.id}' needs a stable id`);
        resolved.push({
          aggregationFn: void 0,
          id: void 0
        });
        continue;
      }
      if (ids[id] > 1) {
        warn(`aggregationFn id '${id}' for column '${column.id}' is duplicated`);
        resolved.push({
          aggregationFn: void 0,
          id
        });
        continue;
      }
      const ref = isAggregationFnDescriptor(item) ? item.aggregationFn : item;
      resolved.push({
        aggregationFn: resolveAggregationFn(column, ref),
        id
      });
    }
    return finish(resolved);
  }
  function getSubRowResult(subRowValue, isMultiple, id) {
    if (!isMultiple) return subRowValue;
    if (!id || !subRowValue || typeof subRowValue !== "object") return void 0;
    return hasOwn(subRowValue, id) ? subRowValue[id] : void 0;
  }
  function aggregateColumnValue(args) {
    const { subRows, column, groupingRow, rows, uniqueRows } = args;
    const internalColumn = column;
    const maxDepth = resolveMaxAggregationDepth(args.maxDepth ?? internalColumn.columnDef.maxAggregationDepth);
    const aggregationRows = uniqueRows ? normalizeUniqueAggregationRows(rows, maxDepth) : normalizeAggregationRows(rows, maxDepth);
    const entries = column_getAggregationFns(internalColumn);
    const isMultiple = Array.isArray(internalColumn.columnDef.aggregationFn);
    const canMerge = !!subRows?.length && subRows.every((row) => !!row.groupingColumnId && row.groupingColumnId !== column.id);
    const getValue = (row) => row.getValue(column.id);
    const execute = (entry) => {
      const definition = entry.aggregationFn;
      if (!definition) return void 0;
      const context = {
        ...subRows ? { subRows } : {},
        column,
        columnId: column.id,
        getValue,
        ...groupingRow ? { groupingRow } : {},
        maxDepth,
        rows: aggregationRows,
        table: column.table
      };
      if (canMerge && definition.merge) return definition.merge({
        ...context,
        subRowResults: subRows.map((row) => getSubRowResult(row.getValue(column.id), isMultiple, entry.id)),
        subRows
      });
      return definition.aggregate(context);
    };
    if (!isMultiple) return entries[0] ? execute(entries[0]) : void 0;
    const result = makeObjectMap();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.id !== void 0) result[entry.id] = execute(entry);
    }
    return result;
  }

  // node_modules/@tanstack/table-core/dist/features/column-filtering/columnFilteringFeature.utils.js
  function getDefaultColumnFiltersState() {
    return [];
  }
  function column_getAutoFilterFn(column) {
    const filterFns = column.table._rowModelFns.filterFns;
    const rows = column.table.getCoreRowModel().flatRows;
    let value;
    for (let i = 0; i < rows.length; i++) {
      const rowValue = rows[i].getValue(column.id);
      if (rowValue !== null && rowValue !== void 0) {
        value = rowValue;
        break;
      }
    }
    let filterFnName;
    if (typeof value === "string") filterFnName = "includesString";
    else if (typeof value === "number") filterFnName = "inNumberRange";
    else if (typeof value === "boolean") filterFnName = "equals";
    else if (Array.isArray(value)) filterFnName = "arrIncludes";
    else if (Object.prototype.toString.call(value) === "[object Date]") filterFnName = "inDateRange";
    else if (value !== null && typeof value === "object") filterFnName = "equals";
    else filterFnName = "weakEquals";
    const filterFn = filterFns?.[filterFnName];
    if (!filterFn) console.warn(`filterFn '${filterFnName}' (auto) for column '${column.id}' is not registered`);
    return filterFn;
  }
  function column_getFilterFn(column) {
    let filterFn = null;
    const filterFns = column.table._rowModelFns.filterFns;
    filterFn = isFunction(column.columnDef.filterFn) ? column.columnDef.filterFn : column.columnDef.filterFn === "auto" ? column_getAutoFilterFn(column) : filterFns?.[column.columnDef.filterFn];
    if (!filterFn && column.columnDef.filterFn !== "auto") console.warn(`filterFn '${String(column.columnDef.filterFn)}' for column '${column.id}' is not registered`);
    return filterFn ?? void 0;
  }
  function column_getCanFilter(column) {
    return (column.columnDef.enableColumnFilter ?? true) && (column.table.options.enableColumnFilters ?? true) && (column.table.options.enableFilters ?? true) && !!column.accessorFn;
  }
  function column_getIsFiltered(column) {
    return column_getFilterIndex(column) > -1;
  }
  function column_getFilterValue(column) {
    return column.table.atoms.columnFilters?.get()?.find((d) => d.id === column.id)?.value;
  }
  function column_getFilterIndex(column) {
    return column.table.atoms.columnFilters?.get()?.findIndex((d) => d.id === column.id) ?? -1;
  }
  function column_setFilterValue(column, value) {
    table_setColumnFilters(column.table, (old) => {
      const filterFn = column_getFilterFn(column);
      const previousFilter = old.find((d) => d.id === column.id);
      const newFilter = functionalUpdate(value, previousFilter ? previousFilter.value : void 0);
      if (shouldAutoRemoveFilter(filterFn, newFilter, column)) return old.filter((d) => d.id !== column.id);
      const newFilterObj = {
        id: column.id,
        value: newFilter
      };
      if (previousFilter) return old.map((d) => {
        if (d.id === column.id) return newFilterObj;
        return d;
      });
      if (old.length) return [...old, newFilterObj];
      return [newFilterObj];
    });
  }
  function table_setColumnFilters(table, updater) {
    const leafColumnsById = table.getAllLeafColumnsById();
    const updateFn = (old) => {
      return functionalUpdate(updater, old).filter((filter) => {
        const column = leafColumnsById[filter.id];
        if (column) {
          if (shouldAutoRemoveFilter(column_getFilterFn(column), filter.value, column)) return false;
        }
        return true;
      });
    };
    setStateSlice(table, "columnFilters", updateFn);
  }
  function table_resetColumnFilters(table, defaultState) {
    table_setColumnFilters(table, defaultState ? [] : cloneState(table.initialState.columnFilters ?? []));
  }
  function shouldAutoRemoveFilter(filterFn, value, column) {
    if (typeof value === "undefined") return true;
    if (filterFn?.autoRemove) return !!filterFn.autoRemove(value, column);
    return typeof value === "string" && !value;
  }

  // node_modules/@tanstack/table-core/dist/features/column-filtering/columnFilteringFeature.js
  var columnFilteringFeature = {
    getInitialState: (initialState) => {
      return {
        columnFilters: getDefaultColumnFiltersState(),
        ...initialState
      };
    },
    getDefaultColumnDef: () => {
      return { filterFn: "auto" };
    },
    getDefaultTableOptions: (table) => {
      return {
        onColumnFiltersChange: makeStateUpdater("columnFilters", table),
        filterFromLeafRows: false,
        maxLeafRowFilterDepth: 100
      };
    },
    assignColumnPrototype: (prototype, table) => {
      assignPrototypeAPIs("columnFilteringFeature", prototype, table, {
        column_getAutoFilterFn: { fn: (column) => column_getAutoFilterFn(column) },
        column_getFilterFn: { fn: (column) => column_getFilterFn(column) },
        column_getCanFilter: { fn: (column) => column_getCanFilter(column) },
        column_getIsFiltered: { fn: (column) => column_getIsFiltered(column) },
        column_getFilterValue: { fn: (column) => column_getFilterValue(column) },
        column_getFilterIndex: { fn: (column) => column_getFilterIndex(column) },
        column_setFilterValue: { fn: (column, value) => column_setFilterValue(column, value) }
      });
    },
    initRowInstanceData: (row) => {
      row.columnFilters = makeObjectMap();
      row.columnFiltersMeta = makeObjectMap();
    },
    constructTableAPIs: (table) => {
      assignTableAPIs("columnFilteringFeature", table, {
        table_setColumnFilters: { fn: (updater) => table_setColumnFilters(table, updater) },
        table_resetColumnFilters: { fn: (defaultState) => table_resetColumnFilters(table, defaultState) }
      });
    }
  };

  // node_modules/@tanstack/table-core/dist/features/column-grouping/columnGroupingFeature.utils.js
  function getDefaultGroupingState() {
    return [];
  }
  function column_toggleGrouping(column) {
    table_setGrouping(column.table, (old) => {
      if (old.includes(column.id)) return old.filter((d) => d !== column.id);
      return [...old, column.id];
    });
  }
  function column_getCanGroup(column) {
    return (column.columnDef.enableGrouping ?? true) && (column.table.options.enableGrouping ?? true) && (!!column.accessorFn || !!column.columnDef.getGroupingValue);
  }
  function column_getIsGrouped(column) {
    return !!column.table.atoms.grouping?.get()?.includes(column.id);
  }
  function column_getGroupedIndex(column) {
    return column.table.atoms.grouping?.get()?.indexOf(column.id) ?? -1;
  }
  function column_getToggleGroupingHandler(column) {
    const canGroup = column_getCanGroup(column);
    return () => {
      if (!canGroup) return;
      column_toggleGrouping(column);
    };
  }
  function table_setGrouping(table, updater) {
    setStateSlice(table, "grouping", updater);
  }
  function table_resetGrouping(table, defaultState) {
    table_setGrouping(table, defaultState ? [] : cloneState(table.initialState.grouping ?? []));
  }
  function row_getIsGrouped(row) {
    return !!row.groupingColumnId;
  }
  function row_getGroupingValue(row, columnId) {
    if (row._groupingValuesCache && hasOwn(row._groupingValuesCache, columnId)) return row._groupingValuesCache[columnId];
    const column = row.table.getColumn(columnId);
    if (!column.columnDef.getGroupingValue) return row.getValue(columnId);
    if (row._groupingValuesCache) row._groupingValuesCache[columnId] = column.columnDef.getGroupingValue(row.original, row.index, row);
    return row._groupingValuesCache?.[columnId];
  }
  function cell_getIsGrouped(cell) {
    const row = cell.row;
    return column_getIsGrouped(cell.column) && cell.column.id === row.groupingColumnId;
  }
  function cell_getIsPlaceholder(cell) {
    return !cell_getIsGrouped(cell) && column_getIsGrouped(cell.column);
  }

  // node_modules/@tanstack/table-core/dist/features/column-grouping/columnGroupingFeature.js
  var columnGroupingFeature = {
    getInitialState: (initialState) => {
      return {
        grouping: getDefaultGroupingState(),
        ...initialState
      };
    },
    getDefaultTableOptions: (table) => {
      return {
        onGroupingChange: makeStateUpdater("grouping", table),
        groupedColumnMode: "reorder"
      };
    },
    assignCellPrototype: (prototype, table) => {
      assignPrototypeAPIs("columnGroupingFeature", prototype, table, {
        cell_getIsGrouped: { fn: (cell) => cell_getIsGrouped(cell) },
        cell_getIsPlaceholder: { fn: (cell) => cell_getIsPlaceholder(cell) }
      });
    },
    assignColumnPrototype: (prototype, table) => {
      assignPrototypeAPIs("columnGroupingFeature", prototype, table, {
        column_toggleGrouping: { fn: (column) => column_toggleGrouping(column) },
        column_getCanGroup: { fn: (column) => column_getCanGroup(column) },
        column_getIsGrouped: { fn: (column) => column_getIsGrouped(column) },
        column_getGroupedIndex: { fn: (column) => column_getGroupedIndex(column) },
        column_getToggleGroupingHandler: { fn: (column) => column_getToggleGroupingHandler(column) }
      });
    },
    assignRowPrototype: (prototype, table) => {
      assignPrototypeAPIs("columnGroupingFeature", prototype, table, {
        row_getIsGrouped: { fn: (row) => row_getIsGrouped(row) },
        row_getGroupingValue: { fn: (row, columnId) => row_getGroupingValue(row, columnId) }
      });
    },
    initRowInstanceData: (row) => {
      row._groupingValuesCache = makeObjectMap();
    },
    constructTableAPIs: (table) => {
      assignTableAPIs("columnGroupingFeature", table, {
        table_setGrouping: { fn: (updater) => table_setGrouping(table, updater) },
        table_resetGrouping: { fn: (defaultState) => table_resetGrouping(table, defaultState) }
      });
    }
  };

  // node_modules/@tanstack/table-core/dist/features/column-ordering/columnOrderingFeature.js
  var columnOrderingFeature = {
    getInitialState: (initialState) => {
      return {
        columnOrder: getDefaultColumnOrderState(),
        ...initialState
      };
    },
    getDefaultTableOptions: (table) => {
      return { onColumnOrderChange: makeStateUpdater("columnOrder", table) };
    },
    assignColumnPrototype: (prototype, table) => {
      assignPrototypeAPIs("columnOrderingFeature", prototype, table, {
        column_getIndex: { fn: (column, position) => column_getIndex(column, position) },
        column_getIsFirstColumn: { fn: (column, position) => column_getIsFirstColumn(column, position) },
        column_getIsLastColumn: { fn: (column, position) => column_getIsLastColumn(column, position) }
      });
    },
    constructTableAPIs: (table) => {
      assignTableAPIs("columnOrderingFeature", table, {
        table_getColumnIndexes: {
          fn: () => table_getColumnIndexes(table),
          memoDeps: () => [
            table.options.columns,
            table.atoms.columnOrder?.get(),
            table.atoms.columnPinning?.get(),
            table.atoms.columnVisibility?.get(),
            table.atoms.grouping?.get(),
            table.options.groupedColumnMode
          ]
        },
        table_setColumnOrder: { fn: (updater) => table_setColumnOrder(table, updater) },
        table_resetColumnOrder: { fn: (defaultState) => table_resetColumnOrder(table, defaultState) },
        table_getOrderColumnsFn: {
          fn: () => table_getOrderColumnsFn(table),
          memoDeps: () => [
            table.atoms.columnOrder?.get(),
            table.atoms.grouping?.get(),
            table.options.groupedColumnMode
          ]
        }
      });
    }
  };

  // node_modules/@tanstack/table-core/dist/features/column-pinning/columnPinningFeature.js
  var columnPinningFeature = {
    getInitialState: (initialState) => {
      return {
        columnPinning: {
          ...getDefaultColumnPinningState(),
          ...initialState.columnPinning
        },
        ...initialState
      };
    },
    getDefaultTableOptions: (table) => {
      return { onColumnPinningChange: makeStateUpdater("columnPinning", table) };
    },
    assignColumnPrototype: (prototype, table) => {
      assignPrototypeAPIs("columnPinningFeature", prototype, table, {
        column_pin: { fn: (column, position) => column_pin(column, position) },
        column_getCanPin: { fn: (column) => column_getCanPin(column) },
        column_getPinnedIndex: { fn: (column) => column_getPinnedIndex(column) },
        column_getIsPinned: { fn: (column) => column_getIsPinned(column) }
      });
    },
    assignRowPrototype: (prototype, table) => {
      assignPrototypeAPIs("columnPinningFeature", prototype, table, {
        row_getCenterVisibleCells: {
          fn: (row) => row_getCenterVisibleCells(row),
          memoDeps: (row) => [
            row.getAllCells(),
            row.table.atoms.columnPinning?.get(),
            row.table.atoms.columnVisibility?.get()
          ]
        },
        row_getStartVisibleCells: {
          fn: (row) => row_getStartVisibleCells(row),
          memoDeps: (row) => [
            row.getAllCells(),
            row.table.atoms.columnPinning?.get()?.start,
            row.table.atoms.columnVisibility?.get()
          ]
        },
        row_getEndVisibleCells: {
          fn: (row) => row_getEndVisibleCells(row),
          memoDeps: (row) => [
            row.getAllCells(),
            row.table.atoms.columnPinning?.get()?.end,
            row.table.atoms.columnVisibility?.get()
          ]
        }
      });
    },
    constructTableAPIs: (table) => {
      assignTableAPIs("columnPinningFeature", table, {
        table_setColumnPinning: { fn: (updater) => table_setColumnPinning(table, updater) },
        table_resetColumnPinning: { fn: (defaultState) => table_resetColumnPinning(table, defaultState) },
        table_getIsSomeColumnsPinned: { fn: (position) => table_getIsSomeColumnsPinned(table, position) },
        table_getStartHeaderGroups: {
          fn: () => table_getStartHeaderGroups(table),
          memoDeps: () => [
            table.getAllColumns(),
            callMemoOrStaticFn(table, "getVisibleLeafColumns", table_getVisibleLeafColumns),
            table.atoms.columnPinning?.get()?.start,
            table.atoms.columnOrder?.get()
          ]
        },
        table_getCenterHeaderGroups: {
          fn: () => table_getCenterHeaderGroups(table),
          memoDeps: () => [
            table.getAllColumns(),
            callMemoOrStaticFn(table, "getVisibleLeafColumns", table_getVisibleLeafColumns),
            table.atoms.columnPinning?.get(),
            table.atoms.columnOrder?.get()
          ]
        },
        table_getEndHeaderGroups: {
          fn: () => table_getEndHeaderGroups(table),
          memoDeps: () => [
            table.getAllColumns(),
            callMemoOrStaticFn(table, "getVisibleLeafColumns", table_getVisibleLeafColumns),
            table.atoms.columnPinning?.get()?.end,
            table.atoms.columnOrder?.get()
          ]
        },
        table_getStartFooterGroups: {
          fn: () => table_getStartFooterGroups(table),
          memoDeps: () => [callMemoOrStaticFn(table, "getStartHeaderGroups", table_getStartHeaderGroups)]
        },
        table_getCenterFooterGroups: {
          fn: () => table_getCenterFooterGroups(table),
          memoDeps: () => [callMemoOrStaticFn(table, "getCenterHeaderGroups", table_getCenterHeaderGroups)]
        },
        table_getEndFooterGroups: {
          fn: () => table_getEndFooterGroups(table),
          memoDeps: () => [callMemoOrStaticFn(table, "getEndHeaderGroups", table_getEndHeaderGroups)]
        },
        table_getStartFlatHeaders: {
          fn: () => table_getStartFlatHeaders(table),
          memoDeps: () => [callMemoOrStaticFn(table, "getStartHeaderGroups", table_getStartHeaderGroups)]
        },
        table_getEndFlatHeaders: {
          fn: () => table_getEndFlatHeaders(table),
          memoDeps: () => [callMemoOrStaticFn(table, "getEndHeaderGroups", table_getEndHeaderGroups)]
        },
        table_getCenterFlatHeaders: {
          fn: () => table_getCenterFlatHeaders(table),
          memoDeps: () => [callMemoOrStaticFn(table, "getCenterHeaderGroups", table_getCenterHeaderGroups)]
        },
        table_getStartLeafHeaders: {
          fn: () => table_getStartLeafHeaders(table),
          memoDeps: () => [callMemoOrStaticFn(table, "getStartHeaderGroups", table_getStartHeaderGroups)]
        },
        table_getEndLeafHeaders: {
          fn: () => table_getEndLeafHeaders(table),
          memoDeps: () => [callMemoOrStaticFn(table, "getEndHeaderGroups", table_getEndHeaderGroups)]
        },
        table_getCenterLeafHeaders: {
          fn: () => table_getCenterLeafHeaders(table),
          memoDeps: () => [callMemoOrStaticFn(table, "getCenterHeaderGroups", table_getCenterHeaderGroups)]
        },
        table_getStartLeafColumns: {
          fn: () => table_getStartLeafColumns(table),
          memoDeps: () => [
            table.options.columns,
            table.atoms.columnPinning?.get(),
            table.atoms.columnOrder?.get(),
            table.atoms.grouping?.get(),
            table.options.groupedColumnMode
          ]
        },
        table_getEndLeafColumns: {
          fn: () => table_getEndLeafColumns(table),
          memoDeps: () => [
            table.options.columns,
            table.atoms.columnPinning?.get(),
            table.atoms.columnOrder?.get(),
            table.atoms.grouping?.get(),
            table.options.groupedColumnMode
          ]
        },
        table_getCenterLeafColumns: {
          fn: () => table_getCenterLeafColumns(table),
          memoDeps: () => [
            table.options.columns,
            table.atoms.columnPinning?.get(),
            table.atoms.columnOrder?.get(),
            table.atoms.grouping?.get(),
            table.options.groupedColumnMode
          ]
        },
        table_getPinnedLeafColumns: { fn: (position) => table_getPinnedLeafColumns(table, position) },
        table_getStartVisibleLeafColumns: {
          fn: () => table_getStartVisibleLeafColumns(table),
          memoDeps: () => [
            table.options.columns,
            table.atoms.columnPinning?.get(),
            table.atoms.columnVisibility?.get(),
            table.atoms.columnOrder?.get(),
            table.atoms.grouping?.get(),
            table.options.groupedColumnMode
          ]
        },
        table_getCenterVisibleLeafColumns: {
          fn: () => table_getCenterVisibleLeafColumns(table),
          memoDeps: () => [
            table.options.columns,
            table.atoms.columnPinning?.get(),
            table.atoms.columnVisibility?.get(),
            table.atoms.columnOrder?.get(),
            table.atoms.grouping?.get(),
            table.options.groupedColumnMode
          ]
        },
        table_getEndVisibleLeafColumns: {
          fn: () => table_getEndVisibleLeafColumns(table),
          memoDeps: () => [
            table.options.columns,
            table.atoms.columnPinning?.get(),
            table.atoms.columnVisibility?.get(),
            table.atoms.columnOrder?.get(),
            table.atoms.grouping?.get(),
            table.options.groupedColumnMode
          ]
        },
        table_getPinnedVisibleLeafColumns: { fn: (position) => table_getPinnedVisibleLeafColumns(table, position) }
      });
    }
  };

  // node_modules/@tanstack/table-core/dist/features/column-sizing/columnSizingFeature.utils.js
  function getDefaultColumnSizingState() {
    return makeObjectMap();
  }
  function getDefaultColumnSizingColumnDef() {
    return {
      size: 150,
      minSize: 20,
      maxSize: Number.MAX_SAFE_INTEGER
    };
  }
  function column_getSize(column) {
    const defaultSizes = getDefaultColumnSizingColumnDef();
    const columnSizing = column.table.atoms.columnSizing?.get();
    const columnSize = columnSizing && hasOwn(columnSizing, column.id) ? columnSizing[column.id] : void 0;
    return Math.min(Math.max(column.columnDef.minSize ?? defaultSizes.minSize, columnSize ?? column.columnDef.size ?? defaultSizes.size), column.columnDef.maxSize ?? defaultSizes.maxSize);
  }
  function buildColumnOffsets(columns) {
    const starts = makeObjectMap();
    const afters = makeObjectMap();
    const sizes = new Array(columns.length);
    let start = 0;
    for (let i = 0; i < columns.length; i++) {
      const column = columns[i];
      const size = callMemoOrStaticFn(column, "getSize", column_getSize);
      sizes[i] = size;
      starts[column.id] = start;
      start += size;
    }
    let after = 0;
    for (let i = columns.length - 1; i >= 0; i--) {
      afters[columns[i].id] = after;
      after += sizes[i];
    }
    return {
      starts,
      afters
    };
  }
  function table_getColumnOffsets(table) {
    return {
      all: buildColumnOffsets(table_getPinnedVisibleLeafColumns(table)),
      center: buildColumnOffsets(table_getPinnedVisibleLeafColumns(table, "center")),
      start: buildColumnOffsets(table_getPinnedVisibleLeafColumns(table, "start")),
      end: buildColumnOffsets(table_getPinnedVisibleLeafColumns(table, "end"))
    };
  }
  function toOffsetsKey(position) {
    return position === "start" ? "start" : position === "end" ? "end" : position === "center" ? "center" : "all";
  }
  function column_getStart(column, position) {
    return callMemoOrStaticFn(column.table, "getColumnOffsets", table_getColumnOffsets)[toOffsetsKey(position)].starts[column.id] ?? 0;
  }
  function column_getAfter(column, position) {
    return callMemoOrStaticFn(column.table, "getColumnOffsets", table_getColumnOffsets)[toOffsetsKey(position)].afters[column.id] ?? 0;
  }
  function column_resetSize(column) {
    table_setColumnSizing(column.table, (old) => {
      const rest = makeObjectMap();
      const columnIds = Object.keys(old);
      for (let i = 0; i < columnIds.length; i++) {
        const columnId = columnIds[i];
        if (columnId !== column.id) rest[columnId] = old[columnId];
      }
      return rest;
    });
  }
  function sumHeaderSize(header) {
    if (!header.subHeaders.length) return column_getSize(header.column);
    let sum = 0;
    for (let i = 0; i < header.subHeaders.length; i++) sum += sumHeaderSize(header.subHeaders[i]);
    return sum;
  }
  function header_getSize(header) {
    return sumHeaderSize(header);
  }
  function header_getStart(header) {
    if (header.index > 0) {
      const prevSiblingHeader = header.headerGroup?.headers[header.index - 1];
      if (prevSiblingHeader) return callMemoOrStaticFn(prevSiblingHeader, "getStart", header_getStart) + callMemoOrStaticFn(prevSiblingHeader, "getSize", header_getSize);
    }
    return 0;
  }
  function table_setColumnSizing(table, updater) {
    table.options.onColumnSizingChange?.(updater);
  }
  function table_resetColumnSizing(table, defaultState) {
    table_setColumnSizing(table, defaultState ? makeObjectMap() : Object.assign(makeObjectMap(), cloneState(table.initialState.columnSizing ?? {})));
  }
  function table_getTotalSize(table) {
    return table.getHeaderGroups()[0]?.headers.reduce((sum, header) => {
      return sum + header_getSize(header);
    }, 0) ?? 0;
  }
  function table_getStartTotalSize(table) {
    return callMemoOrStaticFn(table, "getStartHeaderGroups", table_getStartHeaderGroups)[0]?.headers.reduce((sum, header) => {
      return sum + header_getSize(header);
    }, 0) ?? 0;
  }
  function table_getCenterTotalSize(table) {
    return callMemoOrStaticFn(table, "getCenterHeaderGroups", table_getCenterHeaderGroups)[0]?.headers.reduce((sum, header) => {
      return sum + header_getSize(header);
    }, 0) ?? 0;
  }
  function table_getEndTotalSize(table) {
    return callMemoOrStaticFn(table, "getEndHeaderGroups", table_getEndHeaderGroups)[0]?.headers.reduce((sum, header) => {
      return sum + header_getSize(header);
    }, 0) ?? 0;
  }

  // node_modules/@tanstack/table-core/dist/features/column-resizing/columnResizingFeature.utils.js
  function getDefaultColumnResizingState() {
    return {
      startOffset: null,
      startSize: null,
      deltaOffset: null,
      deltaPercentage: null,
      isResizingColumn: false,
      columnSizingStart: []
    };
  }
  function column_getCanResize(column) {
    return (column.columnDef.enableResizing ?? true) && (column.table.options.enableColumnResizing ?? true);
  }
  function column_getIsResizing(column) {
    return column.table.atoms.columnResizing?.get()?.isResizingColumn === column.id;
  }
  function header_getResizeHandler(header, _contextDocument) {
    const column = header.table.getColumn(header.column.id);
    const canResize = column_getCanResize(column);
    return (event) => {
      if (!canResize) return;
      if (isTouchStartEvent(event)) {
        if (event.touches.length > 1) return;
      }
      const startSize = header_getSize(header);
      const columnSizingStart = header.getLeafHeaders().map((leafHeader) => [leafHeader.column.id, column_getSize(leafHeader.column)]);
      const clientX = isTouchStartEvent(event) ? Math.round(event.touches[0].clientX) : event.clientX;
      const newColumnSizing = makeObjectMap();
      const updateOffset = (eventType, clientXPos) => {
        if (typeof clientXPos !== "number") return;
        const table = column.table;
        const isCommit = table.options.columnResizeMode === "onChange" || eventType === "end";
        table._reactivity.batch(() => {
          table_setColumnResizing(table, (old) => {
            const deltaDirection = table.options.columnResizeDirection === "rtl" ? -1 : 1;
            const deltaOffset = (clientXPos - (old.startOffset ?? 0)) * deltaDirection;
            const startSize2 = old.startSize ?? 0;
            const deltaPercentage = Math.max(startSize2 > 0 ? deltaOffset / startSize2 : 0, -0.999999);
            if (isCommit) {
              const columnSizingStart2 = old.columnSizingStart;
              for (let i = 0; i < columnSizingStart2.length; i++) {
                const entry = columnSizingStart2[i];
                const headerSize = entry[1];
                newColumnSizing[entry[0]] = Math.round(Math.max(headerSize > 0 ? headerSize + headerSize * deltaPercentage : deltaOffset / columnSizingStart2.length, 0) * 100) / 100;
              }
            }
            return {
              ...old,
              deltaOffset,
              deltaPercentage
            };
          });
          if (isCommit) table_setColumnSizing(table, (old) => Object.assign(makeObjectMap(), old, newColumnSizing));
        });
      };
      let moveRafId = null;
      let hasPendingMove = false;
      let latestMoveX;
      const flushMove = () => {
        if (hasPendingMove) {
          hasPendingMove = false;
          updateOffset("move", latestMoveX);
          moveRafId = requestAnimationFrame(flushMove);
        } else moveRafId = null;
      };
      const onMove = (clientXPos) => {
        latestMoveX = clientXPos;
        if (typeof requestAnimationFrame !== "function") {
          updateOffset("move", clientXPos);
          return;
        }
        if (moveRafId !== null) {
          hasPendingMove = true;
          return;
        }
        updateOffset("move", clientXPos);
        moveRafId = requestAnimationFrame(flushMove);
      };
      const onEnd = (clientXPos) => {
        if (moveRafId !== null) {
          cancelAnimationFrame(moveRafId);
          moveRafId = null;
          hasPendingMove = false;
        }
        column.table._reactivity.batch(() => {
          updateOffset("end", clientXPos ?? latestMoveX);
          table_setColumnResizing(column.table, (old) => ({
            ...old,
            isResizingColumn: false,
            startOffset: null,
            startSize: null,
            deltaOffset: null,
            deltaPercentage: null,
            columnSizingStart: []
          }));
        });
      };
      const contextDocument = _contextDocument || (typeof document !== "undefined" ? document : null);
      const mouseEvents = {
        moveHandler: (e) => onMove(e.clientX),
        upHandler: (e) => {
          contextDocument?.removeEventListener("mousemove", mouseEvents.moveHandler);
          contextDocument?.removeEventListener("mouseup", mouseEvents.upHandler);
          onEnd(e.clientX);
        }
      };
      const touchEvents = {
        moveHandler: (touchEvent) => {
          if (touchEvent.cancelable) {
            touchEvent.preventDefault();
            touchEvent.stopPropagation();
          }
          onMove(touchEvent.touches[0].clientX);
          return false;
        },
        upHandler: (e) => {
          removeTouchEvents();
          if (e.cancelable) {
            e.preventDefault();
            e.stopPropagation();
          }
          onEnd(e.touches[0]?.clientX);
        },
        cancelHandler: () => {
          removeTouchEvents();
          onEnd();
        }
      };
      const removeTouchEvents = () => {
        contextDocument?.removeEventListener("touchmove", touchEvents.moveHandler);
        contextDocument?.removeEventListener("touchend", touchEvents.upHandler);
        contextDocument?.removeEventListener("touchcancel", touchEvents.cancelHandler);
      };
      const passiveIfSupported = passiveEventSupported() ? { passive: false } : false;
      if (isTouchStartEvent(event)) {
        contextDocument?.addEventListener("touchmove", touchEvents.moveHandler, passiveIfSupported);
        contextDocument?.addEventListener("touchend", touchEvents.upHandler, passiveIfSupported);
        contextDocument?.addEventListener("touchcancel", touchEvents.cancelHandler, passiveIfSupported);
      } else {
        contextDocument?.addEventListener("mousemove", mouseEvents.moveHandler, passiveIfSupported);
        contextDocument?.addEventListener("mouseup", mouseEvents.upHandler, passiveIfSupported);
      }
      table_setColumnResizing(column.table, (old) => ({
        ...old,
        startOffset: clientX,
        startSize,
        deltaOffset: 0,
        deltaPercentage: 0,
        columnSizingStart,
        isResizingColumn: column.id
      }));
    };
  }
  function table_setColumnResizing(table, updater) {
    table.options.onColumnResizingChange?.(updater);
  }
  function table_resetHeaderSizeInfo(table, defaultState) {
    table_setColumnResizing(table, defaultState ? getDefaultColumnResizingState() : cloneState(table.initialState.columnResizing ?? getDefaultColumnResizingState()));
  }
  var passiveSupported = null;
  function passiveEventSupported() {
    if (typeof passiveSupported === "boolean") return passiveSupported;
    let supported = false;
    try {
      const options = { get passive() {
        supported = true;
        return false;
      } };
      const noop = () => {
      };
      window.addEventListener("test", noop, options);
      window.removeEventListener("test", noop);
    } catch (err) {
      supported = false;
    }
    passiveSupported = supported;
    return passiveSupported;
  }
  function isTouchStartEvent(e) {
    return e.type === "touchstart";
  }

  // node_modules/@tanstack/table-core/dist/features/column-resizing/columnResizingFeature.js
  var columnResizingFeature = {
    getInitialState: (initialState) => {
      return {
        columnResizing: getDefaultColumnResizingState(),
        ...initialState
      };
    },
    getDefaultTableOptions: (table) => {
      return {
        columnResizeMode: "onEnd",
        columnResizeDirection: "ltr",
        onColumnResizingChange: makeStateUpdater("columnResizing", table)
      };
    },
    assignColumnPrototype: (prototype, table) => {
      assignPrototypeAPIs("columnResizingFeature", prototype, table, {
        column_getCanResize: { fn: (column) => column_getCanResize(column) },
        column_getIsResizing: { fn: (column) => column_getIsResizing(column) }
      });
    },
    assignHeaderPrototype: (prototype, table) => {
      assignPrototypeAPIs("columnResizingFeature", prototype, table, { header_getResizeHandler: { fn: (header, _contextDocument) => header_getResizeHandler(header, _contextDocument) } });
    },
    constructTableAPIs: (table) => {
      assignTableAPIs("columnResizingFeature", table, {
        table_setColumnResizing: { fn: (updater) => table_setColumnResizing(table, updater) },
        table_resetHeaderSizeInfo: { fn: (defaultState) => table_resetHeaderSizeInfo(table, defaultState) }
      });
    }
  };

  // node_modules/@tanstack/table-core/dist/features/column-sizing/columnSizingFeature.js
  var columnSizingFeature = {
    getInitialState: (initialState) => {
      return {
        columnSizing: getDefaultColumnSizingState(),
        ...initialState
      };
    },
    getDefaultColumnDef: () => {
      return getDefaultColumnSizingColumnDef();
    },
    getDefaultTableOptions: (table) => {
      return { onColumnSizingChange: makeStateUpdater("columnSizing", table) };
    },
    assignColumnPrototype: (prototype, table) => {
      assignPrototypeAPIs("columnSizingFeature", prototype, table, {
        column_getSize: {
          fn: (column) => column_getSize(column),
          memoDeps: (column) => [table.options.columns, table.atoms.columnSizing?.get()?.[column.id]]
        },
        column_getStart: { fn: (column, position) => column_getStart(column, position) },
        column_getAfter: { fn: (column, position) => column_getAfter(column, position) },
        column_resetSize: { fn: (column) => column_resetSize(column) }
      });
    },
    assignHeaderPrototype: (prototype, table) => {
      assignPrototypeAPIs("columnSizingFeature", prototype, table, {
        header_getSize: {
          fn: (header) => header_getSize(header),
          memoDeps: (header) => [table.options.columns, header.column.columns.length > 0 ? table.atoms.columnSizing?.get() : table.atoms.columnSizing?.get()?.[header.column.id]]
        },
        header_getStart: {
          fn: (header) => header_getStart(header),
          memoDeps: () => [
            table.options.columns,
            table.atoms.columnSizing?.get(),
            table.atoms.columnOrder?.get(),
            table.atoms.columnPinning?.get(),
            table.atoms.columnVisibility?.get(),
            table.atoms.grouping?.get(),
            table.options.groupedColumnMode
          ]
        }
      });
    },
    constructTableAPIs: (table) => {
      assignTableAPIs("columnSizingFeature", table, {
        table_getColumnOffsets: {
          fn: () => table_getColumnOffsets(table),
          memoDeps: () => [
            table.options.columns,
            table.atoms.columnSizing?.get(),
            table.atoms.columnOrder?.get(),
            table.atoms.columnPinning?.get(),
            table.atoms.columnVisibility?.get(),
            table.atoms.grouping?.get(),
            table.options.groupedColumnMode
          ]
        },
        table_setColumnSizing: { fn: (updater) => table_setColumnSizing(table, updater) },
        table_resetColumnSizing: { fn: (defaultState) => table_resetColumnSizing(table, defaultState) },
        table_getTotalSize: {
          fn: () => table_getTotalSize(table),
          memoDeps: () => [table.atoms.columnSizing?.get(), table.getHeaderGroups()]
        },
        table_getStartTotalSize: {
          fn: () => table_getStartTotalSize(table),
          memoDeps: () => [table.atoms.columnSizing?.get(), table.getHeaderGroups()]
        },
        table_getCenterTotalSize: {
          fn: () => table_getCenterTotalSize(table),
          memoDeps: () => [table.atoms.columnSizing?.get(), table.getHeaderGroups()]
        },
        table_getEndTotalSize: {
          fn: () => table_getEndTotalSize(table),
          memoDeps: () => [table.atoms.columnSizing?.get(), table.getHeaderGroups()]
        }
      });
    }
  };

  // node_modules/@tanstack/table-core/dist/features/column-visibility/columnVisibilityFeature.js
  var columnVisibilityFeature = {
    getInitialState: (initialState) => {
      return {
        columnVisibility: getDefaultColumnVisibilityState(),
        ...initialState
      };
    },
    getDefaultTableOptions: (table) => {
      return { onColumnVisibilityChange: makeStateUpdater("columnVisibility", table) };
    },
    assignColumnPrototype: (prototype, table) => {
      assignPrototypeAPIs("columnVisibilityFeature", prototype, table, {
        column_getIsVisible: {
          fn: (column) => column_getIsVisible(column),
          memoDeps: (column) => [
            table.options.columns,
            table.atoms.columnVisibility?.get(),
            column.columns
          ]
        },
        column_getCanHide: { fn: (column) => column_getCanHide(column) },
        column_getToggleVisibilityHandler: { fn: (column) => column_getToggleVisibilityHandler(column) },
        column_toggleVisibility: { fn: (column, visible) => column_toggleVisibility(column, visible) }
      });
    },
    assignRowPrototype: (prototype, table) => {
      assignPrototypeAPIs("columnVisibilityFeature", prototype, table, {
        row_getVisibleCells: {
          fn: (row) => row_getVisibleCells(row),
          memoDeps: (row) => [
            row.getAllCells(),
            table.atoms.columnPinning?.get(),
            table.atoms.columnVisibility?.get()
          ]
        },
        row_getVisibleCellsByColumnId: {
          fn: (row) => row_getVisibleCellsByColumnId(row),
          memoDeps: (row) => [row.getAllCells(), table.atoms.columnVisibility?.get()]
        }
      });
    },
    constructTableAPIs: (table) => {
      assignTableAPIs("columnVisibilityFeature", table, {
        table_getVisibleFlatColumns: {
          fn: () => table_getVisibleFlatColumns(table),
          memoDeps: () => [
            table.atoms.columnVisibility?.get(),
            table.atoms.columnOrder?.get(),
            table.atoms.grouping?.get(),
            table.options.columns,
            table.options.groupedColumnMode
          ]
        },
        table_getVisibleLeafColumns: {
          fn: () => table_getVisibleLeafColumns(table),
          memoDeps: () => [
            table.atoms.columnVisibility?.get(),
            table.atoms.columnOrder?.get(),
            table.atoms.grouping?.get(),
            table.options.columns,
            table.options.groupedColumnMode
          ]
        },
        table_setColumnVisibility: { fn: (updater) => table_setColumnVisibility(table, updater) },
        table_resetColumnVisibility: { fn: (defaultState) => table_resetColumnVisibility(table, defaultState) },
        table_toggleAllColumnsVisible: { fn: (value) => table_toggleAllColumnsVisible(table, value) },
        table_getIsAllColumnsVisible: { fn: () => table_getIsAllColumnsVisible(table) },
        table_getIsSomeColumnsVisible: { fn: () => table_getIsSomeColumnsVisible(table) },
        table_getToggleAllColumnsVisibilityHandler: { fn: () => table_getToggleAllColumnsVisibilityHandler(table) }
      });
    }
  };

  // node_modules/@tanstack/table-core/dist/features/column-filtering/filterFns.js
  function constructFilterFn(def) {
    const filterFn = Object.assign((row, columnId, filterValue, addMeta) => {
      const rawValue = row.getValue(columnId);
      const dataValue = filterFn.resolveDataValue ? filterFn.resolveDataValue(rawValue) : rawValue;
      return filterFn.filter(dataValue, filterValue, row, columnId, addMeta);
    }, def);
    return filterFn;
  }
  var filterFn_equals = constructFilterFn({
    filter: (dataValue, filterValue) => dataValue === filterValue,
    autoRemove: (val) => testFalsy(val)
  });
  var filterFn_weakEquals = constructFilterFn({
    filter: (dataValue, filterValue) => dataValue == filterValue,
    autoRemove: (val) => testFalsy(val)
  });
  var filterFn_includesStringSensitive = constructFilterFn({
    filter: (dataValue, filterValue) => Boolean(dataValue?.includes(filterValue)),
    autoRemove: (val) => testFalsy(val),
    resolveFilterValue: (val) => String(val),
    resolveDataValue: (val) => val == null ? void 0 : String(val)
  });
  var filterFn_includesString = constructFilterFn({
    filter: (dataValue, filterValue) => Boolean(dataValue?.includes(filterValue)),
    autoRemove: (val) => testFalsy(val),
    resolveFilterValue: (val) => String(val).toLowerCase(),
    resolveDataValue: (val) => val == null ? void 0 : String(val).toLowerCase()
  });
  var filterFn_equalsString = constructFilterFn({
    filter: (dataValue, filterValue) => dataValue === filterValue,
    autoRemove: (val) => testFalsy(val),
    resolveFilterValue: (val) => String(val).toLowerCase(),
    resolveDataValue: (val) => val == null ? void 0 : String(val).toLowerCase()
  });
  var filterFn_equalsStringSensitive = constructFilterFn({
    filter: (dataValue, filterValue) => dataValue === filterValue,
    autoRemove: (val) => testFalsy(val),
    resolveFilterValue: (val) => String(val),
    resolveDataValue: (val) => val == null ? void 0 : String(val)
  });
  var filterFn_startsWith = constructFilterFn({
    filter: (dataValue, filterValue) => Boolean(dataValue?.startsWith(filterValue)),
    autoRemove: (val) => testFalsy(val),
    resolveFilterValue: (val) => String(val).toLowerCase(),
    resolveDataValue: (val) => val == null ? void 0 : String(val).toLowerCase()
  });
  var filterFn_endsWith = constructFilterFn({
    filter: (dataValue, filterValue) => Boolean(dataValue?.endsWith(filterValue)),
    autoRemove: (val) => testFalsy(val),
    resolveFilterValue: (val) => String(val).toLowerCase(),
    resolveDataValue: (val) => val == null ? void 0 : String(val).toLowerCase()
  });
  var filterFn_empty = constructFilterFn({
    filter: (dataValue) => testValueEmpty(dataValue),
    autoRemove: (val) => testFalsy(val) || val === false
  });
  var filterFn_notEmpty = constructFilterFn({
    filter: (dataValue) => !testValueEmpty(dataValue),
    autoRemove: (val) => testFalsy(val) || val === false
  });
  var filterFn_greaterThan = constructFilterFn({
    filter: (dataValue, filterValue) => compareGreaterThan(dataValue, filterValue),
    autoRemove: (val) => testFalsy(val)
  });
  var filterFn_greaterThanOrEqualTo = constructFilterFn({
    filter: (dataValue, filterValue) => compareGreaterThanOrEqualTo(dataValue, filterValue),
    autoRemove: (val) => testFalsy(val)
  });
  var filterFn_lessThan = constructFilterFn({
    filter: (dataValue, filterValue) => !compareGreaterThanOrEqualTo(dataValue, filterValue),
    autoRemove: (val) => testFalsy(val)
  });
  var filterFn_lessThanOrEqualTo = constructFilterFn({
    filter: (dataValue, filterValue) => !compareGreaterThan(dataValue, filterValue),
    autoRemove: (val) => testFalsy(val)
  });
  var filterFn_between = constructFilterFn({
    filter: (dataValue, filterValues) => compareBetween(dataValue, filterValues, false),
    autoRemove: (val) => testFalsy(val) || Array.isArray(val) && testFalsy(val[0]) && testFalsy(val[1])
  });
  var filterFn_betweenInclusive = constructFilterFn({
    filter: (dataValue, filterValues) => compareBetween(dataValue, filterValues, true),
    autoRemove: (val) => testFalsy(val) || Array.isArray(val) && testFalsy(val[0]) && testFalsy(val[1])
  });
  var filterFn_inNumberRange = constructFilterFn({
    filter: (dataValue, filterValue) => {
      if (typeof dataValue !== "number" || Number.isNaN(dataValue)) return false;
      const [min, max] = filterValue;
      return dataValue >= min && dataValue <= max;
    },
    resolveFilterValue: (val) => {
      const [unsafeMin, unsafeMax] = val;
      const parsedMin = typeof unsafeMin !== "number" ? parseFloat(unsafeMin) : unsafeMin;
      const parsedMax = typeof unsafeMax !== "number" ? parseFloat(unsafeMax) : unsafeMax;
      let min = unsafeMin === null || Number.isNaN(parsedMin) ? -Infinity : parsedMin;
      let max = unsafeMax === null || Number.isNaN(parsedMax) ? Infinity : parsedMax;
      if (min > max) {
        const temp = min;
        min = max;
        max = temp;
      }
      return [min, max];
    },
    autoRemove: (val) => testFalsy(val) || Array.isArray(val) && testFalsy(val[0]) && testFalsy(val[1])
  });
  var filterFn_inDateRange = constructFilterFn({
    filter: (dataValue, filterValue) => {
      const [min, max] = filterValue;
      return dataValue >= min && dataValue <= max;
    },
    resolveFilterValue: (val) => {
      const [unsafeMin, unsafeMax] = val;
      const parsedMin = toDateTimestamp(unsafeMin);
      const parsedMax = toDateTimestamp(unsafeMax);
      let min = Number.isNaN(parsedMin) ? -Infinity : parsedMin;
      let max = Number.isNaN(parsedMax) ? Infinity : parsedMax;
      if (min > max) {
        const temp = min;
        min = max;
        max = temp;
      }
      return [min, max];
    },
    resolveDataValue: (val) => toDateTimestamp(val),
    autoRemove: (val) => testFalsy(val) || Array.isArray(val) && testFalsy(val[0]) && testFalsy(val[1])
  });
  var filterFn_arrHas = constructFilterFn({
    filter: (dataValue, filterValue) => {
      for (let i = 0; i < filterValue.length; i++) if (dataValue === filterValue[i]) return true;
      return false;
    },
    autoRemove: (val) => testFalsy(val) || !val?.length
  });
  var filterFn_arrIncludes = constructFilterFn({
    filter: (dataValue, filterValue) => {
      if (typeof dataValue !== "string" && !Array.isArray(dataValue)) return false;
      for (let i = 0; i < filterValue.length; i++) if (dataValue.includes(filterValue[i])) return true;
      return false;
    },
    autoRemove: (val) => testFalsy(val) || !val?.length
  });
  var filterFn_arrIncludesAll = constructFilterFn({
    filter: (dataValue, filterValue) => {
      if (!Array.isArray(dataValue)) return false;
      for (let i = 0; i < filterValue.length; i++) if (!dataValue.includes(filterValue[i])) return false;
      return true;
    },
    autoRemove: (val) => testFalsy(val) || !val?.length
  });
  var filterFn_arrIncludesSome = constructFilterFn({
    filter: (dataValue, filterValue) => {
      if (!Array.isArray(dataValue)) return false;
      for (let i = 0; i < filterValue.length; i++) if (dataValue.includes(filterValue[i])) return true;
      return false;
    },
    autoRemove: (val) => testFalsy(val) || !val?.length
  });
  function testFalsy(val) {
    return val === void 0 || val === null || val === "";
  }
  function testValueEmpty(dataValue) {
    return dataValue == null || String(dataValue).trim() === "";
  }
  function toDateTimestamp(value) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number") return value;
    if (value == null || value === "") return NaN;
    return new Date(value).getTime();
  }
  function compareGreaterThan(dataValue, filterValue) {
    const numericDataValue = dataValue == null ? 0 : +dataValue;
    const numericFilterValue = Number(filterValue);
    if (!isNaN(numericFilterValue) && !isNaN(numericDataValue)) return numericDataValue > numericFilterValue;
    return String(dataValue ?? "").toLowerCase().trim() > String(filterValue).toLowerCase().trim();
  }
  function compareGreaterThanOrEqualTo(dataValue, filterValue) {
    return dataValue === filterValue || compareGreaterThan(dataValue, filterValue);
  }
  function compareBetween(dataValue, filterValues, inclusive) {
    const min = filterValues[0];
    const hasMin = min !== "" && min !== void 0;
    if (hasMin) {
      if (!(inclusive ? compareGreaterThanOrEqualTo(dataValue, min) : compareGreaterThan(dataValue, min))) return false;
    }
    const max = filterValues[1];
    if (max === "" || max === void 0) return true;
    if (hasMin) {
      const numericMin = Number(min);
      const numericMax = Number(max);
      if (!isNaN(numericMin) && !isNaN(numericMax) && numericMin > numericMax) return true;
    }
    return inclusive ? !compareGreaterThan(dataValue, max) : !compareGreaterThanOrEqualTo(dataValue, max);
  }

  // node_modules/@tanstack/table-core/dist/features/global-filtering/globalFilteringFeature.utils.js
  function column_getCanGlobalFilter(column) {
    return (column.columnDef.enableGlobalFilter ?? true) && (column.table.options.enableGlobalFilter ?? true) && (column.table.options.enableFilters ?? true) && (column.table.options.getColumnCanGlobalFilter?.(column) ?? true) && !!column.accessorFn;
  }
  function table_getGlobalAutoFilterFn() {
    return filterFn_includesString;
  }
  function table_getGlobalFilterFn(table) {
    const { globalFilterFn } = table.options;
    const filterFns = table._rowModelFns.filterFns;
    const filterFn = isFunction(globalFilterFn) ? globalFilterFn : globalFilterFn === "auto" ? table_getGlobalAutoFilterFn() : filterFns?.[globalFilterFn];
    if (!filterFn && globalFilterFn != null) console.warn(`globalFilterFn '${String(globalFilterFn)}' is not registered`);
    return filterFn;
  }
  function table_setGlobalFilter(table, updater) {
    table.options.onGlobalFilterChange?.(updater);
  }
  function table_resetGlobalFilter(table, defaultState) {
    table_setGlobalFilter(table, defaultState ? void 0 : cloneState(table.initialState.globalFilter));
  }

  // node_modules/@tanstack/table-core/dist/features/global-filtering/globalFilteringFeature.js
  var globalFilteringFeature = {
    getInitialState: (initialState) => {
      return {
        globalFilter: void 0,
        ...initialState
      };
    },
    getDefaultTableOptions: (table) => {
      return {
        onGlobalFilterChange: makeStateUpdater("globalFilter", table),
        globalFilterFn: "auto",
        getColumnCanGlobalFilter: (column) => {
          if ("enableGlobalFilter" in column.columnDef && column.columnDef.enableGlobalFilter === true) return true;
          const value = table.getCoreRowModel().flatRows.find((row) => row.getAllCellsByColumnId()[column.id]?.getValue() != null)?.getAllCellsByColumnId()[column.id]?.getValue();
          return typeof value === "string" || typeof value === "number";
        }
      };
    },
    assignColumnPrototype: (prototype, table) => {
      assignPrototypeAPIs("globalFilteringFeature", prototype, table, { column_getCanGlobalFilter: { fn: (column) => column_getCanGlobalFilter(column) } });
    },
    constructTableAPIs: (table) => {
      assignTableAPIs("globalFilteringFeature", table, {
        table_getGlobalAutoFilterFn: { fn: () => table_getGlobalAutoFilterFn() },
        table_getGlobalFilterFn: { fn: () => table_getGlobalFilterFn(table) },
        table_setGlobalFilter: { fn: (updater) => table_setGlobalFilter(table, updater) },
        table_resetGlobalFilter: { fn: (defaultState) => table_resetGlobalFilter(table, defaultState) }
      });
    }
  };

  // node_modules/@tanstack/table-core/dist/features/row-expanding/rowExpandingFeature.js
  var rowExpandingFeature = {
    getInitialState: (initialState) => {
      return {
        expanded: getDefaultExpandedState(),
        ...initialState
      };
    },
    getDefaultTableOptions: (table) => {
      return {
        onExpandedChange: makeStateUpdater("expanded", table),
        paginateExpandedRows: true
      };
    },
    assignRowPrototype: (prototype, table) => {
      assignPrototypeAPIs("rowExpandingFeature", prototype, table, {
        row_toggleExpanded: { fn: (row, expanded) => row_toggleExpanded(row, expanded) },
        row_getIsExpanded: { fn: (row) => row_getIsExpanded(row) },
        row_getCanExpand: { fn: (row) => row_getCanExpand(row) },
        row_getIsAllParentsExpanded: { fn: (row) => row_getIsAllParentsExpanded(row) },
        row_getToggleExpandedHandler: { fn: (row) => row_getToggleExpandedHandler(row) }
      });
    },
    constructTableAPIs: (table) => {
      assignTableAPIs("rowExpandingFeature", table, {
        table_autoResetExpanded: { fn: () => table_autoResetExpanded(table) },
        table_setExpanded: { fn: (updater) => table_setExpanded(table, updater) },
        table_toggleAllRowsExpanded: { fn: (expanded) => table_toggleAllRowsExpanded(table, expanded) },
        table_resetExpanded: { fn: (defaultState) => table_resetExpanded(table, defaultState) },
        table_getCanSomeRowsExpand: { fn: () => table_getCanSomeRowsExpand(table) },
        table_getToggleAllRowsExpandedHandler: { fn: () => table_getToggleAllRowsExpandedHandler(table) },
        table_getIsSomeRowsExpanded: { fn: () => table_getIsSomeRowsExpanded(table) },
        table_getIsAllRowsExpanded: { fn: () => table_getIsAllRowsExpanded(table) },
        table_getExpandedDepth: { fn: () => table_getExpandedDepth(table) }
      });
    }
  };

  // node_modules/@tanstack/table-core/dist/features/row-sorting/rowSortingFeature.js
  var rowSortingFeature = {
    getInitialState(initialState) {
      return {
        sorting: getDefaultSortingState(),
        ...initialState
      };
    },
    getDefaultColumnDef() {
      return {
        sortFn: "auto",
        sortUndefined: 1
      };
    },
    getDefaultTableOptions(table) {
      return {
        autoResetSorting: false,
        onSortingChange: makeStateUpdater("sorting", table),
        isMultiSortEvent: (e) => {
          return e.shiftKey;
        }
      };
    },
    assignColumnPrototype(prototype, table) {
      assignPrototypeAPIs("rowSortingFeature", prototype, table, {
        column_getAutoSortFn: { fn: (column) => column_getAutoSortFn(column) },
        column_getAutoSortDir: { fn: (column) => column_getAutoSortDir(column) },
        column_getSortFn: { fn: (column) => column_getSortFn(column) },
        column_toggleSorting: { fn: (column, desc, multi) => column_toggleSorting(column, desc, multi) },
        column_getFirstSortDir: { fn: (column) => column_getFirstSortDir(column) },
        column_getNextSortingOrder: { fn: (column, multi) => column_getNextSortingOrder(column, multi) },
        column_getCanSort: { fn: (column) => column_getCanSort(column) },
        column_getCanMultiSort: { fn: (column) => column_getCanMultiSort(column) },
        column_getIsSorted: { fn: (column) => column_getIsSorted(column) },
        column_getSortIndex: { fn: (column) => column_getSortIndex(column) },
        column_clearSorting: { fn: (column) => column_clearSorting(column) },
        column_getToggleSortingHandler: { fn: (column) => column_getToggleSortingHandler(column) }
      });
    },
    constructTableAPIs(table) {
      assignTableAPIs("rowSortingFeature", table, {
        table_setSorting: { fn: (updater) => table_setSorting(table, updater) },
        table_resetSorting: { fn: (defaultState) => table_resetSorting(table, defaultState) }
      });
    }
  };

  // node_modules/@tanstack/table-core/dist/features/column-filtering/filterRowsUtils.js
  function filterRows(rows, filterRowImpl, table) {
    if (table.options.filterFromLeafRows) return filterRowModelFromLeafs(rows, filterRowImpl, table);
    return filterRowModelFromRoot(rows, filterRowImpl, table);
  }
  function filterRowModelFromLeafs(rowsToFilter, filterRow, table) {
    const newFilteredFlatRows = [];
    const newFilteredRowsById = makeObjectMap();
    const maxDepth = table.options.maxLeafRowFilterDepth ?? 100;
    const recurseFilterRows = (rowsToFilter2, depth = 0) => {
      const filteredRows = [];
      for (const row of rowsToFilter2) {
        const newRow = constructRow(table, row.id, row.original, row.index, row.depth, void 0, row.parentId);
        newRow.columnFilters = row.columnFilters;
        newRow.columnFiltersMeta = row.columnFiltersMeta;
        if (row.subRows.length && depth < maxDepth) {
          newRow.subRows = recurseFilterRows(row.subRows, depth + 1);
          if (newRow.subRows.length || filterRow(newRow)) filteredRows.push(newRow);
        } else if (filterRow(newRow)) {
          newRow.subRows = row.subRows;
          filteredRows.push(newRow);
        }
      }
      return filteredRows;
    };
    const rows = recurseFilterRows(rowsToFilter);
    addSubRowsToFlatArrays(rows, newFilteredFlatRows, newFilteredRowsById);
    return {
      rows,
      flatRows: newFilteredFlatRows,
      rowsById: newFilteredRowsById
    };
  }
  function filterRowModelFromRoot(rowsToFilter, filterRow, table) {
    const newFilteredFlatRows = [];
    const newFilteredRowsById = makeObjectMap();
    const maxDepth = table.options.maxLeafRowFilterDepth ?? 100;
    const recurseFilterRows = (rowsToFilter2, depth = 0) => {
      const filteredRows = [];
      for (const row of rowsToFilter2) if (filterRow(row)) if (row.subRows.length && depth < maxDepth) {
        const newRow = constructRow(table, row.id, row.original, row.index, row.depth, void 0, row.parentId);
        const filterData = row;
        newRow.columnFilters = filterData.columnFilters;
        newRow.columnFiltersMeta = filterData.columnFiltersMeta;
        filteredRows.push(newRow);
        newFilteredFlatRows.push(newRow);
        newFilteredRowsById[newRow.id] = newRow;
        newRow.subRows = recurseFilterRows(row.subRows, depth + 1);
      } else {
        filteredRows.push(row);
        newFilteredFlatRows.push(row);
        newFilteredRowsById[row.id] = row;
        if (row.subRows.length && depth >= maxDepth) addSubRowsToFlatArrays(row.subRows, newFilteredFlatRows, newFilteredRowsById);
      }
      return filteredRows;
    };
    return {
      rows: recurseFilterRows(rowsToFilter),
      flatRows: newFilteredFlatRows,
      rowsById: newFilteredRowsById
    };
  }
  function addSubRowsToFlatArrays(subRows, flatRows, rowsById) {
    for (const subRow of subRows) {
      flatRows.push(subRow);
      rowsById[subRow.id] = subRow;
      if (subRow.subRows.length) addSubRowsToFlatArrays(subRow.subRows, flatRows, rowsById);
    }
  }

  // node_modules/@tanstack/table-core/dist/features/column-filtering/createFilteredRowModel.js
  function createFilteredRowModel() {
    return (_table) => {
      const table = _table;
      return tableMemo({
        feature: "columnFilteringFeature",
        table,
        fnName: "table.getFilteredRowModel",
        memoDeps: () => [
          table.getPreFilteredRowModel(),
          table.atoms.columnFilters?.get(),
          table.atoms.globalFilter?.get()
        ],
        fn: () => _createFilteredRowModel(table),
        onAfterUpdate: skipFirstRun(() => table_autoResetPageIndex(table))
      });
    };
  }
  function _createFilteredRowModel(table) {
    const rowModel = table.getPreFilteredRowModel();
    const columnFilters = table.atoms.columnFilters?.get();
    const globalFilter = table.atoms.globalFilter?.get();
    const hasGlobalFilter = globalFilter !== void 0 && globalFilter !== null && globalFilter !== "";
    if (!rowModel.rows.length || !columnFilters?.length && !hasGlobalFilter) {
      const flatRows2 = rowModel.flatRows;
      for (let i = 0; i < flatRows2.length; i++) {
        const row = flatRows2[i];
        row.columnFilters = makeObjectMap();
        row.columnFiltersMeta = makeObjectMap();
      }
      return rowModel;
    }
    const resolvedColumnFilters = [];
    const resolvedGlobalFilters = [];
    columnFilters?.forEach((columnFilter) => {
      const column = table_getColumn(table, columnFilter.id);
      if (!column) return;
      const filterFn = column_getFilterFn(column);
      if (!filterFn) return;
      resolvedColumnFilters.push({
        id: columnFilter.id,
        filterFn,
        resolvedValue: filterFn.resolveFilterValue?.(columnFilter.value) ?? columnFilter.value
      });
    });
    const filterableIds = columnFilters?.map((d) => d.id) ?? [];
    const globalFilterFn = table_getGlobalFilterFn(table);
    const globallyFilterableColumns = table.getAllLeafColumns().filter((column) => column_getCanGlobalFilter(column));
    if (hasGlobalFilter && globalFilterFn && globallyFilterableColumns.length) {
      filterableIds.push("__global__");
      globallyFilterableColumns.forEach((column) => {
        resolvedGlobalFilters.push({
          id: column.id,
          filterFn: globalFilterFn,
          resolvedValue: globalFilterFn.resolveFilterValue?.(globalFilter) ?? globalFilter
        });
      });
    }
    const flatRows = rowModel.flatRows;
    for (let i = 0; i < flatRows.length; i++) {
      const row = flatRows[i];
      row.columnFilters = makeObjectMap();
      row.columnFiltersMeta = makeObjectMap();
      if (resolvedColumnFilters.length) for (let j = 0; j < resolvedColumnFilters.length; j++) {
        const currentColumnFilter = resolvedColumnFilters[j];
        const id = currentColumnFilter.id;
        row.columnFilters[id] = currentColumnFilter.filterFn(row, id, currentColumnFilter.resolvedValue, (filterMeta) => {
          if (!row.columnFiltersMeta) row.columnFiltersMeta = makeObjectMap();
          row.columnFiltersMeta[id] = filterMeta;
        });
      }
      if (resolvedGlobalFilters.length) {
        for (let j = 0; j < resolvedGlobalFilters.length; j++) {
          const currentGlobalFilter = resolvedGlobalFilters[j];
          const id = currentGlobalFilter.id;
          if (currentGlobalFilter.filterFn(row, id, currentGlobalFilter.resolvedValue, (filterMeta) => {
            if (!row.columnFiltersMeta) row.columnFiltersMeta = makeObjectMap();
            row.columnFiltersMeta[id] = filterMeta;
          })) {
            row.columnFilters.__global__ = true;
            break;
          }
        }
        if (row.columnFilters.__global__ !== true) row.columnFilters.__global__ = false;
      }
    }
    const filterRowsImpl = (row) => {
      for (let i = 0; i < filterableIds.length; i++) if (row.columnFilters[filterableIds[i]] === false) return false;
      return true;
    };
    return filterRows(rowModel.rows, filterRowsImpl, table);
  }

  // node_modules/@tanstack/table-core/dist/features/column-grouping/createGroupedRowModel.js
  function createGroupedRowModel() {
    return (_table) => {
      const table = _table;
      let hasAutoResetDependencies = false;
      let previousGrouping;
      let previousPreGroupedRowModel;
      return tableMemo({
        feature: "columnGroupingFeature",
        table,
        fnName: "table.getGroupedRowModel",
        memoDeps: () => [
          table.atoms.grouping?.get(),
          table.getPreGroupedRowModel(),
          table.options.columns
        ],
        fn: () => _createGroupedRowModel(table),
        onAfterUpdate: () => {
          const grouping = table.atoms.grouping?.get();
          const preGroupedRowModel = table.getPreGroupedRowModel();
          const rowInputsChanged = hasAutoResetDependencies && (grouping !== previousGrouping || preGroupedRowModel !== previousPreGroupedRowModel);
          previousGrouping = grouping;
          previousPreGroupedRowModel = preGroupedRowModel;
          hasAutoResetDependencies = true;
          if (rowInputsChanged) {
            table_autoResetExpanded(table);
            table_autoResetPageIndex(table);
          }
        }
      });
    };
  }
  function _createGroupedRowModel(table) {
    const rowModel = table.getPreGroupedRowModel();
    const grouping = table.atoms.grouping?.get();
    if (!rowModel.rows.length || !grouping?.length) {
      resetRowRelationships(rowModel.rows, 0, void 0);
      return rowModel;
    }
    const existingGrouping = grouping.filter((columnId) => table_getColumn(table, columnId));
    const groupedFlatRows = [];
    const groupedRowsById = makeObjectMap();
    const groupUpRecursively = (rows, depth = 0, parentId) => {
      if (depth >= existingGrouping.length) return rows.map((row) => {
        row.depth = depth;
        groupedFlatRows.push(row);
        groupedRowsById[row.id] = row;
        if (row.subRows.length) row.subRows = groupUpRecursively(row.subRows, depth + 1, row.id);
        return row;
      });
      const columnId = existingGrouping[depth];
      const rowGroupsMap = groupBy(table, rows, columnId);
      return Array.from(rowGroupsMap.entries()).map(([groupingValue, groupedRows], index) => {
        let id = `${columnId}:${groupingValue}`;
        id = parentId ? `${parentId}>${id}` : id;
        const flatIndex = groupedFlatRows.length;
        groupedFlatRows.push(void 0);
        const subRows = groupUpRecursively(groupedRows, depth + 1, id);
        subRows.forEach((subRow) => {
          subRow.parentId = id;
        });
        const leafRows = normalizeUniqueAggregationRows(groupedRows, Infinity);
        const row = constructRow(table, id, leafRows[0].original, index, depth, void 0, parentId);
        Object.assign(row, {
          groupingColumnId: columnId,
          groupingValue,
          subRows,
          leafRows,
          getValue: (colId) => {
            const groupingIndex = existingGrouping.indexOf(colId);
            if (groupingIndex !== -1 && groupingIndex <= depth) {
              if (hasOwn(row._valuesCache, colId)) return row._valuesCache[colId];
              if (groupedRows[0]) row._valuesCache[colId] = groupedRows[0].getValue(colId) ?? void 0;
              return row._valuesCache[colId];
            }
            const aggregationCache = row._aggregationValuesCache;
            if (aggregationCache && hasOwn(aggregationCache, colId)) return aggregationCache[colId];
            const column = table.getColumn(colId);
            if (typeof column.getAggregationFns !== "function") return void 0;
            const cache = row._aggregationValuesCache ??= makeObjectMap();
            cache[colId] = aggregateColumnValue({
              subRows,
              column,
              groupingRow: row,
              rows: groupedRows,
              uniqueRows: true
            });
            return cache[colId];
          }
        });
        groupedFlatRows[flatIndex] = row;
        groupedRowsById[id] = row;
        return row;
      });
    };
    return {
      rows: groupUpRecursively(rowModel.rows, 0),
      flatRows: groupedFlatRows,
      rowsById: groupedRowsById
    };
  }
  function resetRowRelationships(rows, depth, parentId) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      row.depth = depth;
      row.parentId = parentId;
      if (row.subRows.length) resetRowRelationships(row.subRows, depth + 1, row.id);
    }
  }
  function groupBy(table, rows, columnId) {
    const groupMap = /* @__PURE__ */ new Map();
    const getGroupingValue = table_getColumn(table, columnId)?.columnDef.getGroupingValue;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      let groupingValue;
      if (getGroupingValue) {
        const cache = row._groupingValuesCache;
        if (cache && hasOwn(cache, columnId)) groupingValue = cache[columnId];
        else if (cache) groupingValue = cache[columnId] = getGroupingValue(row.original, row.index, row);
      } else groupingValue = row.getValue(columnId);
      const resKey = `${groupingValue}`;
      const previous = groupMap.get(resKey);
      if (!previous) groupMap.set(resKey, [row]);
      else previous.push(row);
    }
    return groupMap;
  }

  // node_modules/@tanstack/table-core/dist/features/row-expanding/createExpandedRowModel.js
  function createExpandedRowModel() {
    return (_table) => {
      const table = _table;
      return tableMemo({
        feature: "rowExpandingFeature",
        table,
        fnName: "table.getExpandedRowModel",
        memoDeps: () => [
          table.atoms.expanded?.get(),
          table.getPreExpandedRowModel(),
          table.options.paginateExpandedRows,
          table.options.manualPagination
        ],
        fn: () => _createExpandedRowModel(table)
      });
    };
  }
  function _createExpandedRowModel(table) {
    const rowModel = table.getPreExpandedRowModel();
    const expanded = table.atoms.expanded?.get();
    if (!rowModel.rows.length || expanded !== true && !Object.keys(expanded ?? {}).length) return rowModel;
    if (!table.options.paginateExpandedRows && !table.options.manualPagination) return rowModel;
    return expandRows(rowModel);
  }
  function expandRows(rowModel) {
    const expandedRows = [];
    const handleRow = (row) => {
      expandedRows.push(row);
      if (row.subRows.length && row_getIsExpanded(row)) row.subRows.forEach(handleRow);
    };
    rowModel.rows.forEach(handleRow);
    return {
      rows: expandedRows,
      flatRows: rowModel.flatRows,
      rowsById: rowModel.rowsById
    };
  }

  // node_modules/@tanstack/table-core/dist/features/row-sorting/createSortedRowModel.js
  function createSortedRowModel() {
    return (_table) => {
      const table = _table;
      return tableMemo({
        feature: "rowSortingFeature",
        table,
        fnName: "table.getSortedRowModel",
        memoDeps: () => [table.atoms.sorting?.get(), table.getPreSortedRowModel()],
        fn: () => _createSortedRowModel(table),
        onAfterUpdate: skipFirstRun(() => table_autoResetPageIndex(table))
      });
    };
  }
  function _createSortedRowModel(table) {
    const preSortedRowModel = table.getPreSortedRowModel();
    const sorting = table.atoms.sorting?.get();
    if (!preSortedRowModel.rows.length || !sorting?.length) return preSortedRowModel;
    const sortedFlatRows = [];
    const availableSorting = sorting.filter((sort) => {
      const column = table.getColumn(sort.id);
      return column ? column_getCanSort(column) : false;
    });
    if (!availableSorting.length) return preSortedRowModel;
    const resolvedSorting = [];
    for (let i = 0; i < availableSorting.length; i++) {
      const sortEntry = availableSorting[i];
      const column = table.getColumn(sortEntry.id);
      if (!column) continue;
      resolvedSorting.push({
        id: sortEntry.id,
        desc: sortEntry.desc,
        sortUndefined: column.columnDef.sortUndefined,
        invertSorting: column.columnDef.invertSorting,
        sortFn: column_getSortFn(column)
      });
    }
    const compareRows = (rowA, rowB) => {
      for (let i = 0; i < resolvedSorting.length; i++) {
        const sortEntry = resolvedSorting[i];
        const sortUndefined = sortEntry.sortUndefined;
        const isDesc = sortEntry.desc;
        let sortInt = 0;
        if (sortUndefined) {
          const aValue = rowA.getValue(sortEntry.id);
          const bValue = rowB.getValue(sortEntry.id);
          const aUndefined = aValue === void 0;
          const bUndefined = bValue === void 0;
          if (aUndefined && bUndefined) continue;
          if (aUndefined || bUndefined) {
            if (sortUndefined === "first") return aUndefined ? -1 : 1;
            if (sortUndefined === "last") return aUndefined ? 1 : -1;
            sortInt = aUndefined ? sortUndefined : -sortUndefined;
          }
        }
        if (sortInt === 0) sortInt = sortEntry.sortFn(rowA, rowB, sortEntry.id);
        if (sortInt !== 0) {
          if (isDesc) sortInt *= -1;
          if (sortEntry.invertSorting) sortInt *= -1;
          return sortInt;
        }
      }
      return rowA.index - rowB.index;
    };
    const sortData = (rows) => {
      const sortedData = rows.slice();
      sortedData.sort(compareRows);
      let changed = false;
      for (let i = 0; i < sortedData.length; i++) {
        const row = sortedData[i];
        if (row !== rows[i]) changed = true;
        const flatIndex = sortedFlatRows.length;
        sortedFlatRows.push(row);
        if (row.subRows.length) {
          const sortedSubRows = sortData(row.subRows);
          if (sortedSubRows.changed) {
            const cloned = Object.create(Object.getPrototypeOf(row));
            copyInstancePropertiesWithoutMemos(cloned, row);
            cloned.subRows = sortedSubRows.rows;
            sortedData[i] = cloned;
            sortedFlatRows[flatIndex] = cloned;
            changed = true;
          }
        }
      }
      return {
        rows: sortedData,
        changed
      };
    };
    return {
      rows: sortData(preSortedRowModel.rows).rows,
      flatRows: sortedFlatRows,
      rowsById: preSortedRowModel.rowsById
    };
  }

  // node_modules/@tanstack/table-core/dist/store-reactivity-bindings.js
  function storeReactivityBindings() {
    return {
      createOptionsStore: true,
      wrapExternalAtoms: false,
      addSubscription: () => {
        throw new Error("Feature not supported in current reactivity implementation");
      },
      unmount: () => {
        throw new Error("Feature not supported in current reactivity implementation");
      },
      batch,
      schedule: (fn) => queueMicrotask(fn),
      untrack: (fn) => fn(),
      createReadonlyAtom: (fn, options) => {
        return createAtom(() => fn(), { compare: options?.compare });
      },
      createWritableAtom: (value, options) => {
        return createAtom(value, { compare: options?.compare });
      }
    };
  }

  // media/tanstack-table-core-entry.ts
  var webviewFeatures = tableFeatures({
    coreReactivityFeature: storeReactivityBindings(),
    columnFilteringFeature,
    globalFilteringFeature,
    columnGroupingFeature,
    columnOrderingFeature,
    columnPinningFeature,
    columnResizingFeature,
    columnSizingFeature,
    columnVisibilityFeature,
    rowExpandingFeature,
    rowSortingFeature,
    filteredRowModel: createFilteredRowModel(),
    groupedRowModel: createGroupedRowModel(),
    expandedRowModel: createExpandedRowModel(),
    sortedRowModel: createSortedRowModel(),
    sortFns: { alphanumeric: sortFn_alphanumeric }
  });
  function constructTable2(options) {
    const table = constructTable(options);
    return Object.assign(table, { getState: () => table.store.state });
  }
  return __toCommonJS(tanstack_table_core_entry_exports);
})();
//# sourceMappingURL=tanstack-table-core.js.map
