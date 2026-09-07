import { NETEZZA_UNQUOTED_IDENTIFIER_PATTERN } from "../netezza/identifierPattern";

export const netezzaDialectTraits = {
  identifiers: {
    quoteStyle: "double" as const,
    unquotedIdentifierPattern: NETEZZA_UNQUOTED_IDENTIFIER_PATTERN,
    generatedNameCase: "upper" as const,
  },
  qualification: {
    twoPartNameStyle: "schema-object" as const,
    twoPartContainerPreference: "database-over-schema" as const,
    supportsThreePartName: true,
    threePartNamePrefix: "database" as const,
    databaseOnlyReferenceStyle: "double-dot" as const,
  },
  completion: { singleDotPathNamespace: "schema" as const, supportsDoubleDotPath: true },
  objects: { supportsIndexes: true },
};

/** Netezza-only traits; dialect selection belongs to product adapters. */
export const NETEZZA_DIALECT_TRAITS = netezzaDialectTraits;
