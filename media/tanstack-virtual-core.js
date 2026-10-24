var VirtualCore = (() => {
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

  // node_modules/@tanstack/virtual-core/dist/esm/index.js
  var index_exports = {};
  __export(index_exports, {
    Virtualizer: () => Virtualizer,
    _resetIOSDetectionForTests: () => _resetIOSDetectionForTests,
    approxEqual: () => approxEqual,
    debounce: () => debounce,
    defaultKeyExtractor: () => defaultKeyExtractor,
    defaultRangeExtractor: () => defaultRangeExtractor,
    elementScroll: () => elementScroll,
    measureElement: () => measureElement,
    memo: () => memo,
    notUndefined: () => notUndefined,
    observeElementOffset: () => observeElementOffset,
    observeElementRect: () => observeElementRect,
    observeWindowOffset: () => observeWindowOffset,
    observeWindowRect: () => observeWindowRect,
    windowScroll: () => windowScroll
  });

  // node_modules/@tanstack/virtual-core/dist/esm/lazy-measurements.js
  function getMeasurementKey(item) {
    return typeof item === "object" ? item.key : item;
  }
  function createLazyMeasurementsView(cache, flat) {
    const count = cache.length;
    return new Proxy(cache, {
      get(target, prop, receiver) {
        if (typeof prop === "string") {
          const c = prop.charCodeAt(0);
          if (c >= 48 && c <= 57) {
            const i = +prop;
            if (Number.isInteger(i) && i >= 0 && i < count) {
              let v = target[i];
              if (typeof v !== "object") {
                const s = flat[i * 2];
                v = target[i] = {
                  index: i,
                  key: v,
                  start: s,
                  size: flat[i * 2 + 1],
                  end: s + flat[i * 2 + 1],
                  lane: 0
                };
              }
              return v;
            }
          }
          if (prop === "length") return count;
        }
        return Reflect.get(target, prop, receiver);
      }
    });
  }

  // node_modules/@tanstack/virtual-core/dist/esm/utils.js
  function memo(getDeps, fn, opts) {
    let deps = opts.initialDeps ?? [];
    let result;
    let isInitial = true;
    function memoizedFunction() {
      var _a;
      const debugEnabled = !!opts.key && !!((_a = opts.debug) == null ? void 0 : _a.call(opts));
      let depTime = 0;
      if (debugEnabled) depTime = Date.now();
      const newDeps = getDeps();
      const depsChanged = newDeps.length !== deps.length || newDeps.some((dep, index) => deps[index] !== dep);
      if (!depsChanged) {
        return result;
      }
      deps = newDeps;
      let resultTime = 0;
      if (debugEnabled) resultTime = Date.now();
      result = fn(...newDeps);
      if (debugEnabled) {
        const depEndTime = Math.round((Date.now() - depTime) * 100) / 100;
        const resultEndTime = Math.round((Date.now() - resultTime) * 100) / 100;
        const resultFpsPercentage = resultEndTime / 16;
        const pad = (str, num) => {
          str = String(str);
          while (str.length < num) {
            str = " " + str;
          }
          return str;
        };
        console.info(
          `%c\u23F1 ${pad(resultEndTime, 5)} /${pad(depEndTime, 5)} ms`,
          `
            font-size: .6rem;
            font-weight: bold;
            color: hsl(${Math.max(
            0,
            Math.min(120 - 120 * resultFpsPercentage, 120)
          )}deg 100% 31%);`,
          opts == null ? void 0 : opts.key
        );
      }
      if ((opts == null ? void 0 : opts.onChange) && !(isInitial && opts.skipInitialOnChange)) {
        opts.onChange(result);
      }
      isInitial = false;
      return result;
    }
    memoizedFunction.updateDeps = (newDeps) => {
      deps = newDeps;
    };
    return memoizedFunction;
  }
  function notUndefined(value, msg) {
    if (value === void 0) {
      throw new Error(`Unexpected undefined${msg ? `: ${msg}` : ""}`);
    } else {
      return value;
    }
  }
  var approxEqual = (a, b) => Math.abs(a - b) < 1.01;
  var debounce = (targetWindow, fn, ms) => {
    let timeoutId;
    return Object.assign(
      function(...args) {
        targetWindow.clearTimeout(timeoutId);
        timeoutId = targetWindow.setTimeout(() => fn.apply(this, args), ms);
      },
      {
        // The handle is closure-local, so a caller that has already
        // unsubscribed has no way to stop a queued call. Teardown paths use
        // this to drop the pending invocation instead of letting it land.
        cancel: () => {
          targetWindow.clearTimeout(timeoutId);
        }
      }
    );
  };

  // node_modules/@tanstack/virtual-core/dist/esm/scroll-classifier.js
  function classifyScrollEvent({
    offset,
    isScrolling,
    elementMax,
    holdOffset,
    scrollOffset,
    pendingWrite,
    clampedMaxAtWrite
  }) {
    var _a;
    if (isScrolling && pendingWrite === null && offset === scrollOffset) {
      return "spurious";
    }
    if (pendingWrite !== null && Math.abs(offset - pendingWrite.target) < 1.5) {
      return "readBack";
    }
    if (pendingWrite !== null && !pendingWrite.smooth && elementMax !== null && pendingWrite.target > elementMax + holdOffset + 0.5 && Math.abs(offset - (elementMax + holdOffset)) < 1.5) {
      return "clampedReadBack";
    }
    if (pendingWrite !== null && !pendingWrite.smooth && ((_a = pendingWrite.lowMaxes) == null ? void 0 : _a.some((max) => Math.abs(offset - max) < 1.5))) {
      return "clampedReadBack";
    }
    if (clampedMaxAtWrite !== null && Math.abs(offset - clampedMaxAtWrite) < 1.5) {
      return "clampedEcho";
    }
    return "external";
  }
  var isAnimating = (phase) => phase === "smooth" || phase === "smoothFinishing";
  function externalRetiresCommand({
    kind,
    offset,
    command,
    target
  }) {
    return kind !== "spurious" && kind !== "readBack" && // Our own write, clamped (`clampedReadBack`, #1310): the command is not
    // retired by it, and reconcile retargets below the new max.
    kind !== "clampedReadBack" && (command == null ? void 0 : command.index) != null && // Nothing has been written for a command waiting for the tail; these
    // are the fling's events.
    command.phase !== "queued" && // A non-smooth write lands at once, so any other scroll event is the
    // user's, even before reconcile saw the target reached (the target may
    // keep moving, or iOS ignored the write under a finger). A write the
    // browser clamped because the sizer hasn't grown yet reads back at the
    // max, which is also where the fresh target clamps, so the check below
    // keeps it reconciling (#1294). While a smooth scroll's animation may
    // still report, its events look like a user's, so it yields only once it
    // has landed.
    !isAnimating(command.phase) && !approxEqual(offset, command.lastTargetOffset) && !approxEqual(offset, target()) && // A compensation write's clamped echo (#1258) keeps the command. The
    // order is deliberate, not tidiness: this clause stays after `target()`
    // (and `clampedReadBack` before it) because `target()` can rebuild the
    // measurements, so it must run for exactly the events it always did.
    kind !== "clampedEcho";
  }
  var FLING_WINDOW_MS = 40;
  function flingSpedUp(samples) {
    const last = samples[samples.length - 1];
    if (last === void 0) return false;
    let j = samples.length - 2;
    while (j >= 0 && last.t - samples[j].t < FLING_WINDOW_MS) j--;
    if (j < 0) return false;
    const mid = samples[j];
    let k = j - 1;
    while (k >= 0 && mid.t - samples[k].t < FLING_WINDOW_MS) k--;
    if (k < 0) return false;
    const first = samples[k];
    const recent = (last.offset - mid.offset) / (last.t - mid.t);
    const before = (mid.offset - first.offset) / (mid.t - first.t);
    return recent * before >= 0 && Math.abs(recent) >= 2 * Math.abs(before) && Math.abs(recent) - Math.abs(before) >= 0.8;
  }
  function flingCaught(samples) {
    const last = samples[samples.length - 1];
    if (last === void 0) return false;
    let j = samples.length - 2;
    while (j >= 0 && last.t - samples[j].t < FLING_WINDOW_MS) j--;
    if (j < 0) return false;
    const from = samples[j];
    return Math.abs(last.offset - from.offset) / (last.t - from.t) >= 0.05;
  }

  // node_modules/@tanstack/virtual-core/dist/esm/ios-gesture.js
  var _isIOSResult;
  var isIOSWebKit = () => {
    if (_isIOSResult !== void 0) return _isIOSResult;
    if (typeof navigator === "undefined") return _isIOSResult = false;
    if (/iP(hone|od|ad)/.test(navigator.userAgent)) return _isIOSResult = true;
    const mtp = navigator.maxTouchPoints;
    return _isIOSResult = navigator.platform === "MacIntel" && mtp !== void 0 && mtp > 0;
  };
  var _iosMomentumOverridesWritesResult;
  var iosMomentumOverridesWrites = () => {
    if (_iosMomentumOverridesWritesResult !== void 0) {
      return _iosMomentumOverridesWritesResult;
    }
    return _iosMomentumOverridesWritesResult = isIOSWebKit() && typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("overflow-anchor: auto");
  };
  var _resetIOSDetectionForTests = () => {
    _isIOSResult = void 0;
    _iosMomentumOverridesWritesResult = void 0;
  };
  var touchListenerOptions = {
    capture: true,
    passive: true
  };
  var IosGesture = class {
    constructor(host) {
      this.host = host;
      this._touch = null;
      this.inMotion = () => this._touch !== null && this._touch.phase !== "lateFling";
      this.dragging = () => {
        var _a;
        return ((_a = this._touch) == null ? void 0 : _a.phase) === "down" && this._touch.moved;
      };
      this.tail = () => {
        var _a;
        return ((_a = this._touch) == null ? void 0 : _a.phase) === "tail" ? this._touch.moved ? "fling" : "tap" : null;
      };
      this.onScroll = ({
        isScrolling,
        ownReadBack,
        moved,
        external
      }) => {
        var _a, _b, _c;
        if (isScrolling && ((_a = this._touch) == null ? void 0 : _a.phase) === "tail") {
          this._openTail(this._touch.moved || !ownReadBack, false);
        } else if (((_b = this._touch) == null ? void 0 : _b.phase) === "lateFling") {
          if (this.host.now() > this._touch.until) {
            this._touch = null;
          } else if (external && isScrolling && moved) {
            this._openTail(true, false);
          }
        }
        if (!ownReadBack && isScrolling && moved && ((_c = this._touch) == null ? void 0 : _c.phase) === "down") {
          this._touch.moved = true;
          return true;
        }
        return false;
      };
      this.touchStart = () => {
        this.end();
        this._touch = { phase: "down", moved: false };
      };
      this.touchEnd = () => {
        var _a;
        const moved = ((_a = this._touch) == null ? void 0 : _a.phase) === "down" && this._touch.moved;
        this.end();
        this._openTail(moved, moved);
      };
      this.end = () => {
        var _a;
        const win = this.host.getWindow();
        if (((_a = this._touch) == null ? void 0 : _a.phase) === "tail" && win != null) {
          win.clearTimeout(this._touch.timerId);
        }
        this._touch = null;
      };
      this.listen = (target) => {
        const onTouchStart = () => this.touchStart();
        const onTouchEnd = () => this.touchEnd();
        target.addEventListener("touchstart", onTouchStart, touchListenerOptions);
        target.addEventListener("touchend", onTouchEnd, touchListenerOptions);
        target.addEventListener("touchcancel", onTouchEnd, touchListenerOptions);
        return () => {
          target.removeEventListener(
            "touchstart",
            onTouchStart,
            touchListenerOptions
          );
          target.removeEventListener("touchend", onTouchEnd, touchListenerOptions);
          target.removeEventListener(
            "touchcancel",
            onTouchEnd,
            touchListenerOptions
          );
          this.end();
        };
      };
      this._openTail = (moved, awaitingFling) => {
        const win = this.host.getWindow();
        if (!isIOSWebKit() || win == null) return;
        this.end();
        const tail = {
          phase: "tail",
          moved,
          awaitingFling,
          // Only fires while this tail is current: `end` clears it otherwise.
          timerId: win.setTimeout(() => {
            if (this.host.tailStillMoving()) {
              this._openTail(tail.moved, tail.awaitingFling);
              return;
            }
            this._touch = tail.awaitingFling ? { phase: "lateFling", until: this.host.now() + 1e3 } : null;
            this.host.onTailClosed();
          }, 150)
        };
        this._touch = tail;
      };
    }
    get touch() {
      return this._touch;
    }
  };

  // node_modules/@tanstack/virtual-core/dist/esm/index.js
  var getRect = (element) => {
    const { clientWidth, clientHeight } = element;
    return { width: clientWidth, height: clientHeight };
  };
  var createFrameQueue = (targetWindow) => {
    const ids = /* @__PURE__ */ new Set();
    return {
      schedule: (fn) => {
        const id = targetWindow.requestAnimationFrame(() => {
          ids.delete(id);
          fn();
        });
        ids.add(id);
      },
      cancel: () => {
        ids.forEach((id) => targetWindow.cancelAnimationFrame(id));
        ids.clear();
      }
    };
  };
  var defaultKeyExtractor = (index) => index;
  var defaultRangeExtractor = (range) => {
    const overscan = range.overscan * Math.max(range.lanes ?? 1, 1);
    const start = Math.max(range.startIndex - overscan, 0);
    const end = Math.min(range.endIndex + overscan, range.count - 1);
    const len = end - start + 1;
    const arr = new Array(len);
    for (let i = 0; i < len; i++) {
      arr[i] = start + i;
    }
    return arr;
  };
  var observeElementRect = (instance, cb) => {
    const element = instance.scrollElement;
    if (!element) {
      return;
    }
    const targetWindow = instance.targetWindow;
    if (!targetWindow) {
      return;
    }
    const handler = (rect) => {
      const { width, height } = rect;
      cb({ width: Math.round(width), height: Math.round(height) });
    };
    handler(getRect(element));
    if (!targetWindow.ResizeObserver) {
      return () => {
      };
    }
    const frames = createFrameQueue(targetWindow);
    const observer = new targetWindow.ResizeObserver(() => {
      const run = () => {
        handler(getRect(element));
      };
      instance.options.useAnimationFrameWithResizeObserver ? frames.schedule(run) : run();
    });
    observer.observe(element, { box: "content-box" });
    return () => {
      observer.unobserve(element);
      frames.cancel();
    };
  };
  var addEventListenerOptions = {
    passive: true
  };
  var observeWindowRect = (instance, cb) => {
    const element = instance.scrollElement;
    if (!element) {
      return;
    }
    const handler = () => {
      cb({ width: element.innerWidth, height: element.innerHeight });
    };
    handler();
    element.addEventListener("resize", handler, addEventListenerOptions);
    return () => {
      element.removeEventListener("resize", handler);
    };
  };
  var supportsScrollend = typeof window == "undefined" ? true : "onscrollend" in window;
  var observeOffset = (instance, cb, readOffset) => {
    const element = instance.scrollElement;
    if (!element) {
      return;
    }
    const targetWindow = instance.targetWindow;
    if (!targetWindow) {
      return;
    }
    const registerScrollendEvent = instance.options.useScrollendEvent && supportsScrollend;
    let offset = 0;
    const fallback = registerScrollendEvent ? null : debounce(
      targetWindow,
      () => cb(readOffset(element), false),
      instance.options.isScrollingResetDelay
    );
    const createHandler = (isScrolling) => () => {
      offset = readOffset(element);
      fallback == null ? void 0 : fallback();
      cb(offset, isScrolling);
    };
    const handler = createHandler(true);
    const endHandler = createHandler(false);
    element.addEventListener("scroll", handler, addEventListenerOptions);
    if (registerScrollendEvent) {
      element.addEventListener("scrollend", endHandler, addEventListenerOptions);
    }
    return () => {
      element.removeEventListener("scroll", handler);
      if (registerScrollendEvent) {
        element.removeEventListener("scrollend", endHandler);
      }
      fallback == null ? void 0 : fallback.cancel();
    };
  };
  var observeElementOffset = (instance, cb) => observeOffset(instance, cb, (el) => {
    const { horizontal, isRtl } = instance.options;
    return horizontal ? el.scrollLeft * (isRtl && -1 || 1) : el.scrollTop;
  });
  var observeWindowOffset = (instance, cb) => observeOffset(
    instance,
    cb,
    (win) => instance.options.horizontal ? win.scrollX : win.scrollY
  );
  var measureElement = (element, entry, instance) => {
    if (instance.options.useCachedMeasurements) {
      const index = instance.indexFromElement(element);
      const key = instance.options.getItemKey(index);
      return instance.itemSizeCache.get(key) ?? instance.options.estimateSize(index);
    }
    if (entry == null ? void 0 : entry.borderBoxSize) {
      const box = entry.borderBoxSize[0];
      if (box) {
        const size = Math.round(
          box[instance.options.horizontal ? "inlineSize" : "blockSize"]
        );
        return size;
      }
    }
    if (!entry) {
      const index = instance.indexFromElement(element);
      const key = instance.options.getItemKey(index);
      const cachedSize = instance.itemSizeCache.get(key);
      if (cachedSize !== void 0) {
        return cachedSize;
      }
    }
    return element[instance.options.horizontal ? "offsetWidth" : "offsetHeight"];
  };
  var scrollWithAdjustments = (offset, {
    adjustments = 0,
    behavior
  }, instance) => {
    var _a, _b;
    (_b = (_a = instance.scrollElement) == null ? void 0 : _a.scrollTo) == null ? void 0 : _b.call(_a, {
      [instance.options.horizontal ? "left" : "top"]: offset + adjustments,
      behavior
    });
  };
  var windowScroll = scrollWithAdjustments;
  var elementScroll = scrollWithAdjustments;
  var initialScrollPhase = (behavior, atTarget) => behavior === "smooth" ? atTarget ? "smoothLanded" : "smooth" : "instant";
  var isSmoothScroll = (state) => (state == null ? void 0 : state.phase) === "smooth" || (state == null ? void 0 : state.phase) === "smoothLanded";
  function isAppendWithTrim(prevCount, nextCount, getPreviousKey, getNextKey) {
    if (nextCount === 0) return false;
    const firstKey = getNextKey(0);
    const removedKeys = /* @__PURE__ */ new Set();
    let removedCount = 0;
    while (removedCount < prevCount) {
      const key = getPreviousKey(removedCount);
      if (key === firstKey) break;
      removedKeys.add(key);
      removedCount++;
    }
    const retainedCount = prevCount - removedCount;
    if (retainedCount === 0 || retainedCount >= nextCount) return false;
    for (let i = 0; i < retainedCount; i++) {
      if (getNextKey(i) !== getPreviousKey(removedCount + i)) return false;
    }
    for (let i = retainedCount; i < nextCount; i++) {
      if (removedKeys.has(getNextKey(i))) return false;
    }
    return true;
  }
  var Virtualizer = class {
    constructor(opts) {
      this.unsubs = [];
      this.scrollElement = null;
      this.targetWindow = null;
      this.isScrolling = false;
      this.scrollState = null;
      this.measurementsCache = [];
      this._singleLaneMeasurements = null;
      this.itemSizeCache = /* @__PURE__ */ new Map();
      this.itemSizeCacheVersion = 0;
      this.laneAssignments = /* @__PURE__ */ new Map();
      this.pendingMin = null;
      this.prevLanes = void 0;
      this.lanesChangedFlag = false;
      this.lanesSettling = false;
      this.pendingScrollAnchor = null;
      this.scrollRect = null;
      this.scrollOffset = null;
      this.scrollDirection = null;
      this._holdOffset = 0;
      this._reportedOverscroll = false;
      this._iosGesture = new IosGesture({
        getWindow: () => this.targetWindow,
        now: () => this.now(),
        // The end of a fling can move less than a pixel per scroll event, so
        // events can stop for 150ms while the fling is still running (seen on
        // an iPhone, 27.0.1). A command waiting for it would then be written
        // into the fling and overridden. The element having moved since the
        // last event means it has not ended: wait again. Not while our own
        // write has yet to report: that moved it.
        tailStillMoving: () => {
          const state = this.scrollState;
          if ((state == null ? void 0 : state.phase) !== "queued" || this.pendingWrite !== null) {
            return false;
          }
          const now = this._readElementOffset();
          if (now === null || this._lastElementOffset === null || Math.abs(now - this._lastElementOffset) < 1) {
            return false;
          }
          this._lastElementOffset = now;
          state.samples = [...state.samples ?? [], { t: this.now(), offset: now }];
          return true;
        },
        onTailClosed: () => {
          const state = this.scrollState;
          if ((state == null ? void 0 : state.phase) === "queued" && flingCaught(state.samples ?? [])) {
            this.scrollState = null;
          }
          this._flushHoldIfReady(true);
          this._writeAwaitingCommand();
          this._retryClampedAdjustment();
        }
      });
      this._lastElementOffset = null;
      this.pendingWrite = null;
      this._clampedAdjustment = null;
      this.elementsCache = /* @__PURE__ */ new Map();
      this._resizeBatch = null;
      this.now = () => {
        var _a, _b, _c;
        return ((_c = (_b = (_a = this.targetWindow) == null ? void 0 : _a.performance) == null ? void 0 : _b.now) == null ? void 0 : _c.call(_b)) ?? Date.now();
      };
      this.observer = /* @__PURE__ */ (() => {
        let _ro = null;
        let _frames = null;
        const get = () => {
          if (_ro) {
            return _ro;
          }
          const targetWindow = this.targetWindow;
          if (!targetWindow || !targetWindow.ResizeObserver) {
            return null;
          }
          const frames = _frames = createFrameQueue(targetWindow);
          return _ro = new targetWindow.ResizeObserver((entries) => {
            const run = () => {
              const batch = { sync: false };
              this._resizeBatch = batch;
              try {
                entries.forEach(measureEntry);
              } finally {
                this._resizeBatch = null;
                if (batch.notify) {
                  this.notify(batch.sync);
                  this._noteClampMax();
                  this._flushHoldIfReady(true);
                  this._retryClampedAdjustment();
                }
              }
            };
            this.options.useAnimationFrameWithResizeObserver ? frames.schedule(run) : run();
          });
        };
        const measureEntry = (entry) => {
          const node = entry.target;
          const index = this.indexFromElement(node);
          if (!node.isConnected) {
            this.observer.unobserve(node);
            for (const [cacheKey, cachedNode] of this.elementsCache) {
              if (cachedNode === node) {
                this.elementsCache.delete(cacheKey);
                break;
              }
            }
            return;
          }
          if (!this.isIndexInRange(index)) return;
          if (this.shouldMeasureDuringScroll(index)) {
            this.resizeItem(index, this.options.measureElement(node, entry, this));
          }
        };
        return {
          disconnect: () => {
            var _a;
            (_a = get()) == null ? void 0 : _a.disconnect();
            _frames == null ? void 0 : _frames.cancel();
            _ro = null;
            _frames = null;
          },
          observe: (target) => {
            var _a;
            return (_a = get()) == null ? void 0 : _a.observe(target, { box: "border-box" });
          },
          unobserve: (target) => {
            var _a;
            return (_a = get()) == null ? void 0 : _a.unobserve(target);
          }
        };
      })();
      this.range = null;
      this.setOptions = (opts2) => {
        var _a;
        const merged = {
          debug: false,
          initialOffset: 0,
          overscan: 1,
          paddingStart: 0,
          paddingEnd: 0,
          scrollPaddingStart: 0,
          scrollPaddingEnd: 0,
          horizontal: false,
          getItemKey: defaultKeyExtractor,
          rangeExtractor: defaultRangeExtractor,
          onChange: () => {
          },
          measureElement,
          initialRect: { width: 0, height: 0 },
          scrollMargin: 0,
          gap: 0,
          indexAttribute: "data-index",
          initialMeasurementsCache: [],
          lanes: 1,
          anchorTo: "start",
          followOnAppend: false,
          scrollEndThreshold: 1,
          isScrollingResetDelay: 150,
          enabled: true,
          isRtl: false,
          useScrollendEvent: false,
          useAnimationFrameWithResizeObserver: false,
          laneAssignmentMode: "estimate",
          useCachedMeasurements: false
        };
        for (const key in opts2) {
          const v = opts2[key];
          if (v !== void 0) merged[key] = v;
        }
        const prevOptions = this.options;
        let anchor = null;
        let followOnAppend = null;
        let edgeKeysChanged = false;
        if (prevOptions !== void 0 && prevOptions.enabled && merged.enabled && merged.anchorTo === "end" && this.scrollElement !== null) {
          const prevCount = prevOptions.count;
          const nextCount = merged.count;
          const measurements = this.getMeasurements();
          const previousItems = ((_a = this._singleLaneMeasurements) == null ? void 0 : _a.items) ?? measurements;
          const getPreviousKey = (index) => getMeasurementKey(previousItems[index]);
          const prevFirstKey = prevCount > 0 ? getPreviousKey(0) : null;
          const prevLastKey = prevCount > 0 ? getPreviousKey(prevCount - 1) : null;
          const didCountChange = nextCount !== prevCount;
          const didEdgeKeysChange = didCountChange || prevCount > 0 && nextCount > 0 && (merged.getItemKey(0) !== prevFirstKey || merged.getItemKey(nextCount - 1) !== prevLastKey);
          if (didEdgeKeysChange) {
            edgeKeysChanged = true;
            const item = prevCount > 0 ? this.getVirtualItemForOffset(this.getScrollOffset()) ?? measurements[0] : null;
            if (item) {
              anchor = [item.key, this.getScrollOffset() - item.start];
            }
            const behavior = merged.followOnAppend === true ? "auto" : merged.followOnAppend || null;
            if (behavior && nextCount > 0 && this.isAtEnd(prevOptions.scrollEndThreshold) && (prevCount === 0 || merged.getItemKey(nextCount - 1) !== prevLastKey)) {
              if (nextCount > prevCount || isAppendWithTrim(
                prevCount,
                nextCount,
                getPreviousKey,
                merged.getItemKey
              )) {
                followOnAppend = behavior;
              }
            }
          }
        }
        this.options = merged;
        if (edgeKeysChanged) {
          this.pendingMin = 0;
          this.itemSizeCacheVersion++;
        }
        let anchorDelta = null;
        if (anchor && this.scrollOffset !== null && !this._awaitingCommandReadBack()) {
          const [anchorKey, anchorOffset] = anchor;
          const newMeasurements = this.getMeasurements();
          const { count, getItemKey } = this.options;
          let idx = 0;
          while (idx < count && getItemKey(idx) !== anchorKey) {
            idx++;
          }
          if (idx < count) {
            const anchorItem = newMeasurements[idx];
            if (anchorItem) {
              const newOffset = Math.max(0, anchorItem.start + anchorOffset);
              if (!followOnAppend && newOffset !== this.scrollOffset) {
                anchorDelta = newOffset - this.scrollOffset;
                this.scrollOffset = newOffset;
              }
            }
          }
        }
        if (followOnAppend) {
          this.pendingScrollAnchor = { kind: "follow", behavior: followOnAppend };
        } else if (anchorDelta !== null) {
          if (this._canWriteScroll()) {
            this.pendingScrollAnchor = { kind: "anchor", delta: anchorDelta };
          } else {
            this._holdOffset += anchorDelta;
            this._followOffsetTarget(anchorDelta);
          }
        }
      };
      this.notify = (sync) => {
        var _a, _b;
        (_b = (_a = this.options).onChange) == null ? void 0 : _b.call(_a, this, sync);
      };
      this.maybeNotify = memo(
        () => {
          this.calculateRange();
          return [
            this.isScrolling,
            this.range ? this.range.startIndex : null,
            this.range ? this.range.endIndex : null
          ];
        },
        (isScrolling) => {
          this.notify(isScrolling);
        },
        {
          key: "maybeNotify",
          debug: () => this.options.debug,
          initialDeps: [
            this.isScrolling,
            this.range ? this.range.startIndex : null,
            this.range ? this.range.endIndex : null
          ]
        }
      );
      this.cleanup = () => {
        var _a;
        this.unsubs.filter(Boolean).forEach((d) => d());
        this.unsubs = [];
        this.observer.disconnect();
        if (this.rafId != null && this.targetWindow) {
          this.targetWindow.cancelAnimationFrame(this.rafId);
          this.rafId = null;
        }
        this.scrollState = null;
        (_a = this._momentumStop) == null ? void 0 : _a.restore();
        this._momentumStop = null;
        this.isScrolling = false;
        this.scrollDirection = null;
        this._holdOffset = 0;
        this._reportedOverscroll = false;
        this._clampedAdjustment = null;
        this.pendingWrite = null;
        this.scrollElement = null;
        this.targetWindow = null;
      };
      this._didMount = () => {
        return () => {
          this.cleanup();
        };
      };
      this._willUpdate = () => {
        var _a;
        const scrollElement = this.options.enabled ? this.options.getScrollElement() : null;
        if (this.scrollElement !== scrollElement) {
          this.cleanup();
          if (!scrollElement) {
            this.maybeNotify();
            return;
          }
          this.scrollElement = scrollElement;
          if (this.scrollElement && "ownerDocument" in this.scrollElement) {
            this.targetWindow = this.scrollElement.ownerDocument.defaultView;
          } else {
            this.targetWindow = ((_a = this.scrollElement) == null ? void 0 : _a.window) ?? null;
          }
          this.elementsCache.forEach((cached) => {
            this.observer.observe(cached);
          });
          this.unsubs.push(
            this.options.observeElementRect(this, (rect) => {
              this.scrollRect = rect;
              this.maybeNotify();
            })
          );
          this.unsubs.push(
            this.options.observeElementOffset(this, (offset, isScrolling) => {
              var _a2, _b, _c, _d;
              const elementMax = isScrolling ? this._elementMaxScrollOffset() : null;
              const wasOverscrolled = this._reportedOverscroll;
              this._reportedOverscroll = offset < 0 || elementMax !== null && offset > elementMax + 1;
              const elementOffset = offset;
              this._lastElementOffset = elementOffset;
              offset = this._toLayoutOffset(offset);
              const kind = this._classifyScrollEvent(
                offset,
                isScrolling,
                elementMax
              );
              if (kind === "spurious") return;
              if (kind === "readBack") {
                offset = this.pendingWrite.target;
              } else if (kind === "clampedReadBack" && ((_a2 = this.scrollState) == null ? void 0 : _a2.index) != null && // Not `elementMax`: an adapter can report the read-back at rest.
              offset < this.getMaxScrollOffset() - 1.5) {
                this.scrollState.lastTargetOffset = offset;
              } else if (externalRetiresCommand({
                kind,
                offset,
                command: this.scrollState,
                target: () => this.getScrollStateTarget(this.scrollState)
              })) {
                this.scrollState = null;
              }
              this.pendingWrite = null;
              if (this._clampedAdjustment !== null && Math.abs(offset - this._clampedAdjustment.maxAtWrite) >= 1.5) {
                this._clampedAdjustment = null;
              }
              const prevOffset = this.getScrollOffset();
              const prevDirection = this.scrollDirection;
              this.scrollDirection = isScrolling ? prevOffset === offset ? this.scrollDirection : prevOffset < offset ? "forward" : "backward" : null;
              this.scrollOffset = offset;
              this.isScrolling = isScrolling;
              const queued = this.scrollState;
              if ((queued == null ? void 0 : queued.phase) === "queued" && kind === "external" && isScrolling) {
                if (wasOverscrolled || this._reportedOverscroll) {
                  queued.samples = [];
                } else {
                  const t = this.now();
                  queued.samples = [
                    ...(queued.samples ?? []).filter(
                      (sample) => t - sample.t <= 200
                    ),
                    { t, offset: elementOffset }
                  ];
                  if (prevDirection !== null && this.scrollDirection !== prevDirection || flingSpedUp(queued.samples)) {
                    this.scrollState = null;
                  }
                }
              }
              if (this._iosGesture.onScroll({
                isScrolling,
                ownReadBack: kind === "readBack",
                moved: offset !== prevOffset,
                // Neither our write's read-back nor a frame of our smooth
                // animation: the user or a fling moved it.
                external: kind === "external" && ((_b = this.scrollState) == null ? void 0 : _b.phase) !== "smooth" && ((_c = this.scrollState) == null ? void 0 : _c.phase) !== "smoothFinishing"
              }) && // The user scrolls: a command still waiting for the tail is
              // theirs to override, like a written one would be.
              ((_d = this.scrollState) == null ? void 0 : _d.phase) === "queued") {
                this.scrollState = null;
              }
              this._flushHoldIfReady(true);
              if (this.scrollState) {
                this.scheduleScrollReconcile();
              }
              this.maybeNotify();
            })
          );
          if ("addEventListener" in this.scrollElement) {
            this.unsubs.push(
              this._iosGesture.listen(this.scrollElement)
            );
          }
          this._scrollToOffset(this.getScrollOffset());
        }
        this._noteClampMax();
        const anchor = this.pendingScrollAnchor;
        this.pendingScrollAnchor = null;
        if (anchor && this.scrollElement && this.options.enabled) {
          if (anchor.kind === "anchor") {
            if (!this._canWriteScroll()) {
              this._holdOffset += anchor.delta;
              this._followOffsetTarget(anchor.delta);
              this.notify(false);
            } else if (isSmoothScroll(this.scrollState) && !approxEqual(
              this.getScrollOffset() - anchor.delta,
              this.scrollState.lastTargetOffset
            )) ;
            else {
              this._followOffsetTarget(anchor.delta);
              this._scrollToOffset(this.getScrollOffset());
            }
          } else {
            this.scrollToEnd({ behavior: anchor.behavior });
          }
        }
        this._flushHoldIfReady(false);
        this._retryClampedAdjustment();
      };
      this._classifyScrollEvent = (offset, isScrolling, elementMax) => {
        var _a;
        return classifyScrollEvent({
          offset,
          isScrolling,
          elementMax,
          holdOffset: this._holdOffset,
          scrollOffset: this.scrollOffset,
          pendingWrite: this.pendingWrite,
          clampedMaxAtWrite: ((_a = this._clampedAdjustment) == null ? void 0 : _a.maxAtWrite) ?? null
        });
      };
      this._retryClampedAdjustment = () => {
        if (this._clampedAdjustment === null || !this.scrollElement || !this.options.enabled || !this._canWriteScroll()) {
          return;
        }
        const { target, maxAtWrite } = this._clampedAdjustment;
        const max = this.getMaxScrollOffset();
        if (max > maxAtWrite + 0.5) {
          this._clampedAdjustment = target > max + 0.5 ? { target, maxAtWrite: max } : null;
          this._scrollToOffset(target);
        }
      };
      this._writeAwaitingCommand = () => {
        const state = this.scrollState;
        if (state === null || state.phase !== "queued") return;
        const { behavior } = state;
        this.getMeasurements();
        const offset = this.getScrollStateTarget(state);
        state.lastTargetOffset = offset;
        this._clampedAdjustment = null;
        state.phase = initialScrollPhase(
          behavior,
          state.index != null && approxEqual(offset, this.getScrollOffset())
        );
        this._scrollToOffset(offset, { behavior });
        this.scheduleScrollReconcile();
      };
      this._readElementOffset = () => {
        const el = this.scrollElement;
        if (el == null) return null;
        const { horizontal, isRtl } = this.options;
        if (typeof el.scrollTop === "number") {
          return horizontal ? el.scrollLeft * (isRtl && -1 || 1) : el.scrollTop;
        }
        if (typeof el.scrollY === "number") {
          return horizontal ? el.scrollX : el.scrollY;
        }
        return null;
      };
      this._canWriteScroll = () => !(isIOSWebKit() && this._iosGesture.inMotion()) && !this._reportedOverscroll;
      this._flushHoldIfReady = (sync) => {
        var _a;
        if (this._holdOffset === 0) return;
        if (!this.scrollElement || !this.options.enabled) return;
        if (!this._canWriteScroll()) return;
        if (((_a = this.scrollState) == null ? void 0 : _a.phase) === "smooth") return;
        this._holdOffset = 0;
        if (this.scrollOffset !== null && this.scrollOffset < 0) {
          this.scrollOffset = 0;
        }
        this.notify(sync);
        const target = this.getCommandWrittenOffset() ?? this.getScrollOffset();
        this._clampedAdjustment = this._clampedBy(target);
        this._scrollToOffset(target);
      };
      this.rafId = null;
      this.getSize = () => {
        if (!this.options.enabled) {
          this.scrollRect = null;
          return 0;
        }
        this.scrollRect = this.scrollRect ?? this.options.initialRect;
        return this.scrollRect[this.options.horizontal ? "width" : "height"];
      };
      this.getScrollOffset = () => {
        if (!this.options.enabled) {
          this.scrollOffset = null;
          return 0;
        }
        this.scrollOffset = this.scrollOffset ?? (typeof this.options.initialOffset === "function" ? this.options.initialOffset() : this.options.initialOffset);
        return this.scrollOffset;
      };
      this.getMeasurementOptions = memo(
        () => [
          this.options.count,
          this.options.paddingStart,
          this.options.scrollMargin,
          this.options.getItemKey,
          this.options.enabled,
          this.options.lanes,
          this.options.laneAssignmentMode,
          this.options.gap
        ],
        (count, paddingStart, scrollMargin, getItemKey, enabled, lanes, laneAssignmentMode, gap) => {
          const lanesChanged = this.prevLanes !== void 0 && this.prevLanes !== lanes;
          if (lanesChanged) {
            this.lanesChangedFlag = true;
          }
          this.prevLanes = lanes;
          this.pendingMin = null;
          return {
            count,
            paddingStart,
            scrollMargin,
            getItemKey,
            enabled,
            lanes,
            laneAssignmentMode,
            gap
          };
        },
        {
          key: false
        }
      );
      this.isIndexInRange = (index) => index >= 0 && index < this.options.count;
      this.getMeasurements = memo(
        () => [this.getMeasurementOptions(), this.itemSizeCacheVersion],
        ({
          count,
          paddingStart,
          scrollMargin,
          getItemKey,
          enabled,
          lanes,
          laneAssignmentMode,
          gap
        }, _itemSizeCacheVersion) => {
          var _a;
          const itemSizeCache = this.itemSizeCache;
          if (!enabled) {
            this.measurementsCache = [];
            this._singleLaneMeasurements = null;
            this.itemSizeCache.clear();
            this.laneAssignments.clear();
            return [];
          }
          if (this.laneAssignments.size > count) {
            for (const index of this.laneAssignments.keys()) {
              if (index >= count) {
                this.laneAssignments.delete(index);
              }
            }
          }
          if (this.lanesChangedFlag) {
            this.lanesChangedFlag = false;
            this.lanesSettling = true;
            this.measurementsCache = [];
            this._singleLaneMeasurements = null;
            this.itemSizeCache.clear();
            this.laneAssignments.clear();
            this.pendingMin = null;
          }
          if (this.measurementsCache.length === 0 && !this.lanesSettling) {
            this.measurementsCache = this.options.initialMeasurementsCache;
            this.measurementsCache.forEach((item) => {
              this.itemSizeCache.set(item.key, item.size);
            });
          }
          const min = this.lanesSettling ? 0 : this.pendingMin ?? 0;
          this.pendingMin = null;
          if (this.lanesSettling && this.measurementsCache.length === count) {
            this.lanesSettling = false;
          }
          if (lanes === 1) {
            const need = count * 2;
            let flat = (_a = this._singleLaneMeasurements) == null ? void 0 : _a.flat;
            if (!flat || flat.length < need) {
              const next = new Float64Array(need);
              if (flat && min > 0) next.set(flat.subarray(0, min * 2));
              flat = next;
            }
            const items = min === 0 ? new Array(count) : this._singleLaneMeasurements.items.slice();
            let runningStart;
            if (min === 0) {
              runningStart = paddingStart + scrollMargin;
            } else {
              const prevIdx = min - 1;
              runningStart = flat[prevIdx * 2] + flat[prevIdx * 2 + 1] + gap;
            }
            for (let i = min; i < count; i++) {
              const key = getItemKey(i);
              items[i] = key;
              const measuredSize = itemSizeCache.get(key);
              const size = typeof measuredSize === "number" ? measuredSize : this.options.estimateSize(i);
              flat[i * 2] = runningStart;
              flat[i * 2 + 1] = size;
              runningStart += size + gap;
            }
            this._singleLaneMeasurements = { flat, items };
            const view = createLazyMeasurementsView(items, flat);
            this.measurementsCache = view;
            return view;
          }
          const measurements = this.measurementsCache.slice(0, min);
          const laneLastIndex = new Array(lanes).fill(
            void 0
          );
          const laneEnds = new Float64Array(lanes);
          let filledLanes = 0;
          for (let m = 0; m < min; m++) {
            const item = measurements[m];
            if (item) {
              if (laneLastIndex[item.lane] === void 0) filledLanes++;
              laneLastIndex[item.lane] = m;
              laneEnds[item.lane] = item.end;
            }
          }
          for (let i = min; i < count; i++) {
            const key = getItemKey(i);
            const cachedLane = this.laneAssignments.get(i);
            let lane;
            let start;
            const shouldCacheLane = laneAssignmentMode === "estimate" || itemSizeCache.has(key);
            if (cachedLane !== void 0 && this.options.lanes > 1) {
              lane = cachedLane;
              const prevIndex = laneLastIndex[lane];
              const prevInLane = prevIndex !== void 0 ? measurements[prevIndex] : void 0;
              start = prevInLane ? prevInLane.end + gap : paddingStart + scrollMargin;
            } else if (filledLanes === lanes) {
              let bestLane = 0;
              let bestEnd = laneEnds[0];
              let bestIdx = laneLastIndex[0];
              for (let l = 1; l < lanes; l++) {
                const e = laneEnds[l];
                if (e < bestEnd || e === bestEnd && laneLastIndex[l] < bestIdx) {
                  bestLane = l;
                  bestEnd = e;
                  bestIdx = laneLastIndex[l];
                }
              }
              lane = bestLane;
              start = bestEnd + gap;
              if (shouldCacheLane) {
                this.laneAssignments.set(i, lane);
              }
            } else {
              lane = i % this.options.lanes;
              start = paddingStart + scrollMargin;
              if (shouldCacheLane) {
                this.laneAssignments.set(i, lane);
              }
            }
            const measuredSize = itemSizeCache.get(key);
            const size = typeof measuredSize === "number" ? measuredSize : this.options.estimateSize(i);
            const end = start + size;
            measurements[i] = {
              index: i,
              start,
              size,
              end,
              key,
              lane
            };
            if (laneLastIndex[lane] === void 0) filledLanes++;
            laneLastIndex[lane] = i;
            laneEnds[lane] = end;
          }
          this.measurementsCache = measurements;
          return measurements;
        },
        {
          key: "getMeasurements",
          debug: () => this.options.debug
        }
      );
      this.calculateRange = memo(
        () => [
          this.getMeasurements(),
          this.getSize(),
          this.getScrollOffset(),
          this.options.lanes
        ],
        (measurements, outerSize, scrollOffset, lanes) => {
          if (measurements.length === 0 || outerSize === 0) {
            this.range = null;
            return null;
          }
          this.range = calculateRangeImpl(
            measurements,
            outerSize,
            scrollOffset,
            lanes,
            // Pass the typed array so binary search + forward-walk can read
            // start/end directly from Float64Array, skipping the Proxy traps.
            lanes === 1 && this._singleLaneMeasurements !== null ? this._singleLaneMeasurements.flat : null
          );
          return this.range;
        },
        {
          key: "calculateRange",
          debug: () => this.options.debug
        }
      );
      this.getVirtualIndexes = memo(
        () => {
          let startIndex = null;
          let endIndex = null;
          const range = this.calculateRange();
          if (range) {
            startIndex = range.startIndex;
            endIndex = range.endIndex;
          }
          this.maybeNotify.updateDeps([this.isScrolling, startIndex, endIndex]);
          return [
            this.options.rangeExtractor,
            this.options.overscan,
            this.options.count,
            startIndex,
            endIndex,
            this.options.lanes
          ];
        },
        (rangeExtractor, overscan, count, startIndex, endIndex, lanes) => {
          return startIndex === null || endIndex === null ? [] : rangeExtractor({
            startIndex,
            endIndex,
            overscan,
            count,
            lanes
          });
        },
        {
          key: "getVirtualIndexes",
          debug: () => this.options.debug
        }
      );
      this.indexFromElement = (node) => {
        const attributeName = this.options.indexAttribute;
        const indexStr = node.getAttribute(attributeName);
        if (!indexStr) {
          console.warn(
            `Missing attribute name '${attributeName}={index}' on measured element.`
          );
          return -1;
        }
        return parseInt(indexStr, 10);
      };
      this.shouldMeasureDuringScroll = (index) => {
        var _a;
        if (!isSmoothScroll(this.scrollState)) {
          return true;
        }
        const scrollIndex = this.scrollState.index ?? ((_a = this.getVirtualItemForOffset(this.scrollState.lastTargetOffset)) == null ? void 0 : _a.index);
        if (scrollIndex !== void 0 && this.range) {
          const bufferSize = Math.max(
            this.options.overscan,
            Math.ceil((this.range.endIndex - this.range.startIndex) / 2)
          );
          const minIndex = Math.max(0, scrollIndex - bufferSize);
          const maxIndex = Math.min(
            this.options.count - 1,
            scrollIndex + bufferSize
          );
          return index >= minIndex && index <= maxIndex;
        }
        return true;
      };
      this.measureElement = (node) => {
        if (!node) {
          this.elementsCache.forEach((cached, key2) => {
            if (!cached.isConnected) {
              this.observer.unobserve(cached);
              this.elementsCache.delete(key2);
            }
          });
          return;
        }
        const index = this.indexFromElement(node);
        if (!this.isIndexInRange(index)) return;
        const key = this.options.getItemKey(index);
        const prevNode = this.elementsCache.get(key);
        if (prevNode !== node) {
          if (prevNode) {
            this.observer.unobserve(prevNode);
          }
          this.observer.observe(node);
          this.elementsCache.set(key, node);
        }
        if (node.isConnected && (!this.isScrolling || this.scrollState) && this.shouldMeasureDuringScroll(index)) {
          this.resizeItem(index, this.options.measureElement(node, void 0, this));
        }
      };
      this.resizeItem = (index, size) => {
        var _a, _b, _c;
        if (!this.isIndexInRange(index)) return;
        if ((_a = this._resizeBatch) == null ? void 0 : _a.sync) this.getMeasurements();
        let cachedSize;
        let itemStart;
        let key;
        const flat = (_b = this._singleLaneMeasurements) == null ? void 0 : _b.flat;
        if (this.options.lanes === 1 && flat != null) {
          key = this.options.getItemKey(index);
          itemStart = flat[index * 2];
          cachedSize = flat[index * 2 + 1];
        } else {
          const item = this.measurementsCache[index];
          if (!item) return;
          key = item.key;
          itemStart = item.start;
          cachedSize = item.size;
        }
        const itemSize = this.itemSizeCache.get(key) ?? cachedSize;
        const delta = size - itemSize;
        if (delta !== 0) {
          const wasAtEnd = this.options.anchorTo === "end" && !isSmoothScroll(this.scrollState) && this.getVirtualDistanceFromEnd() <= this.options.scrollEndThreshold;
          const prevTotalSize = wasAtEnd ? this._getLayoutTotalSize() : 0;
          const scrollOffset = this.getScrollOffset();
          const isFirstMeasure = !this.itemSizeCache.has(key);
          const defaultShouldAdjust = isFirstMeasure ? (
            // First measurement: compensate any item whose top sits above the
            // fold — the estimate→actual delta must be corrected regardless of
            // scroll direction, since the whole estimated block was above it.
            itemStart < scrollOffset
          ) : (
            // Re-measurement: only compensate an item that is ENTIRELY above the
            // fold. An item that merely *spans* the fold (top above, bottom
            // below — e.g. a streaming chat message growing at its bottom)
            // changes size *below* the anchor point, so shifting scrollTop by the
            // delta would drag the viewport downward on every growth (#1218).
            // Also skip during backward scroll to avoid the "items jump while
            // scrolling up" cascade.
            itemStart + itemSize <= scrollOffset && this.scrollDirection !== "backward"
          );
          const shouldAdjustScroll = !isSmoothScroll(this.scrollState) && (this.shouldAdjustScrollPositionOnItemSizeChange !== void 0 ? this.shouldAdjustScrollPositionOnItemSizeChange(
            // The callback expects a VirtualItem; build one lazily only
            // when the consumer actually supplied a custom predicate.
            this.measurementsCache[index] ?? {
              index,
              key,
              start: itemStart,
              size: cachedSize,
              end: itemStart + cachedSize,
              lane: 0
            },
            delta,
            this
          ) : defaultShouldAdjust);
          if (this.pendingMin === null || index < this.pendingMin) {
            this.pendingMin = index;
          }
          this.itemSizeCache.set(key, size);
          this.itemSizeCacheVersion++;
          let adjustedSync = false;
          if (!this._awaitingCommandReadBack()) {
            if (wasAtEnd) {
              adjustedSync = this.applyScrollAdjustment(
                this._getLayoutTotalSize() - prevTotalSize
              );
            } else if (shouldAdjustScroll) {
              adjustedSync = this.applyScrollAdjustment(delta);
            }
          }
          if (this._resizeBatch) {
            this._resizeBatch.notify = true;
            (_c = this._resizeBatch).sync || (_c.sync = adjustedSync);
            return;
          }
          this.notify(adjustedSync);
          this._noteClampMax();
          this._flushHoldIfReady(true);
          this._retryClampedAdjustment();
        }
      };
      this.getVirtualItems = memo(
        () => [this.getVirtualIndexes(), this.getMeasurements(), this._holdOffset],
        (indexes, measurements, hold) => {
          const virtualItems = [];
          for (let k = 0, len = indexes.length; k < len; k++) {
            const i = indexes[k];
            const measurement = measurements[i];
            virtualItems.push(
              hold === 0 ? measurement : {
                ...measurement,
                start: measurement.start - hold,
                end: measurement.end - hold
              }
            );
          }
          return virtualItems;
        },
        {
          key: "getVirtualItems",
          debug: () => this.options.debug
        }
      );
      this.getVirtualItemForOffset = (offset) => {
        var _a;
        const measurements = this.getMeasurements();
        if (measurements.length === 0) {
          return void 0;
        }
        const flat = (_a = this._singleLaneMeasurements) == null ? void 0 : _a.flat;
        const useFlat = this.options.lanes === 1 && flat != null;
        const idx = findNearestBinarySearch(
          0,
          measurements.length - 1,
          useFlat ? (i) => flat[i * 2] : (i) => notUndefined(measurements[i]).start,
          offset
        );
        return notUndefined(measurements[idx]);
      };
      this._noteClampMax = () => {
        if (!this._awaitingCommandReadBack()) return;
        const elementMax = this._elementMaxScrollOffset();
        if (elementMax === null) return;
        const write = this.pendingWrite;
        const max = Math.max(elementMax, 0) + this._holdOffset;
        if (max >= write.target) return;
        const lowMaxes = write.lowMaxes ?? (write.lowMaxes = []);
        if (lowMaxes[lowMaxes.length - 1] !== max) lowMaxes.push(max);
      };
      this.getMaxScrollOffset = () => (this._elementMaxScrollOffset() ?? 0) + this._holdOffset;
      this._toLayoutOffset = (elementOffset) => {
        var _a;
        let offset = elementOffset + this._holdOffset;
        if (((_a = this.pendingScrollAnchor) == null ? void 0 : _a.kind) === "anchor") {
          offset += this.pendingScrollAnchor.delta;
        }
        return offset;
      };
      this._elementMaxScrollOffset = () => {
        const el = this.scrollElement;
        if (el === null) return null;
        if ("scrollHeight" in el) {
          return this.options.horizontal ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
        }
        if ("document" in el) {
          const doc = el.document.documentElement;
          return this.options.horizontal ? doc.scrollWidth - el.innerWidth : doc.scrollHeight - el.innerHeight;
        }
        return null;
      };
      this._momentumStop = null;
      this._stopMomentum = (done) => {
        const el = this.scrollElement;
        const win = this.targetWindow;
        if (el === null || win === null) return;
        const scroller = "document" in el ? el.document.scrollingElement : el;
        if (!(scroller == null ? void 0 : scroller.style)) return;
        if (this._momentumStop) {
          this._momentumStop.done = done;
          return;
        }
        const { style } = scroller;
        const property = this.options.horizontal ? "overflow-x" : "overflow-y";
        const value = style.getPropertyValue(property);
        const priority = style.getPropertyPriority(property);
        style.setProperty(property, "hidden", "important");
        const stop = {
          // False when the app replaced the hidden value: the fling may not
          // have stopped.
          restore: () => {
            if (style.getPropertyValue(property) !== "hidden" || style.getPropertyPriority(property) !== "important") {
              return false;
            }
            style.setProperty(property, value, priority);
            return true;
          },
          done
        };
        this._momentumStop = stop;
        win.requestAnimationFrame(
          () => win.requestAnimationFrame(() => {
            if (this._momentumStop !== stop) return;
            this._momentumStop = null;
            if (stop.restore()) stop.done();
          })
        );
      };
      this._clampedBy = (target) => {
        const elementMax = this._elementMaxScrollOffset();
        if (elementMax === null) return null;
        const maxAtWrite = elementMax + this._holdOffset;
        return target > maxAtWrite + 0.5 ? { target, maxAtWrite } : null;
      };
      this.getVirtualDistanceFromEnd = () => {
        return Math.max(
          this._getLayoutTotalSize() - this.getSize() - this.getScrollOffset(),
          0
        );
      };
      this.getDistanceFromEnd = () => {
        return Math.max(this.getMaxScrollOffset() - this.getScrollOffset(), 0);
      };
      this.isAtEnd = (threshold = this.options.scrollEndThreshold) => {
        return this.getDistanceFromEnd() <= threshold;
      };
      this.getOffsetForAlignment = (toOffset, align, itemSize = 0) => {
        if (!this.scrollElement) return 0;
        const size = this.getSize();
        const scrollOffset = this.getScrollOffset();
        if (align === "auto") {
          align = toOffset >= scrollOffset + size ? "end" : "start";
        }
        if (align === "center") {
          toOffset += (itemSize - size) / 2;
        } else if (align === "end") {
          toOffset -= size;
        }
        const maxOffset = this.getMaxScrollOffset();
        return Math.max(Math.min(maxOffset, toOffset), 0);
      };
      this.getOffsetForIndex = (index, align = "auto") => {
        index = Math.max(0, Math.min(index, this.options.count - 1));
        const size = this.getSize();
        const scrollOffset = this.getScrollOffset();
        const item = this.measurementsCache[index];
        if (!item) return;
        if (align === "auto") {
          if (item.end >= scrollOffset + size - this.options.scrollPaddingEnd) {
            align = "end";
          } else if (item.start <= scrollOffset + this.options.scrollPaddingStart) {
            align = "start";
          } else {
            return [scrollOffset, align];
          }
        }
        if (align === "end" && index === this.options.count - 1) {
          const maxOffset = this.getMaxScrollOffset();
          const toOffset2 = maxOffset - this.options.paddingEnd + this.options.scrollPaddingEnd;
          return [Math.max(Math.min(toOffset2, maxOffset), 0), align];
        }
        const toOffset = align === "end" ? item.end + this.options.scrollPaddingEnd : item.start - this.options.scrollPaddingStart;
        return [
          this.getOffsetForAlignment(toOffset, align, item.size),
          align
        ];
      };
      this.scrollToOffset = (toOffset, { align = "start", behavior = "auto" } = {}) => {
        this._startScroll(
          { index: null, align },
          this.getOffsetForAlignment(toOffset, align),
          behavior,
          "absolute"
        );
      };
      this.scrollToIndex = (index, {
        align: initialAlign = "auto",
        behavior = "auto"
      } = {}) => {
        index = Math.max(0, Math.min(index, this.options.count - 1));
        const offsetInfo = this.getOffsetForIndex(index, initialAlign);
        if (!offsetInfo) return;
        const [offset, align] = offsetInfo;
        this._startScroll({ index, align }, offset, behavior, "absolute");
      };
      this.scrollBy = (delta, { behavior = "auto" } = {}) => {
        const offset = this.getOffsetForAlignment(
          (this.getCommandWrittenOffset() ?? this.getScrollOffset()) + delta,
          "start"
        );
        this._startScroll(
          { index: null, align: "start" },
          offset,
          behavior,
          "relative"
        );
      };
      this.scrollToEnd = ({ behavior = "auto" } = {}) => {
        if (this.options.count > 0) {
          this._startScroll(
            { index: this.options.count - 1, align: "end", toEnd: true },
            Math.max(this.getMaxScrollOffset(), 0),
            behavior,
            "absolute"
          );
          return;
        }
        this.scrollToOffset(Math.max(this.getTotalSize() - this.getSize(), 0), {
          behavior
        });
      };
      this.cancelScroll = () => {
        if (this.rafId != null && this.targetWindow) {
          this.targetWindow.cancelAnimationFrame(this.rafId);
          this.rafId = null;
        }
        this.scrollState = null;
      };
      this.getTotalSize = () => Math.max(this._getLayoutTotalSize() - this._holdOffset, 0);
      this._getLayoutTotalSize = () => {
        var _a, _b;
        const measurements = this.getMeasurements();
        let end;
        if (measurements.length === 0) {
          end = this.options.paddingStart;
        } else if (this.options.lanes === 1) {
          const lastIdx = measurements.length - 1;
          const flat = (_a = this._singleLaneMeasurements) == null ? void 0 : _a.flat;
          if (flat != null) {
            end = flat[lastIdx * 2] + flat[lastIdx * 2 + 1];
          } else {
            end = ((_b = measurements[lastIdx]) == null ? void 0 : _b.end) ?? 0;
          }
        } else {
          const endByLane = Array(this.options.lanes).fill(null);
          let endIndex = measurements.length - 1;
          while (endIndex >= 0 && endByLane.some((val) => val === null)) {
            const item = measurements[endIndex];
            if (endByLane[item.lane] === null) {
              endByLane[item.lane] = item.end;
            }
            endIndex--;
          }
          end = Math.max(...endByLane.filter((val) => val !== null));
        }
        return Math.max(
          end - this.options.scrollMargin + this.options.paddingEnd,
          0
        );
      };
      this.takeSnapshot = () => {
        const snapshot = [];
        if (this.itemSizeCache.size === 0) return snapshot;
        const m = this.getMeasurements();
        for (const item of m) {
          if (item && this.itemSizeCache.has(item.key)) {
            snapshot.push({
              index: item.index,
              key: item.key,
              start: item.start,
              size: item.size,
              end: item.end,
              lane: item.lane
            });
          }
        }
        return snapshot;
      };
      this._scrollToOffset = (offset, {
        adjustments,
        behavior
      } = {}) => {
        const write = {
          target: offset + (adjustments ?? 0),
          smooth: behavior === "smooth"
        };
        this.pendingWrite = write;
        this.options.scrollToFn(
          offset - this._holdOffset,
          { behavior, adjustments },
          this
        );
        return write;
      };
      this.getCommandWrittenOffset = () => this.scrollState !== null && this.pendingWrite !== null && !this.pendingWrite.smooth ? this.pendingWrite.target : null;
      this._awaitingCommandReadBack = () => {
        const writtenOffset = this.getCommandWrittenOffset();
        return !(isIOSWebKit() && this._iosGesture.dragging()) && writtenOffset !== null && !approxEqual(writtenOffset, this.getScrollOffset());
      };
      this._followOffsetTarget = (delta) => {
        if (this.scrollState !== null && this.scrollState.index == null) {
          this.scrollState.lastTargetOffset += delta;
        }
      };
      this.measure = () => {
        this.pendingMin = null;
        this.itemSizeCache.clear();
        this.laneAssignments.clear();
        this.itemSizeCacheVersion++;
        this.notify(false);
      };
      this.setOptions(opts);
    }
    /**
     * @deprecated Always 0: a scroll correction is folded into `scrollOffset`
     * at once, so there is never an outstanding adjustment to add to it. Read
     * `scrollOffset` alone.
     */
    get scrollAdjustments() {
      return 0;
    }
    // Returns `true` when it performed a synchronous `scrollTop` write this
    // tick, `false` when the delta was zero or the write was deferred (iOS).
    // `resizeItem` uses that to decide whether the follow-up `notify` must be
    // synchronous so the grown transforms commit in the same paint (#1227).
    applyScrollAdjustment(delta, behavior) {
      if (delta === 0) return false;
      if (this.options.debug) {
        console.info("correction", delta);
      }
      this._followOffsetTarget(delta);
      if (!this._canWriteScroll()) {
        this._holdOffset += delta;
        if (this.scrollOffset !== null) this.scrollOffset += delta;
        return true;
      } else {
        const offset = this.getScrollOffset();
        this._clampedAdjustment = this._clampedBy(offset + delta);
        const write = this._scrollToOffset(offset, {
          adjustments: delta,
          behavior
        });
        if (this.scrollOffset !== null) {
          if (this.pendingWrite === write) this.scrollOffset += delta;
          if (this.scrollOffset < 0) this.scrollOffset = 0;
        }
        return true;
      }
    }
    scheduleScrollReconcile() {
      if (!this.targetWindow) {
        this.scrollState = null;
        return;
      }
      if (this.rafId != null) return;
      this.rafId = this.targetWindow.requestAnimationFrame(() => {
        this.rafId = null;
        this.reconcileScroll();
      });
    }
    getScrollStateTarget(state) {
      const offsetInfo = state.toEnd ? [Math.max(this.getMaxScrollOffset(), 0)] : state.index != null ? this.getOffsetForIndex(state.index, state.align) : void 0;
      return offsetInfo ? offsetInfo[0] : state.lastTargetOffset;
    }
    reconcileScroll() {
      if (!this.scrollState) return;
      const el = this.scrollElement;
      if (!el) return;
      const MAX_RECONCILE_MS = 5e3;
      if (this.now() - this.scrollState.startedAt > MAX_RECONCILE_MS) {
        this.scrollState = null;
        return;
      }
      if (this.scrollState.phase === "queued") {
        this.scheduleScrollReconcile();
        return;
      }
      this.getMeasurements();
      const targetOffset = this.getScrollStateTarget(this.scrollState);
      const STABLE_FRAMES = this.scrollState.index == null ? 1 : this.options.useAnimationFrameWithResizeObserver ? 3 : 2;
      const targetChanged = targetOffset !== this.scrollState.lastTargetOffset;
      if (!targetChanged && approxEqual(targetOffset, this.getScrollOffset())) {
        if (this.scrollState.phase === "smooth") {
          this.scrollState.phase = "smoothLanded";
        } else if (this.scrollState.phase === "smoothFinishing") {
          this.scrollState.phase = "instant";
        }
        this.scrollState.stableFrames++;
        if (this.scrollState.stableFrames >= STABLE_FRAMES) {
          if (this.getScrollOffset() !== targetOffset) {
            this._scrollToOffset(targetOffset, { behavior: "auto" });
          }
          this.scrollState = null;
          return;
        }
      } else {
        this.scrollState.stableFrames = 0;
        if (targetChanged) {
          const viewport = this.getSize() || 600;
          const distance = Math.abs(targetOffset - this.getScrollOffset());
          const keepSmooth = isSmoothScroll(this.scrollState) && distance > viewport;
          this.scrollState.lastTargetOffset = targetOffset;
          if (keepSmooth) {
            this.scrollState.phase = "smooth";
          } else if (this.scrollState.phase === "smooth") {
            this.scrollState.phase = "smoothFinishing";
          } else if (this.scrollState.phase === "smoothLanded") {
            this.scrollState.phase = "instant";
          }
          this._scrollToOffset(targetOffset, {
            behavior: keepSmooth ? "smooth" : "auto"
          });
        }
      }
      this.scheduleScrollReconcile();
    }
    // Every scroll command starts here: it becomes the in-flight command,
    // writes its first target and leaves reconcile to retarget and retire it.
    //
    // Targets are layout offsets. A held correction is not dropped by a
    // command: the write lands the element `_holdOffset` short of the target,
    // under the rows exposed shifted by the same amount, and the flush moves
    // both together once a write is possible.
    //
    // An index or end target that is already at its offset starts a smooth
    // scroll as landed; an offset target never does, so its first scroll
    // event is read as the user's (see the scroll handler in `_willUpdate`).
    _startScroll(target, offset, behavior, kind) {
      this.pendingScrollAnchor = null;
      this._clampedAdjustment = null;
      const tail = this._iosGesture.tail();
      if (kind === "absolute" && tail !== null) {
        if (tail === "fling" && iosMomentumOverridesWrites()) {
          this._stopMomentum(() => {
            const state = this.scrollState;
            if ((state == null ? void 0 : state.phase) !== "queued" || // A finger came down: it owns the scroll until it lifts.
            this._iosGesture.tail() !== "fling" || // In a bounce WebKit can drop the write (#1287): the tail
            // decides, as without the stop. (Not `flingCaught`: our stop
            // also ends the fling at speed, so a slow frame would read as
            // a catch and the tail would drop the command.)
            this._reportedOverscroll) {
              return;
            }
            this._iosGesture.end();
            this._flushHoldIfReady(true);
            this._writeAwaitingCommand();
          });
          this.scrollState = {
            ...target,
            startedAt: this.now(),
            lastTargetOffset: offset,
            stableFrames: 0,
            phase: "queued",
            behavior,
            samples: []
          };
          this.scheduleScrollReconcile();
          return;
        }
        this._iosGesture.end();
      }
      this.scrollState = {
        ...target,
        startedAt: this.now(),
        lastTargetOffset: offset,
        stableFrames: 0,
        behavior,
        phase: initialScrollPhase(
          behavior,
          target.index != null && approxEqual(offset, this.getScrollOffset())
        )
      };
      this._scrollToOffset(offset, { behavior });
      this.scheduleScrollReconcile();
    }
  };
  var findNearestBinarySearch = (low, high, getCurrentValue, value) => {
    while (low <= high) {
      const middle = (low + high) / 2 | 0;
      const currentValue = getCurrentValue(middle);
      if (currentValue < value) {
        low = middle + 1;
      } else if (currentValue > value) {
        high = middle - 1;
      } else {
        return middle;
      }
    }
    if (low > 0) {
      return low - 1;
    } else {
      return 0;
    }
  };
  function findNearestBinarySearchFlat(flat, high, value) {
    let low = 0;
    while (low <= high) {
      const middle = (low + high) / 2 | 0;
      const currentValue = flat[middle * 2];
      if (currentValue < value) {
        low = middle + 1;
      } else if (currentValue > value) {
        high = middle - 1;
      } else {
        return middle;
      }
    }
    return low > 0 ? low - 1 : 0;
  }
  function calculateRangeImpl(measurements, outerSize, scrollOffset, lanes, flat) {
    const lastIndex = measurements.length - 1;
    if (measurements.length <= lanes) {
      return { startIndex: 0, endIndex: lastIndex };
    }
    if (lanes === 1 && flat !== null) {
      const startIndex2 = findNearestBinarySearchFlat(
        flat,
        lastIndex,
        scrollOffset
      );
      let endIndex2 = startIndex2;
      const limit = scrollOffset + outerSize;
      while (endIndex2 < lastIndex && flat[endIndex2 * 2] + flat[endIndex2 * 2 + 1] < limit) {
        endIndex2++;
      }
      return { startIndex: startIndex2, endIndex: endIndex2 };
    }
    const getStart = (index) => measurements[index].start;
    let startIndex = findNearestBinarySearch(0, lastIndex, getStart, scrollOffset);
    let endIndex = startIndex;
    if (lanes === 1) {
      while (endIndex < lastIndex && measurements[endIndex].end < scrollOffset + outerSize) {
        endIndex++;
      }
    } else if (lanes > 1) {
      const endPerLane = Array(lanes).fill(0);
      while (endIndex < lastIndex && endPerLane.some((pos) => pos < scrollOffset + outerSize)) {
        const item = measurements[endIndex];
        endPerLane[item.lane] = item.end;
        endIndex++;
      }
      const startPerLane = Array(lanes).fill(scrollOffset + outerSize);
      while (startIndex >= 0 && startPerLane.some((pos) => pos >= scrollOffset)) {
        const item = measurements[startIndex];
        startPerLane[item.lane] = item.start;
        startIndex--;
      }
      startIndex = Math.max(0, startIndex - startIndex % lanes);
      endIndex = Math.min(lastIndex, endIndex + (lanes - 1 - endIndex % lanes));
    }
    return { startIndex, endIndex };
  }
  return __toCommonJS(index_exports);
})();
//# sourceMappingURL=tanstack-virtual-core.js.map
