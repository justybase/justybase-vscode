import type { IToken } from "chevrotain";

export type ExternalOptionValueKind =
  | "identifier"
  | "string"
  | "number"
  | "parenthesized";

export type ExternalOptionType =
  | "boolean"
  | "enum"
  | "compress"
  | "integer"
  | "bigint"
  | "string"
  | "single_byte_string"
  | "max_4_byte_string"
  | "max_8_byte_string"
  | "dataobject"
  | "multipart_size_mb"
  | "none";

export interface ExternalOptionValueInfo {
  kind: ExternalOptionValueKind;
  raw: string;
  normalized: string;
  token: IToken;
  nested?: ExternalOptionValueInfo[];
}

export interface ExternalOptionSpec {
  type: ExternalOptionType;
  enumValues?: ReadonlySet<string>;
  min?: number;
  max?: number;
  allowNoValue?: boolean;
}

export const EXTERNAL_BOOLEAN_VALUES = new Set(["TRUE", "FALSE", "ON", "OFF"]);

export const EXTERNAL_OPTION_SPECS = new Map<string, ExternalOptionSpec>([
  [
    "BOOLSTYLE",
    {
      type: "enum",
      enumValues: new Set(["1_0", "T_F", "Y_N", "YES_NO", "TRUE_FALSE"]),
    },
  ],
  ["COMPRESS", { type: "compress" }],
  ["CRINSTRING", { type: "boolean" }],
  ["CTRLCHARS", { type: "boolean" }],
  ["DATAOBJECT", { type: "dataobject" }],
  ["DATEDELIM", { type: "single_byte_string" }],
  [
    "DATESTYLE",
    {
      type: "enum",
      enumValues: new Set([
        "YMD",
        "DMY",
        "MDY",
        "MONDY",
        "DMONY",
        "Y2MD",
        "DMY2",
        "MDY2",
        "MONDY2",
        "DMONY2",
      ]),
    },
  ],
  ["DATETIMEDELIM", { type: "single_byte_string" }],
  ["DECIMALDELIM", { type: "enum", enumValues: new Set([",", "."]) }],
  ["DELIMITER", { type: "single_byte_string" }],
  [
    "ENCODING",
    {
      type: "enum",
      enumValues: new Set(["INTERNAL", "LATIN9", "UTF8", "UTF-8"]),
    },
  ],
  ["ESCAPECHAR", { type: "string" }],
  ["FILLRECORD", { type: "boolean", allowNoValue: true }],
  [
    "FORMAT",
    { type: "enum", enumValues: new Set(["TEXT", "INTERNAL", "FIXED"]) },
  ],
  ["IGNOREZERO", { type: "boolean" }],
  ["INCLUDEHEADER", { type: "boolean", allowNoValue: true }],
  ["INCLUDEZEROSECONDS", { type: "boolean", allowNoValue: true }],
  ["LAYOUT", { type: "none" }],
  ["LFINSTRING", { type: "boolean" }],
  ["LOGDIR", { type: "string" }],
  ["MAXERRORS", { type: "integer", min: 0, max: 2147483647 }],
  ["MAXROWS", { type: "integer", min: 0 }],
  ["MERIDIANDELIM", { type: "single_byte_string" }],
  ["NULLVALUE", { type: "max_4_byte_string" }],
  [
    "QUOTEDVALUE",
    { type: "enum", enumValues: new Set(["NO", "YES", "SINGLE", "DOUBLE"]) },
  ],
  ["RECORDDELIM", { type: "max_8_byte_string" }],
  ["RECORDLENGTH", { type: "integer", min: 1 }],
  [
    "REMOTESOURCE",
    {
      type: "enum",
      enumValues: new Set([
        "ODBC",
        "JDBC",
        "OLE-DB",
        "S3",
        "AZURE",
        "NZSQL",
        "YES",
      ]),
    },
  ],
  ["REQUIREQUOTES", { type: "boolean", allowNoValue: true }],
  ["SKIPROWS", { type: "bigint", min: 0 }],
  ["SOCKETBUFSIZE", { type: "integer", min: 65536, max: 2147483648 }],
  ["TIMEDELIM", { type: "single_byte_string" }],
  ["TIMEROUNDNANOS", { type: "boolean", allowNoValue: true }],
  ["TIMEEXTRAZEROS", { type: "boolean", allowNoValue: true }],
  ["TIMESTYLE", { type: "enum", enumValues: new Set(["24HOUR", "12HOUR"]) }],
  ["TRUNCSTRING", { type: "boolean", allowNoValue: true }],
  ["Y2BASE", { type: "integer", min: 0 }],
  ["UNIQUEID", { type: "string" }],
  ["ACCESSKEYID", { type: "string" }],
  ["SECRETACCESSKEY", { type: "string" }],
  ["DEFAULTREGION", { type: "string" }],
  ["BUCKETURL", { type: "string" }],
  ["MULTIPARTSIZEMB", { type: "multipart_size_mb" }],
  ["ENDPOINT", { type: "string" }],
  ["AZACCOUNT", { type: "string" }],
  ["AZKEY", { type: "string" }],
  ["AZCONTAINER", { type: "string" }],
  ["AZMAXBLOCKS", { type: "integer", min: 1 }],
  ["AZBLOCKSIZEMB", { type: "integer", min: 1, max: 99 }],
  ["AZLOGLEVEL", { type: "string" }],
]);
