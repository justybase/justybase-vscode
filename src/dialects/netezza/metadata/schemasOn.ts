import type { DatabaseConnection } from "../../../contracts/database";

const SHOW_SCHEMAS_ENABLED_SQL = "SHOW ENABLE_SCHEMA_DBO_CHECK";

/**
 * Parses Netezza NOTICE text from `SHOW ENABLE_SCHEMA_DBO_CHECK`.
 * Last character `0` means schemas disabled (owner mode); otherwise enabled.
 */
export function parseSchemasEnabledFromNotice(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return trimmed[trimmed.length - 1] !== "0";
}

/**
 * Detects whether Netezza schema mode is enabled on the live connection.
 * Response arrives as a server NOTICE, not as a result set.
 */
export async function detectNetezzaSchemasEnabled(
  connection: DatabaseConnection,
): Promise<boolean> {
  const notices: string[] = [];

  const noticeHandler = (msg: unknown): void => {
    const notification = msg as { message?: unknown };
    if (typeof notification.message === "string") {
      notices.push(notification.message);
    }
  };

  connection.on("notice", noticeHandler);

  try {
    const command = connection.createCommand(SHOW_SCHEMAS_ENABLED_SQL);
    const reader = await command.executeReader();
    try {
      while (await reader.read()) {
        // Drain reader; value is captured from NOTICE events.
      }
    } finally {
      await reader.close();
    }
  } catch {
    return false;
  } finally {
    connection.removeListener("notice", noticeHandler);
  }

  if (notices.length === 0) {
    return false;
  }

  return parseSchemasEnabledFromNotice(notices[notices.length - 1]);
}
