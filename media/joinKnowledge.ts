/**
 * JOIN Knowledge manager webview (Stage 3).
 *
 * The host is the source of truth: every row, rank, source and explanation is
 * produced by `buildManagerState`; this script only renders and sends actions.
 */

import type {
  ManagerHostMessage,
  ManagerObjectRow,
  ManagerRelationRow,
  JoinKnowledgeManagerTab,
  ManagerState,
  ManagerWebviewMessage,
} from "../src/contracts/joinKnowledgeManager";

declare function acquireVsCodeApi(): WebviewApi;

type WebviewApi = {
  postMessage(message: ManagerWebviewMessage): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
};

type PersistedState = {
  tab: JoinKnowledgeManagerTab;
  query: string;
  filter: string;
  selectedKey?: string;
  selectedKeys?: string[];
};

const vscode: WebviewApi = acquireVsCodeApi();
const initial = vscode.getState();
let state: ManagerState | undefined;
let tab: JoinKnowledgeManagerTab = initial?.tab ?? "relations";
let query = initial?.query ?? "";
let filter = initial?.filter ?? "all";
let selectedKey = initial?.selectedKey;
const selectedKeys = new Set(initial?.selectedKeys ?? []);
let lastUndo: { kind: "relation" | "object" | "manual"; id: string; label: string } | undefined;
let notice = "";

function $(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing manager element #${id}`);
  }
  return element;
}

function persist(): void {
  vscode.setState({ tab, query, filter, selectedKey, selectedKeys: [...selectedKeys] });
}

function send(message: ManagerWebviewMessage): void {
  vscode.postMessage(message);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (name === "class") {
      node.className = value;
    } else {
      node.setAttribute(name, value);
    }
  }
  for (const child of children) {
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function matches(row: ManagerRelationRow | ManagerObjectRow): boolean {
  const haystack = [
    "tables" in row ? row.tables : row.label,
    "predicate" in row ? row.predicate : "",
    "sources" in row ? row.sources.map((source) => source.label).join(" ") : "",
  ].join(" ").toLowerCase();
  return query.length === 0 || haystack.includes(query.toLowerCase());
}

function filterRelation(row: ManagerRelationRow): boolean {
  if (!matches(row)) return false;
  switch (filter) {
    case "confirmed": return row.decision === "confirmed";
    case "favorite": return row.favorite;
    case "blocked": return row.decision === "blocked";
    case "executed": return row.executed !== undefined && !row.executed.belowThreshold;
    case "workspace": return row.workspace !== undefined && !row.workspace.belowThreshold;
    case "below": return row.workspace?.belowThreshold === true || row.executed?.belowThreshold === true;
    case "configured": return row.configured;
    default: return true;
  }
}

function filterObject(row: ManagerObjectRow): boolean {
  if (!matches(row)) return false;
  switch (filter) {
    case "executed": return row.executed !== undefined && !row.executed.belowThreshold;
    case "workspace": return row.usage !== undefined && !row.usage.belowThreshold;
    case "below": return row.usage?.belowThreshold === true || row.executed?.belowThreshold === true;
    case "configured": return false;
    default: return true;
  }
}

function rankClass(tier: string): string {
  if (tier === "blocked" || tier === "excluded") return "jk-rank jk-rank-blocked";
  if (tier === "below") return "jk-rank jk-rank-below";
  if (tier === "0_0_" || tier === "0_1_") return "jk-rank jk-rank-strong";
  return "jk-rank";
}

function decisionBadge(row: ManagerRelationRow): HTMLElement {
  const label = row.decision === "none" ? (row.favorite ? "favorite" : "observed") : row.decision;
  return el("span", { class: `jk-badge jk-badge-${row.decision === "none" ? "none" : row.decision}` }, [label]);
}

function renderBanner(meta: ManagerState["meta"]): void {
  const banner = $("banner");
  const messages: string[] = [];
  if (!meta.indexingEnabled) {
    messages.push("Workspace SQL indexing is off. File-indexed evidence is unavailable; accepted selections and manual decisions still work.");
  }
  if (!meta.personalizeEnabled) {
    messages.push("FROM-object personalization is off. Object preferences are read-only.");
  }
  if (meta.truncated) {
    messages.push("The index is truncated (file/byte cap or a failed parse); some evidence may be missing.");
  }
  if (meta.lastError) {
    messages.push(`Last index error: ${meta.lastError}`);
  }
  if (meta.execution?.truncated) {
    messages.push("Executed evidence is truncated by a retention limit; newer evidence is not counted.");
  }
  if ((meta.execution?.notDurable ?? 0) > 0) {
    messages.push(`${meta.execution?.notDurable} executed observation(s) were counted in memory but could not be saved.`);
  }
  banner.hidden = messages.length === 0;
  banner.textContent = messages.join(" ");
}

function renderStatus(meta: ManagerState["meta"]): void {
  $("status").textContent = [
    `${meta.filesIndexed} file(s) indexed`,
    `${meta.counts.relations} relation(s): ${meta.counts.confirmed} confirmed, ${meta.counts.favorites} favorite, ${meta.counts.blocked} blocked`,
    `${meta.counts.objects} object(s): ${meta.counts.pinned} pinned, ${meta.counts.excluded} excluded`,
    ...(meta.execution
      ? [
          `${meta.execution.relations} executed relation(s) (${meta.execution.relationsBelowThreshold} below threshold), ` +
            `${meta.execution.objects} executed object(s) (${meta.execution.objectsBelowThreshold} below threshold)`,
          `capture: ${meta.execution.observed ?? 0} observed, ${meta.execution.recorded ?? 0} recorded, ` +
            `${meta.execution.duplicates ?? 0} duplicate, ${meta.execution.notDurable ?? 0} not saved`,
        ]
      : []),
    `${meta.configuredCount} configured manual`,
    `Git: ${meta.gitMode}`,
    ...(meta.lastIndexedAt ? [`last indexed ${meta.lastIndexedAt}`] : []),
  ].join(" · ");
  const footer = $("footer");
  footer.replaceChildren(
    el("button", { type: "button", id: "rebuild", class: "jk-button" }, ["Rebuild index"]),
    ...((meta.execution?.relations ?? 0) + (meta.execution?.objects ?? 0) > 0
      ? [el("button", { type: "button", id: "clear-executed", class: "jk-button jk-button-danger" }, ["Clear executed evidence"])]
      : []),
    el("button", { type: "button", id: "settings", class: "jk-button jk-button-secondary" }, ["Open settings"]),
  );
  $("rebuild").addEventListener("click", () => send({ type: "rebuildIndex" }));
  document.getElementById("clear-executed")
    ?.addEventListener("click", () => send({ type: "clearAllExecutedEvidence" }));
  $("settings").addEventListener("click", () => send({ type: "openSettings" }));
}

function relationDetail(row: ManagerRelationRow): HTMLElement {
  const children: Node[] = [
    el("h2", {}, [row.tables]),
    el("p", { class: "jk-predicate" }, [row.predicate]),
    el("p", {}, [el("span", { class: rankClass(row.tier) }, [row.rankLabel])]),
    el("h3", {}, ["Sources"]),
    el("ul", { class: "jk-sources" }, row.sources.length > 0
      ? row.sources.map((source) => el("li", {}, [`${source.label}${source.detail ? ` — ${source.detail}` : ""}`]))
      : [el("li", { class: "jk-muted" }, ["No manual decision or workspace evidence"])]),
    ...(row.executed
      ? [el("p", { class: "jk-usage" }, [
          `Executed evidence: ${row.executed.observations} execution(s), ${row.executed.distinctDays} day(s)` +
            `${row.executed.belowThreshold ? " — below threshold" : " — eligible"}. Success is not semantic confirmation.`,
        ])]
      : []),
    ...(row.workspace
      ? [el("p", { class: "jk-usage" }, [
          `Workspace evidence: ${row.workspace.distinctFiles} file(s), ${row.workspace.distinctQueries} query(ies) from files + ${row.workspace.acceptedSelections} accepted selection(s) = ${row.workspace.weightedQueries} weighted query(ies).`,
        ])]
      : []),
    el("h3", {}, ["Why this rank?"]),
    el("ul", { class: "jk-explain" }, row.explanation.map((reason) => el("li", {}, [reason]))),
    el("h3", {}, ["Columns"]),
    el("ul", { class: "jk-columns" }, row.columns.map((column) => el("li", {}, [`${column.left} = ${column.right}`]))),
  ];
  const actions = el("div", { class: "jk-actions" });
  const decisionButton = (label: string, action: "confirm" | "block" | "favorite") => {
    const button = el("button", { type: "button", class: "jk-button" }, [label]);
    button.addEventListener("click", () => send({ type: "relationAction", action, key: row.key }));
    return button;
  };
  actions.append(
    decisionButton(row.decision === "confirmed" ? "Re-confirm" : "Confirm relation", "confirm"),
    decisionButton(row.decision === "blocked" ? "Blocked" : "Block relation", "block"),
    decisionButton(row.favorite ? "♥ Remove favorite" : "♡ Favorite", "favorite"),
  );
  const scoreControls = el("div", { class: "jk-score-controls" }, [
    el("span", { class: "jk-score-label" }, [
      `Ranking adjustment: ${row.scoreAdjustment > 0 ? "+" : ""}${row.scoreAdjustment}`,
    ]),
    el("span", { class: "jk-score-label" }, [
      row.tier === "below" || row.tier === "blocked"
        ? "Stored for this relation's current tier. It does not make the relation eligible, unblock it, or create a JOIN suggestion."
        : `Applies within tier ${row.tier} only. Raise moves this JOIN up, Lower moves it down; it never confirms, blocks or changes the tier.`,
    ]),
  ]);
  const scoreButton = (
    label: string,
    action: "increase" | "decrease" | "reset",
    disabled = false,
  ) => {
    const button = el("button", {
      type: "button",
      class: "jk-button jk-button-secondary",
      ...(disabled ? { disabled: "disabled" } : {}),
    }, [label]);
    button.addEventListener("click", () => send({
      type: "relationScoreAction",
      action,
      key: row.key,
    }));
    return button;
  };
  scoreControls.append(
    scoreButton("Raise", "increase", row.scoreAdjustment >= 5),
    scoreButton("Lower", "decrease", row.scoreAdjustment <= -5),
    ...(row.scoreAdjustment !== 0 || row.overrideIds.score !== undefined
      ? [scoreButton("Reset", "reset")]
      : []),
  );
  actions.append(scoreControls);
  if (row.decision !== "none" || row.favorite) {
    const revert = el("button", { type: "button", class: "jk-button jk-button-secondary" }, ["Revert active decision"]);
    revert.addEventListener("click", () => {
      const id = row.decision === "blocked"
        ? row.overrideIds.block
        : row.decision === "confirmed"
          ? row.overrideIds.confirm
          : row.overrideIds.favorite;
      if (id) {
        send({ type: "revert", kind: "relation", id });
      }
    });
    actions.append(revert);
  }
  if (row.workspace && state?.meta.indexingEnabled) {
    const remove = el("button", { type: "button", class: "jk-button jk-button-danger" }, ["Delete indexed SQL evidence"]);
    remove.addEventListener("click", () => send({ type: "deleteEvidence", kind: "relation", key: row.key }));
    actions.append(remove);
  }
  if (row.executed) {
    const clearExecuted = el("button", { type: "button", class: "jk-button jk-button-danger" }, ["Clear executed evidence"]);
    clearExecuted.addEventListener("click", () => send({
      type: "clearExecutedEvidence",
      kind: "relation",
      key: row.key,
    }));
    actions.append(clearExecuted);
  }
  if ((row.workspace?.acceptedSelections ?? 0) > 0) {
    const clearAccepted = el("button", { type: "button", class: "jk-button jk-button-danger" }, ["Clear accepted selections"]);
    clearAccepted.addEventListener("click", () => send({
      type: "deleteAcceptedEvidence",
      key: row.key,
    }));
    actions.append(clearAccepted);
  }
  if (row.configured) {
    const edit = el("button", { type: "button", class: "jk-button jk-button-secondary" }, ["Edit manual relation"]);
    edit.addEventListener("click", () => openManualForm(row));
    const remove = el("button", { type: "button", class: "jk-button jk-button-danger" }, ["Remove manual relation"]);
    remove.addEventListener("click", () => send({ type: "removeManualRelation", key: row.key }));
    actions.append(edit, remove);
  }
  children.push(actions);
  return el("div", { class: "jk-detail-content" }, children);
}

function objectDetail(row: ManagerObjectRow): HTMLElement {
  const children: Node[] = [
    el("h2", {}, [row.label]),
    el("p", {}, [el("span", { class: rankClass(row.tier) }, [row.rankLabel])]),
    el("h3", {}, ["Usage"]),
    row.usage
      ? el("p", { class: "jk-usage" }, [
          `${row.usage.distinctFiles} file(s), ${row.usage.distinctQueries} query(ies) · SELECT ${row.usage.select}, INSERT ${row.usage.insert}, UPDATE ${row.usage.update}, DELETE ${row.usage.delete}`,
          row.usage.belowThreshold ? " · below threshold" : "",
        ])
      : el("p", { class: "jk-muted" }, ["No observed workspace usage"]),
    ...(row.executed
      ? [el("p", { class: "jk-usage" }, [
          `Executed usage: ${row.executed.observations} execution(s), ${row.executed.distinctDays} day(s) · ` +
            `SELECT ${row.executed.usage.select}, INSERT ${row.executed.usage.insert}, ` +
            `UPDATE ${row.executed.usage.update}, DELETE ${row.executed.usage.delete}` +
            (row.executed.belowThreshold ? " · below threshold" : ""),
        ])]
      : []),
    el("h3", {}, ["Why this rank?"]),
    el("ul", { class: "jk-explain" }, row.explanation.map((reason) => el("li", {}, [reason]))),
  ];
  const actions = el("div", { class: "jk-actions" });
  const disabled = state?.meta.personalizeEnabled !== true;
  const action = (label: string, type: "pin" | "boost" | "demote" | "exclude", band?: number, danger = false) => {
    const button = el("button", {
      type: "button",
      class: `jk-button${danger ? " jk-button-danger" : ""}`,
      ...(disabled ? { disabled: "disabled", title: "FROM-object personalization is off" } : {}),
    }, [label]);
    button.addEventListener("click", () => send({ type: "objectAction", action: type, key: row.key, ...(band !== undefined ? { band } : {}) }));
    return button;
  };
  const pinOrderInput = el("input", {
    type: "number",
    id: "pin-order",
    min: "1",
    step: "1",
    value: String(row.pinOrder ?? 1),
    "aria-label": "Pin order",
    class: "jk-number",
    ...(disabled ? { disabled: "disabled" } : {}),
  });
  const pin = el("button", {
    type: "button",
    class: "jk-button",
    ...(disabled ? { disabled: "disabled" } : {}),
  }, [row.pinOrder === undefined ? "Pin object" : "Move pin"]);
  pin.addEventListener("click", () => {
    const value = Number.parseInt((document.getElementById("pin-order") as HTMLInputElement | null)?.value ?? "1", 10);
    send({ type: "objectAction", action: "pin", key: row.key, ...(Number.isFinite(value) ? { pinOrder: value } : {}) });
  });
  actions.append(
    pinOrderInput,
    pin,
    action("Boost (band 05)", "boost", 5),
    action("Demote", "demote"),
    action("Exclude from FROM", "exclude", undefined, true),
  );
  if (row.overrideId) {
    const revert = el("button", {
      type: "button",
      class: "jk-button jk-button-secondary",
      ...(disabled ? { disabled: "disabled" } : {}),
    }, ["Revert preference"]);
    revert.addEventListener("click", () => send({ type: "revert", kind: "object", id: row.overrideId! }));
    actions.append(revert);
  }
  if (row.usage && state?.meta.indexingEnabled) {
    const remove = el("button", { type: "button", class: "jk-button jk-button-danger" }, ["Delete observed evidence"]);
    remove.addEventListener("click", () => send({ type: "deleteEvidence", kind: "object", key: row.key }));
    actions.append(remove);
  }
  if (row.executed) {
    const clearExecuted = el("button", { type: "button", class: "jk-button jk-button-danger" }, ["Clear executed usage"]);
    clearExecuted.addEventListener("click", () => send({
      type: "clearExecutedEvidence",
      kind: "object",
      key: row.key,
    }));
    actions.append(clearExecuted);
  }
  children.push(actions);
  return el("div", { class: "jk-detail-content" }, children);
}

function openManualForm(row?: ManagerRelationRow): void {
  const detail = $("detail");
  const field = (label: string, value: string, id: string, placeholder = "") => {
    const input = el("input", { type: "text", id, value, placeholder });
    return el("label", { class: "jk-field" }, [el("span", {}, [label]), input]);
  };
  const form = el("form", { class: "jk-form" }, [
    el("h2", {}, [row ? "Edit manual relation" : "Add manual relation"]),
    el("p", { class: "jk-muted" }, [
      "Writes justybase.sql.joinRelations at workspace scope after a diff confirmation. Manual relations rank at 0_0_. Each side keeps its own scope.",
    ]),
    field("Left database (optional)", row?.left.database ?? "", "manual-left-database", "PROD_DB"),
    field("Left schema (optional)", row?.left.schema ?? "", "manual-left-schema", "ADMIN"),
    field("Left table", row?.left.table ?? "", "manual-left", "USERS"),
    field("Right database (optional)", row?.right.database ?? "", "manual-right-database", "PROD_DB"),
    field("Right schema (optional)", row?.right.schema ?? "", "manual-right-schema", "ADMIN"),
    field("Right table", row?.right.table ?? "", "manual-right", "ORDERS"),
    el("label", { class: "jk-field" }, [
      el("span", {}, ["Column pairs (one `left=right` per line)"]),
      el("textarea", { id: "manual-columns", rows: "4", placeholder: "USER_ID=OWNER_ID" }, [
        row?.columns.map((column) => `${column.left}=${column.right}`).join("\n") ?? "",
      ]),
    ]),
    el("div", { class: "jk-actions" }, [
      el("button", { type: "submit", class: "jk-button" }, [row ? "Save manual relation" : "Add manual relation"]),
    ]),
  ]);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    send({
      type: "saveManualRelation",
      ...(row ? { originalKey: row.key } : {}),
      relation: {
        ...(valueOf("manual-left-database") ? { leftDatabase: valueOf("manual-left-database") } : {}),
        ...(valueOf("manual-left-schema") ? { leftSchema: valueOf("manual-left-schema") } : {}),
        ...(valueOf("manual-right-database") ? { rightDatabase: valueOf("manual-right-database") } : {}),
        ...(valueOf("manual-right-schema") ? { rightSchema: valueOf("manual-right-schema") } : {}),
        leftTable: valueOf("manual-left"),
        rightTable: valueOf("manual-right"),
        columns: valueOf("manual-columns"),
      },
    });
  });
  detail.replaceChildren(form);
  (form.querySelector("#manual-left") as HTMLInputElement | null)?.focus();
}

function valueOf(id: string): string {
  const element = document.getElementById(id);
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
    ? element.value.trim()
    : "";
}

function selectRow(kind: "relations" | "objects", key: string): void {
  selectedKey = key;
  persist();
  renderList();
  renderDetail();
}

function renderList(): void {
  const list = $("list");
  list.replaceChildren();
  if (!state) {
    list.append(el("p", { class: "jk-muted" }, ["Loading…"]));
    return;
  }
  if (tab === "relations") {
    const rows = state.relations.filter(filterRelation);
    list.append(el("div", { class: "jk-list-header" }, [
      el("span", {}, [`${rows.length} relation(s)`]),
      el("button", { type: "button", id: "add-relation", class: "jk-button" }, ["+ Add manual relation"]),
    ]));
    $("add-relation").addEventListener("click", () => openManualForm());
    if (rows.length === 0) {
      list.append(el("p", { class: "jk-empty" }, [
        state.meta.indexingEnabled
          ? "No relations match this filter. Configure a manual relation or index SQL files."
          : "Workspace indexing is off. Add a manual relation or enable justybase.sql.joinKnowledgeIndex.",
      ]));
      return;
    }
    for (const row of rows) {
      const button = el("button", {
        type: "button",
        class: `jk-row${selectedKey === row.key ? " jk-row-selected" : ""}`,
        "data-key": row.key,
        "aria-pressed": selectedKey === row.key ? "true" : "false",
      }, [
        el("span", { class: "jk-row-main" }, [
          el("span", { class: "jk-row-title" }, [row.tables]),
          el("span", { class: "jk-row-sub" }, [row.predicate]),
        ]),
        el("span", { class: "jk-row-side" }, [
          decisionBadge(row),
          el("span", { class: rankClass(row.tier) }, [row.tier === "below" ? "below" : row.tier]),
        ]),
      ]);
      button.addEventListener("click", () => selectRow("relations", row.key));
      const favorite = el("button", {
        type: "button",
        class: `jk-favorite-button${row.favorite ? " jk-favorite-active" : ""}`,
        title: row.favorite ? "Remove ranking preference" : "Give this JOIN suggestion a ranking preference",
        "aria-label": `${row.favorite ? "Remove" : "Add"} favorite for ${row.tables}`,
        "aria-pressed": row.favorite ? "true" : "false",
      }, [row.favorite ? "♥" : "♡"]);
      favorite.addEventListener("click", () => send({
        type: "relationAction",
        action: "favorite",
        key: row.key,
      }));
      const scoreControls = el("div", { class: "jk-score-compact" }, [
        el("button", {
          type: "button",
          class: "jk-score-step",
          title: "Lower this JOIN's ranking",
          "aria-label": `Lower ranking for ${row.tables}`,
          ...(row.scoreAdjustment <= -5 ? { disabled: "disabled" } : {}),
        }, ["−"]),
        el("span", { class: "jk-score-value" }, [`${row.scoreAdjustment > 0 ? "+" : ""}${row.scoreAdjustment}`]),
        el("button", {
          type: "button",
          class: "jk-score-step",
          title: "Raise this JOIN's ranking",
          "aria-label": `Raise ranking for ${row.tables}`,
          ...(row.scoreAdjustment >= 5 ? { disabled: "disabled" } : {}),
        }, ["+"]),
      ]);
      scoreControls.querySelectorAll("button").forEach((scoreButton, index) => {
        scoreButton.addEventListener("click", () => send({
          type: "relationScoreAction",
          action: index === 0 ? "decrease" : "increase",
          key: row.key,
        }));
      });
      list.append(el("div", { class: "jk-row-wrap jk-relation-row" }, [button, scoreControls, favorite]));
    }
    return;
  }

  const rows = state.objects.filter(filterObject);
  list.append(el("div", { class: "jk-list-header" }, [
    el("span", {}, [`${rows.length} object(s)`]),
    el("span", { class: "jk-bulk" }, [
      el("button", {
        type: "button",
        id: "bulk-exclude",
        class: "jk-button jk-button-secondary",
        ...(state.meta.personalizeEnabled ? {} : { disabled: "disabled" }),
      }, ["Exclude selected"]),
      el("button", {
        type: "button",
        id: "bulk-delete",
        class: "jk-button jk-button-danger",
        ...(state.meta.indexingEnabled ? {} : { disabled: "disabled" }),
      }, ["Delete selected evidence"]),
    ]),
  ]));
  $("bulk-exclude").addEventListener("click", () => {
    if (selectedKeys.size > 0) {
      send({ type: "bulk", action: "exclude", keys: [...selectedKeys] });
    }
  });
  $("bulk-delete").addEventListener("click", () => {
    if (selectedKeys.size > 0) {
      send({ type: "bulk", action: "deleteEvidence", keys: [...selectedKeys] });
    }
  });
  if (rows.length === 0) {
    list.append(el("p", { class: "jk-empty" }, [
      state.meta.indexingEnabled
        ? "No objects match this filter."
        : "Workspace indexing is off; no object usage is available.",
    ]));
    return;
  }
  for (const row of rows) {
    const checkbox = el("input", {
      type: "checkbox",
      class: "jk-select",
      "aria-label": `Select ${row.label}`,
      ...(selectedKeys.has(row.key) ? { checked: "checked" } : {}),
    });
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        selectedKeys.add(row.key);
      } else {
        selectedKeys.delete(row.key);
      }
      persist();
    });
    const button = el("button", {
      type: "button",
      class: `jk-row${selectedKey === row.key ? " jk-row-selected" : ""}`,
      "data-key": row.key,
    }, [
      el("span", { class: "jk-row-main" }, [
        el("span", { class: "jk-row-title" }, [row.label]),
        el("span", { class: "jk-row-sub" }, [row.rankLabel]),
      ]),
      el("span", { class: "jk-row-side" }, [
        el("span", { class: `jk-badge jk-badge-${row.kind}` }, [row.kind]),
        el("span", { class: rankClass(row.tier) }, [row.tier === "below" ? "below" : row.tier]),
      ]),
    ]);
    button.addEventListener("click", () => selectRow("objects", row.key));
    list.append(el("div", { class: "jk-row-wrap" }, [checkbox, button]));
  }
}

function renderDetail(): void {
  const detail = $("detail");
  if (!state || !selectedKey) {
    detail.replaceChildren(el("p", { class: "jk-muted" }, ["Select an entry to inspect its sources and rank."]));
    return;
  }
  if (tab === "relations") {
    const row = state.relations.find((entry) => entry.key === selectedKey);
    detail.replaceChildren(row ? relationDetail(row) : el("p", { class: "jk-muted" }, ["The selected relation disappeared."]));
    return;
  }
  const row = state.objects.find((entry) => entry.key === selectedKey);
  detail.replaceChildren(row ? objectDetail(row) : el("p", { class: "jk-muted" }, ["The selected object disappeared."]));
}

function renderNotice(): void {
  const status = $("status");
  status.textContent = notice;
}

function render(): void {
  if (!state) {
    return;
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
    const isActive = button.dataset.tab === tab;
    button.setAttribute("aria-selected", isActive ? "true" : "false");
    button.classList.toggle("jk-tab-active", isActive);
  }
  ($("search") as HTMLInputElement).value = query;
  ($("filter") as HTMLSelectElement).value = filter;
  renderBanner(state.meta);
  renderStatus(state.meta);
  renderList();
  renderDetail();
  if (lastUndo) {
    const footer = $("footer");
    const undo = el("button", { type: "button", id: "undo", class: "jk-button jk-button-secondary" }, [lastUndo.label]);
    undo.addEventListener("click", () => send({ type: "revert", kind: lastUndo!.kind, id: lastUndo!.id }));
    footer.prepend(undo);
  }
  if (notice) {
    renderNotice();
  }
}

window.addEventListener("message", (event: MessageEvent<ManagerHostMessage>) => {
  const message = event.data;
  if (message.type === "state") {
    state = message.state;
    if (message.focus) {
      tab = message.focus.tab;
      filter = message.focus.filter;
      selectedKey = undefined;
      selectedKeys.clear();
      persist();
    }
    const known = tab === "relations"
      ? state.relations.some((row) => row.key === selectedKey)
      : state.objects.some((row) => row.key === selectedKey);
    if (!known) {
      selectedKey = undefined;
    }
    render();
    return;
  }
  if (message.type === "actionResult") {
    notice = message.message;
    lastUndo = message.undo && message.undo.kind !== "manual"
      ? { kind: message.undo.kind as "relation" | "object", id: message.undo.id, label: message.undo.label }
      : undefined;
    if (message.undo?.kind === "manual" && state) {
      // Manual relation undo is a host-side config restore; keep the button
      // visible only when the host can still apply it.
      lastUndo = { kind: "manual", id: "manual", label: message.undo.label };
    }
    render();
    renderNotice();
    return;
  }
  if (message.type === "error") {
    notice = message.message;
    renderNotice();
  }
});

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
  button.addEventListener("click", () => {
    tab = button.dataset.tab === "objects" ? "objects" : "relations";
    selectedKey = undefined;
    persist();
    render();
  });
}

$("search").addEventListener("input", (event) => {
  query = (event.target as HTMLInputElement).value;
  persist();
  renderList();
});

$("filter").addEventListener("change", (event) => {
  filter = (event.target as HTMLSelectElement).value;
  persist();
  renderList();
});

$("refresh").addEventListener("click", () => send({ type: "refresh" }));

send({ type: "ready" });
