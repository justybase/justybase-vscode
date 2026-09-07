import type { DatabaseSqlValidationProfile } from "@justybase/contracts";
import {
  NETEZZA_BUILTIN_FUNCTIONS,
  NETEZZA_SPECIAL_BUILTIN_VALUES,
  NETEZZA_SYSTEM_COLUMNS,
} from "./builtins";
import { getNetezzaTypeSpec, supportsProcedureAnySizeArgument } from "./dataTypes";

export const NETEZZA_SQL_VALIDATION_PROFILE: DatabaseSqlValidationProfile = {
  builtinFunctions: NETEZZA_BUILTIN_FUNCTIONS,
  systemColumns: NETEZZA_SYSTEM_COLUMNS,
  specialBuiltinValues: NETEZZA_SPECIAL_BUILTIN_VALUES,
  getTypeSpec: getNetezzaTypeSpec,
  supportsProcedureAnySizeArgument,
};
