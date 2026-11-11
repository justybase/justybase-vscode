import { describe, expect, it } from "@jest/globals";
import {
  mergeCompletionDetail,
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

  describe("mergeCompletionDetail", () => {
    it("appends the comment after the structured detail", () => {
      expect(mergeCompletionDetail("INTEGER", "Primary key"))
        .toBe("INTEGER · Primary key");
      expect(mergeCompletionDetail("TABLE (PUBLIC) · ~4k rows", "test comment"))
        .toBe("TABLE (PUBLIC) · ~4k rows · test comment");
    });

    it("falls back to whichever side is present", () => {
      expect(mergeCompletionDetail(undefined, "Only a comment"))
        .toBe("Only a comment");
      expect(mergeCompletionDetail("DECIMAL(18,2)", undefined))
        .toBe("DECIMAL(18,2)");
      expect(mergeCompletionDetail("  ", "   ")).toBeUndefined();
    });

    it("trims both sides and truncates an overlong comment", () => {
      expect(mergeCompletionDetail(" VARCHAR(10) ", "  padded  "))
        .toBe("VARCHAR(10) · padded");
      const long = mergeCompletionDetail("INTEGER", "y".repeat(120));
      expect(long).toBe(`INTEGER · ${"y".repeat(95)}…`);
    });
  });
});
