import { beforeEach, expect } from "@jest/globals";
import { SqlValidator } from "../../sqlParser/validator";
import {
  InMemorySchemaProvider,
  createMockSchemaProvider,
} from "../../sqlParser/schemaProvider";

export const mockTableDefinitions = [
  {
    database: "TESTDB",
    schema: "PUBLIC",
    name: "EMPLOYEES",
    columns: [
      "EMPLOYEE_ID",
      "FIRST_NAME",
      "LAST_NAME",
      "DEPARTMENT_ID",
      "SALARY",
      "HIRE_DATE",
      "MANAGER_ID",
      "STATUS",
    ],
  },
  {
    database: "TESTDB",
    schema: "PUBLIC",
    name: "DEPARTMENTS",
    columns: ["DEPARTMENT_ID", "DEPARTMENT_NAME", "LOCATION_ID"],
  },
  {
    database: "TESTDB",
    schema: "PUBLIC",
    name: "ORDERS",
    columns: [
      "ORDER_ID",
      "CUSTOMER_ID",
      "ORDER_DATE",
      "TOTAL_AMOUNT",
      "STATUS",
    ],
  },
  {
    database: "TESTDB",
    schema: "PUBLIC",
    name: "ORDER_ITEMS",
    columns: ["ITEM_ID", "ORDER_ID", "PRODUCT_ID", "QUANTITY", "UNIT_PRICE"],
  },
  {
    database: "TESTDB",
    schema: "PUBLIC",
    name: "PRODUCTS",
    columns: ["PRODUCT_ID", "PRODUCT_NAME", "CATEGORY", "PRICE"],
  },
  {
    database: "TESTDB",
    schema: "PUBLIC",
    name: "FILMS",
    columns: ["CODE", "TITLE", "DID", "DATE_PROD", "KIND", "LEN"],
  },
  {
    database: "TESTDB",
    schema: "ADMIN",
    name: "MY_PROC",
    columns: ["ID"],
  },
  {
    database: "EXISTING_DATABASE",
    schema: "ADMIN",
    name: "EXISTING_PROCEDURE",
    columns: ["ID"],
  },
  {
    database: "EXISTING_DATABASE",
    schema: "ADMIN",
    name: "DIMACCOUNT",
    columns: ["ID"],
  },
  {
    database: "TESTDB",
    schema: "PUBLIC",
    name: "TMP_TO_DROP",
    columns: ["ID"],
  },
  {
    database: "TESTDB",
    schema: "PUBLIC",
    name: "EMP_VIEW",
    columns: ["ID"],
  },
  {
    database: "TESTDB",
    schema: "PUBLIC",
    name: "V_PROC_TMP",
    columns: ["ID"],
  },
  {
    database: "JUST_DATA",
    schema: "ADMIN",
    name: "DIMACCOUNT",
    columns: ["ACCOUNTCODEALTERNATEKEY", "ACCOUNTKEY"],
  },
  {
    database: "JUST_DATA",
    schema: "ADMIN",
    name: "DIMDATE",
    columns: ["ACCOUNTKEY", "DATEKEY", "CALENDARQUARTER"],
  },
];

export let validator: SqlValidator;
export let schemaProvider: InMemorySchemaProvider;

export const getSyntaxErrors = (result: { errors: Array<{ code: string }> }) =>
  result.errors.filter(
    (e) => e.code.startsWith("PAR") || e.code.startsWith("LEX"),
  );

export const expectValid = (sql: string) => {
  const result = validator.validate(sql);
  expect(result.errors).toHaveLength(0);
};

export const expectSyntaxError = (sql: string) => {
  const result = validator.validate(sql);
  expect(getSyntaxErrors(result).length).toBeGreaterThan(0);
};

export const expectErrorCode = (sql: string, code: string) => {
  const result = validator.validate(sql);
  expect(result.errors.some((e) => e.code === code)).toBe(true);
};

export const expectWarningCode = (sql: string, code: string) => {
  const result = validator.validate(sql);
  expect(result.errors).toHaveLength(0);
  expect(result.warnings.some((e) => e.code === code)).toBe(true);
};

export function setupSqlValidatorTests(): void {
  beforeEach(() => {
    schemaProvider = createMockSchemaProvider(mockTableDefinitions);
    validator = new SqlValidator(schemaProvider);
  });
}
