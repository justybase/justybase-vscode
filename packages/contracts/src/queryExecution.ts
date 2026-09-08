import type { QueryColumn } from './webApi';

/** A running database command exposed to product-level cancellation controls. */
export interface DatabaseQueryCommand {
  cancel(): Promise<void>;
}

/** Streaming callbacks shared by Node database runtimes and product adapters. */
export interface DatabaseQueryCallbacks {
  onColumns(columns: QueryColumn[]): void;
  onRows(rows: unknown[][], totalRows: number): void;
  onCommand(command: DatabaseQueryCommand): void;
}

/** Product-neutral execution limits and safety context. */
export interface DatabaseQueryOptions {
  maxRows: number;
  timeoutSeconds: number;
  readOnly?: boolean;
  database?: string;
}

/** Summary returned after a streamed database execution completes. */
export interface DatabaseQueryResult {
  totalRows: number;
  limitReached: boolean;
  rowsAffected?: number;
}
