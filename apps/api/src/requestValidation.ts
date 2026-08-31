import type {
  QueryAggregateRequest,
  QueryExportRequest,
  QueryGroupRequest,
  QueryPageRequest,
  QueryStartRequest,
  QueryExecutionMode,
  QuerySortSpec,
  QueryColumnFilterSpec,
  QueryAggregateFunction,
  QueryGroupAggregate,
  QueryExportFormat,
} from '@justybase/contracts';

const MAX_SQL_LENGTH = 5_000_000;
const MAX_FILTER_LENGTH = 10_000;
const MAX_ARRAY_ITEMS = 1_000;

/** A client-controlled request failed structural validation. */
export class RequestValidationError extends Error {
  public readonly code = 'INVALID_REQUEST';

  public constructor(message: string) {
    super(message);
    this.name = 'RequestValidationError';
  }
}

function objectValue(value: unknown, label = 'request body'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RequestValidationError(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: unknown,
  field: string,
  maxLength = 512,
  preserveWhitespace = false,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RequestValidationError(`${field} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new RequestValidationError(`${field} exceeds the maximum length of ${maxLength}.`);
  }
  return preserveWhitespace ? value : normalized;
}

function optionalString(value: unknown, field: string, maxLength = 512): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new RequestValidationError(`${field} must be a string.`);
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new RequestValidationError(`${field} exceeds the maximum length of ${maxLength}.`);
  }
  return normalized || undefined;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new RequestValidationError(`${field} must be a boolean.`);
  return value;
}

function optionalInteger(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RequestValidationError(`${field} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function arrayValue(value: unknown, field: string): unknown[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new RequestValidationError(`${field} must be an array.`);
  if (value.length > MAX_ARRAY_ITEMS) throw new RequestValidationError(`${field} contains too many items.`);
  return value;
}

function querySort(value: unknown): QuerySortSpec[] | undefined {
  const items = arrayValue(value, 'sorting');
  if (!items) return undefined;
  return items.map((item, index) => {
    const record = objectValue(item, `sorting[${index}]`);
    const columnIndex = optionalInteger(record.columnIndex, `sorting[${index}].columnIndex`, 0, Number.MAX_SAFE_INTEGER);
    if (columnIndex === undefined) throw new RequestValidationError(`sorting[${index}].columnIndex is required.`);
    if (typeof record.desc !== 'boolean') throw new RequestValidationError(`sorting[${index}].desc must be a boolean.`);
    return { columnIndex, desc: record.desc };
  });
}

function queryColumnFilters(value: unknown): QueryColumnFilterSpec[] | undefined {
  const items = arrayValue(value, 'columnFilters');
  if (!items) return undefined;
  return items.map((item, index) => {
    const record = objectValue(item, `columnFilters[${index}]`);
    const columnIndex = optionalInteger(record.columnIndex, `columnFilters[${index}].columnIndex`, 0, Number.MAX_SAFE_INTEGER);
    if (columnIndex === undefined) throw new RequestValidationError(`columnFilters[${index}].columnIndex is required.`);
    return {
      columnIndex,
      value: requiredString(record.value, `columnFilters[${index}].value`, MAX_FILTER_LENGTH),
    };
  });
}

export function parseQueryPageRequest(value: unknown): QueryPageRequest {
  const record = objectValue(value);
  return {
    statementIndex: optionalInteger(record.statementIndex, 'statementIndex', 0, Number.MAX_SAFE_INTEGER),
    offset: optionalInteger(record.offset, 'offset', 0, Number.MAX_SAFE_INTEGER),
    limit: optionalInteger(record.limit, 'limit', 1, 1_000),
    globalFilter: optionalString(record.globalFilter, 'globalFilter', MAX_FILTER_LENGTH),
    columnFilters: queryColumnFilters(record.columnFilters),
    sorting: querySort(record.sorting),
  };
}

export function parseQueryAggregateRequest(value: unknown): QueryAggregateRequest {
  const record = objectValue(value);
  const base = parseQueryPageRequest(record);
  const functions = arrayValue(record.functions, 'functions')?.map((item, index) => {
    if (!['count', 'sum', 'avg', 'min', 'max'].includes(String(item))) {
      throw new RequestValidationError(`functions[${index}] is not supported.`);
    }
    return String(item) as QueryAggregateFunction;
  });
  const columnIndices = arrayValue(record.columnIndices, 'columnIndices')?.map((item, index) => {
    const number = optionalInteger(item, `columnIndices[${index}]`, 0, Number.MAX_SAFE_INTEGER);
    if (number === undefined) throw new RequestValidationError(`columnIndices[${index}] is required.`);
    return number;
  });
  return { ...base, functions, columnIndices };
}

export function parseQueryGroupRequest(value: unknown): QueryGroupRequest {
  const record = objectValue(value);
  const base = parseQueryPageRequest(record);
  const groupByColumnIndices = arrayValue(record.groupByColumnIndices, 'groupByColumnIndices');
  if (!groupByColumnIndices || groupByColumnIndices.length === 0) {
    throw new RequestValidationError('groupByColumnIndices must contain at least one column.');
  }
  const groups = groupByColumnIndices.map((item, index) => {
    const number = optionalInteger(item, `groupByColumnIndices[${index}]`, 0, Number.MAX_SAFE_INTEGER);
    if (number === undefined) throw new RequestValidationError(`groupByColumnIndices[${index}] is required.`);
    return number;
  });
  const aggregates = arrayValue(record.aggregates, 'aggregates')?.map((item, index): QueryGroupAggregate => {
    const aggregate = objectValue(item, `aggregates[${index}]`);
    const functionName = String(aggregate.function);
    if (!['count', 'sum', 'avg', 'min', 'max'].includes(functionName)) {
      throw new RequestValidationError(`aggregates[${index}].function is not supported.`);
    }
    return {
      function: functionName as QueryGroupAggregate['function'],
      columnIndex: optionalInteger(aggregate.columnIndex, `aggregates[${index}].columnIndex`, 0, Number.MAX_SAFE_INTEGER),
    };
  });
  return {
    ...base,
    groupByColumnIndices: groups,
    aggregates,
    groupLimit: optionalInteger(record.groupLimit, 'groupLimit', 1, 10_000),
  };
}

export function parseQueryExportRequest(value: unknown): QueryExportRequest {
  const record = objectValue(value);
  const base = parseQueryPageRequest(record);
  const format = requiredString(record.format, 'format', 16);
  const supported: readonly QueryExportFormat[] = ['csv', 'csv.gz', 'csv.zst', 'json', 'xml', 'sql', 'markdown', 'xlsx', 'xlsb'];
  if (!supported.includes(format as QueryExportFormat)) throw new RequestValidationError('format is not supported.');
  return {
    ...base,
    format: format as QueryExportFormat,
    fileName: optionalString(record.fileName, 'fileName', 256),
  };
}

export function parseQueryStartRequest(value: unknown): QueryStartRequest {
  const record = objectValue(value);
  const modeValue = record.mode === undefined ? 'single' : requiredString(record.mode, 'mode', 16);
  if (!['single', 'script', 'explain'].includes(modeValue)) {
    throw new RequestValidationError('mode must be single, script, or explain.');
  }
  return {
    connectionId: requiredString(record.connectionId, 'connectionId'),
    // Keep SQL byte-for-byte intact: cursorOffset and diagnostics refer to
    // positions in the editor document, so trimming here would shift them.
    sql: requiredString(record.sql, 'sql', MAX_SQL_LENGTH, true),
    database: optionalString(record.database, 'database'),
    mode: modeValue as QueryExecutionMode,
    cursorOffset: optionalInteger(record.cursorOffset, 'cursorOffset', 0, MAX_SQL_LENGTH),
    writeConfirmed: optionalBoolean(record.writeConfirmed, 'writeConfirmed'),
    writePreviewToken: optionalString(record.writePreviewToken, 'writePreviewToken', 8_192),
    maxRows: optionalInteger(record.maxRows, 'maxRows', 1, 10_000_000),
    timeoutSeconds: optionalInteger(record.timeoutSeconds, 'timeoutSeconds', 1, 7_200),
  };
}
