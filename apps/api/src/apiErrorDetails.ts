import type { ApiError } from '@justybase/contracts';
import { extractDatabaseErrorDetails } from '@justybase/database-runtime';

/**
 * Builds an API error body.
 *
 * The API keeps its own error namespace: `code` stays a stable contract value
 * such as `EDIT_REJECTED`. When the underlying failure carries backend
 * diagnostics they travel in `errorDetails`, whose `code` is the SQLSTATE and
 * has no relation to the API code.
 */
export function apiErrorBody(code: string, message: string, error?: unknown): ApiError {
  const errorDetails = error === undefined ? undefined : extractDatabaseErrorDetails(error);
  return {
    code,
    message,
    ...(errorDetails === undefined ? {} : { errorDetails }),
  };
}
