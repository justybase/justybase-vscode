/**
 * Utilities for stripping SQL comments — delegates to sql/sqlSourceScan.
 */

export {
  isOffsetInSqlComment,
  stripComments,
} from "../../sql/sqlSourceScan";
