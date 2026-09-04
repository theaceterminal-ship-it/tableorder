import { describe, it, expect } from "vitest";
import { PAYMENT_METHODS, PAYMENT_METHOD_KEYS, isValidPaymentMethod } from "./payment-methods";

describe("payment methods", () => {
  it("exposes exactly the keys reception's own bill modal understands", () => {
    expect(PAYMENT_METHOD_KEYS).toEqual(["cash", "card", "upi", "other"]);
  });

  it("validates a real key", () => {
    for (const key of PAYMENT_METHOD_KEYS) expect(isValidPaymentMethod(key)).toBe(true);
  });

  it("refuses anything not in the list", () => {
    for (const bad of ["free", "", null, undefined, "CASH"]) {
      expect(isValidPaymentMethod(bad)).toBe(false);
    }
  });

  it("every method has an icon and a label", () => {
    PAYMENT_METHODS.forEach((m) => {
      expect(m.icon).toBeTruthy();
      expect(m.label).toBeTruthy();
    });
  });
});
