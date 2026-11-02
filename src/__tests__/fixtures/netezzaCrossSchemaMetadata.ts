import type { TableMetadata } from "../../metadata/types";

/**
 * Deterministic capture of Netezza catalog metadata for cross-schema tests.
 *
 * The values are anonymized but keep the real `_V_TABLE`/`TableMetadata` shape:
 * each object carries its own `SCHEMA`, and the same object name appears in two
 * schemas. The opt-in live test recreates this situation in a real database and
 * checks that `DB..` resolves `DEFSCHEMA`, while `DB.SCHEMA.` sees the other one.
 */
export const NETEZZA_CROSS_SCHEMA_FIXTURE = {
  connectionName: "NETEZZA_FIXTURE",
  database: "JUST_DATA",
  defaultSchema: "ADMIN",
  otherSchema: "PUBLIC",
  sharedTable: "CUSTOMER",
  tablesBySchema: {
    ADMIN: [
      {
        OBJNAME: "CUSTOMER",
        OBJID: 9001,
        SCHEMA: "ADMIN",
        OBJTYPE: "TABLE",
        label: "CUSTOMER",
        objType: "TABLE",
        kind: 6,
      },
      {
        OBJNAME: "ADMIN_ONLY",
        OBJID: 9002,
        SCHEMA: "ADMIN",
        OBJTYPE: "TABLE",
        label: "ADMIN_ONLY",
        objType: "TABLE",
        kind: 6,
      },
    ] satisfies TableMetadata[],
    PUBLIC: [
      {
        OBJNAME: "CUSTOMER",
        OBJID: 9003,
        SCHEMA: "PUBLIC",
        OBJTYPE: "TABLE",
        label: "CUSTOMER",
        objType: "TABLE",
        kind: 6,
      },
      {
        OBJNAME: "PUBLIC_ONLY",
        OBJID: 9004,
        SCHEMA: "PUBLIC",
        OBJTYPE: "TABLE",
        label: "PUBLIC_ONLY",
        objType: "TABLE",
        kind: 6,
      },
    ] satisfies TableMetadata[],
  },
  columnsBySchema: {
    ADMIN: {
      CUSTOMER: ["ID", "NAME"],
      ADMIN_ONLY: ["ID"],
    },
    PUBLIC: {
      CUSTOMER: ["ID", "AUDIT_LABEL"],
      PUBLIC_ONLY: ["ID"],
    },
  },
};
