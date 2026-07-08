import {
  createDatabaseCapabilities,
  DatabaseAdvancedFeatures,
  DatabaseConnection,
  DatabaseConnectionConfig,
  DatabaseConnectionStaticConstructor,
  DatabaseDialect,
} from "../../contracts/database";
import { netezzaConnectionForm } from "./connectionForm";
import { netezzaMetadataProvider } from "./metadata/provider";
import { netezzaSqlAuthoring } from "./sql/authoring";
import { netezzaDialectTraits } from "./traits";

let _cachedAdvancedFeatures: DatabaseAdvancedFeatures | undefined;

function getAdvancedFeatures(): DatabaseAdvancedFeatures {
  if (!_cachedAdvancedFeatures) {
    const { netezzaAdvancedFeatures } = require("./advancedFeatures");
    _cachedAdvancedFeatures = netezzaAdvancedFeatures;
  }
  return _cachedAdvancedFeatures!;
}

export const netezzaDialect: DatabaseDialect = {
  kind: "netezza",
  displayName: "Netezza",
  defaultPort: 5480,
  capabilities: createDatabaseCapabilities({
    supportsExplainPlan: true,
    supportsExplainGraph: true,
    supportsTuningAdvisor: true,
    supportsExternalTables: true,
    supportsProcedures: true,
    supportsTableMaintenance: true,
    supportsSessionMonitor: true,
  }),
  connectionForm: netezzaConnectionForm,
  traits: netezzaDialectTraits,
  metadataProvider: netezzaMetadataProvider,
  sqlAuthoring: netezzaSqlAuthoring,
  get advancedFeatures(): DatabaseAdvancedFeatures {
    return getAdvancedFeatures();
  },
  getConnectionConstructor(): DatabaseConnectionStaticConstructor {
    return require("@justybase/netezza-driver")
      .NzConnection as DatabaseConnectionStaticConstructor;
  },
  createConnection(config: DatabaseConnectionConfig): DatabaseConnection {
    const NzConnectionClass = netezzaDialect.getConnectionConstructor();
    return new NzConnectionClass(config);
  },
};
