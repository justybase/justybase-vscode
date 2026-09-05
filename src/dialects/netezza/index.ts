import {
  createDatabaseCapabilities,
  DatabaseAdvancedFeatures,
  DatabaseConnection,
  DatabaseConnectionConfig,
  DatabaseConnectionStaticConstructor,
  DatabaseDialect,
  getDatabaseDesignerCapabilities,
} from "../../contracts/database";
import { netezzaConnectionForm } from "./connectionForm";
import { netezzaMetadataProvider } from "./metadata/provider";
import { netezzaSqlAuthoring } from "./sql/authoring";
import { netezzaDialectTraits } from "./traits";
import { getOptionNumber } from "../../core/connectionUtils";

/**
 * NPS can take several seconds to accept a catalog connection while the
 * appliance is busy. This is a TCP/handshake timeout, not SQL execution
 * timeout; keep explicit user configuration authoritative.
 */
export const DEFAULT_NETEZZA_CONNECTION_TIMEOUT_SECONDS = 30;

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
  supportsRawTcpTunnel: true,
  capabilities: createDatabaseCapabilities({
    supportsExplainPlan: true,
    supportsExplainGraph: true,
    supportsTuningAdvisor: true,
    supportsExternalTables: true,
    supportsProcedures: true,
    supportsTableMaintenance: true,
    supportsSessionMonitor: true,
    supportsDistributionMetrics: true,
  }),
  designerCapabilities: getDatabaseDesignerCapabilities("netezza"),
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
    const { ClientTypeId } = require("@justybase/netezza-driver");
    const configuredTimeout = getOptionNumber(config, "connectionTimeout");
    return new NzConnectionClass({
      ...config,
      // @justybase/netezza-driver expects this setting at the top level,
      // while shared connection details store dialect options in `options`.
      connectionTimeout:
        configuredTimeout !== undefined && configuredTimeout >= 0
          ? configuredTimeout
          : DEFAULT_NETEZZA_CONNECTION_TIMEOUT_SECONDS,
      // NPS compatibility identity required by DROP SESSION on some systems.
      clientType: ClientTypeId?.SqlDotnet ?? 11,
    } as DatabaseConnectionConfig);
  },
};
