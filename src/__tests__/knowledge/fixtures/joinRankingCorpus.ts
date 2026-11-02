import type { ReplayFile } from "../../../knowledge/joinRankingReplay";

/**
 * Deterministic, maintainer-labelled JOIN corpus for the ranking replay.
 *
 * The groups are deliberately uneven in breadth and age, and several targets
 * are reachable from the same source table, so the order *inside* one evidence
 * tier decides Top-1. Alphabetical order (the pre-scoring behaviour) puts the
 * rare, stale `AUDIT_LOG` before the dominant `CUSTOMERS`.
 */
export const JOIN_RANKING_CORPUS_NOW = "2026-10-26T12:00:00.000Z";

const RECENT = Date.parse("2026-10-20T09:00:00.000Z");
const MID = Date.parse("2026-08-01T09:00:00.000Z");
const OLD = Date.parse("2025-06-01T09:00:00.000Z");

interface CorpusGroup {
  name: string;
  copies: number;
  mtimeMs: number;
  sql: (index: number) => string;
}

const GROUPS: CorpusGroup[] = [
  {
    name: "sales/orders_customers",
    copies: 8,
    mtimeMs: RECENT,
    sql: (index) => `SELECT o.ORDER_ID, c.NAME, ${index} AS N
FROM ORDERS o
JOIN CUSTOMERS c ON o.CUSTOMER_ID = c.CUSTOMER_ID
WHERE o.STATUS = 'OPEN';`,
  },
  {
    name: "sales/order_lines",
    copies: 5,
    mtimeMs: MID,
    sql: (index) => `SELECT i.QTY, p.NAME, ${index} AS N
FROM ORDERS o
JOIN ORDER_ITEMS i ON i.ORDER_ID = o.ORDER_ID
JOIN PRODUCTS p ON p.PRODUCT_ID = i.PRODUCT_ID;`,
  },
  {
    name: "ops/order_audit",
    copies: 2,
    mtimeMs: OLD,
    sql: (index) => `SELECT a.CHANGED_AT, ${index} AS N
FROM ORDERS o
JOIN AUDIT_LOG a ON a.ORDER_ID = o.ORDER_ID;`,
  },
  {
    name: "sales/orders_regions",
    copies: 4,
    mtimeMs: RECENT,
    sql: (index) => `SELECT r.REGION_NAME, COUNT(*) AS N${index}
FROM ORDERS o
JOIN CUSTOMERS c ON c.CUSTOMER_ID = o.CUSTOMER_ID
JOIN REGIONS r ON r.REGION_ID = c.REGION_ID
GROUP BY r.REGION_NAME;`,
  },
  {
    name: "finance/customer_accounts",
    copies: 3,
    mtimeMs: OLD,
    sql: (index) => `SELECT a.BALANCE, ${index} AS N
FROM CUSTOMERS c
JOIN ACCOUNTS a ON a.ACCOUNT_ID = c.ACCOUNT_ID;`,
  },
  {
    name: "catalog/product_categories",
    copies: 3,
    mtimeMs: MID,
    sql: (index) => `SELECT k.CATEGORY_NAME, ${index} AS N
FROM PRODUCTS p
JOIN CATEGORIES k ON k.CATEGORY_ID = p.CATEGORY_ID;`,
  },
];

export function buildJoinRankingCorpus(): ReplayFile[] {
  return GROUPS.flatMap((group) =>
    Array.from({ length: group.copies }, (_, index) => ({
      relPath: `${group.name}_${index + 1}.sql`,
      text: group.sql(index + 1),
      mtimeMs: group.mtimeMs + index * 60_000,
    })));
}
