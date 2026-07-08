import { __TEST_ONLY_resetDatabaseDialectRegistry } from "../core/factories/databaseDialectRegistry";
import { __TEST_ONLY_resetBuiltInDialectsRegistration } from "../dialects";

export function resetDatabaseDialectTestingState(): void {
  __TEST_ONLY_resetDatabaseDialectRegistry();
  __TEST_ONLY_resetBuiltInDialectsRegistration();
}
