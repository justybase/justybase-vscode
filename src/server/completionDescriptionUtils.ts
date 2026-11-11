import type { CompletionItem } from "vscode-languageserver/node";
import {
  mergeCompletionDetail,
  normalizeCompletionDescription,
  toInlineCompletionDescription,
} from "../utils/completionDescriptionUtils";

export {
  mergeCompletionDetail,
  normalizeCompletionDescription,
  toInlineCompletionDescription,
} from "../utils/completionDescriptionUtils";

/**
 * Attaches a catalog comment to a completion item.
 *
 * The comment is kept as documentation (rich flyout) and folded into `detail`
 * so the suggest row shows it *next to* the type/schema/row estimate. Setting
 * `labelDetails` instead would make VS Code swap the label for a label object
 * and silently hide `detail` from the row.
 */
export function attachCompletionDescription(
  item: CompletionItem,
  description: string | undefined,
): CompletionItem {
  const documentation = normalizeCompletionDescription(description);
  if (!documentation) {
    return item;
  }
  return {
    ...item,
    documentation,
    detail: mergeCompletionDetail(item.detail, documentation),
  };
}
