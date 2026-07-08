import { describe, expect, it } from "@jest/globals";
import {
  normalizeCompletionDescription,
  toInlineCompletionDescription,
} from "../../utils/completionDescriptionUtils";

describe("completionDescriptionUtils", () => {
  it("trims and rejects empty descriptions", () => {
    expect(normalizeCompletionDescription("  hello  ")).toBe("hello");
    expect(normalizeCompletionDescription("")).toBeUndefined();
    expect(normalizeCompletionDescription("   ")).toBeUndefined();
  });

  it("truncates long inline descriptions", () => {
    const long = "x".repeat(120);
    const inline = toInlineCompletionDescription(long);
    expect(inline).toBeDefined();
    expect(inline!.length).toBe(96);
    expect(inline!.endsWith("…")).toBe(true);
  });
});
