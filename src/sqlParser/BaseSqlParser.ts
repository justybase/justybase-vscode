/**
 * Compatibility facade. The shared parser implementation is owned by
 * @justybase/sql-core; desktop dialects keep this import path during the
 * migration so existing consumers do not change at once.
 */
export * from "../../packages/sql-core/src/parser/BaseSqlParser";
