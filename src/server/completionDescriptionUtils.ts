import type { CompletionItem } from "vscode-languageserver/node";
import {
  normalizeCompletionDescription,
  toInlineCompletionDescription,
} from "../utils/completionDescriptionUtils";

export {
  normalizeCompletionDescription,
  toInlineCompletionDescription,
} from "../utils/completionDescriptionUtils";

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
    labelDetails: {
      ...item.labelDetails,
      description: toInlineCompletionDescription(documentation),
    },
  };
}
