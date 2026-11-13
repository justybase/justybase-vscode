jest.unmock("chevrotain");

import { SqlVisitor } from "../src/validation/visitor/sqlVisitorCore";

describe("SqlVisitor construction", () => {
  it("validates the visitor rule surface once per class", () => {
    let validations = 0;

    class ProbeVisitor extends SqlVisitor {
      public override validateVisitor(): void {
        validations += 1;
        super.validateVisitor();
      }
    }

    new ProbeVisitor();
    new ProbeVisitor();
    new ProbeVisitor();

    expect(validations).toBe(1);
  });
});
