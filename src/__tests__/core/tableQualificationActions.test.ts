import {
  collectQualificationActionProposals,
  parseTableReferenceText,
  resolveQualificationPreferredIndex,
} from "../../core/tableQualificationActions";

describe("tableQualificationActions", () => {
  it("parses DB..TABLE references", () => {
    expect(parseTableReferenceText("DB1..EMPLOYEES")).toEqual({
      database: "DB1",
      name: "EMPLOYEES",
    });
  });

  it("merges suggested fix with resolver proposals", () => {
    const proposals = collectQualificationActionProposals(
      "DB1.SALES.EMPLOYEES",
      [
        {
          database: "DB1",
          schema: "ADMIN",
          name: "EMPLOYEES",
          qualifiedText: "DB1.ADMIN.EMPLOYEES",
        },
      ],
    );

    expect(proposals.map((proposal) => proposal.qualifiedText)).toEqual([
      "DB1.SALES.EMPLOYEES",
      "DB1.ADMIN.EMPLOYEES",
    ]);
    expect(proposals[0]?.isPreferred).toBe(true);
  });

  it("marks only one proposal as preferred for quick fixes", () => {
    const proposals = collectQualificationActionProposals(
      "DB1.SALES.EMPLOYEES",
      [
        {
          database: "DB1",
          schema: "ADMIN",
          name: "EMPLOYEES",
          qualifiedText: "DB1.ADMIN.EMPLOYEES",
          isPreferred: true,
        },
      ],
    );

    const preferredIndex = resolveQualificationPreferredIndex(proposals, true);
    const preferredFlags = proposals.map((_, index) => index === preferredIndex);

    expect(preferredFlags.filter(Boolean)).toHaveLength(1);
    expect(preferredIndex).toBe(0);
  });
});
