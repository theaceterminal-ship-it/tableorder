import { describe, it, expect } from "vitest";
import {
  ORDER_TYPES, TAKEAWAY_TABLE, DELIVERY_TABLE,
  orderTypeMeta, isDelivery, tableForOrderType, orderDestinationLabel,
  normalizePhone, validateDeliveryDetails, isDeliveryValid, formatDeliveryAddress,
} from "./order-types";

describe("order types", () => {
  it("gives delivery its own identity, not takeaway's", () => {
    // One is collected at the counter, the other leaves with a rider. Packing
    // them the same way is how cold food goes out.
    expect(orderTypeMeta("delivery").label).toBe("Delivery");
    expect(orderTypeMeta("takeaway").label).toBe("Takeaway");
    expect(orderTypeMeta("delivery").color).not.toBe(orderTypeMeta("takeaway").color);
  });

  it("falls back to dine-in for anything unrecognised", () => {
    expect(orderTypeMeta(undefined).label).toBe("Dine-in");
    expect(orderTypeMeta("nonsense").label).toBe("Dine-in");
  });

  it("uses placeholders for orders with no seat", () => {
    expect(tableForOrderType(ORDER_TYPES.TAKEAWAY, 5)).toBe(TAKEAWAY_TABLE);
    expect(tableForOrderType(ORDER_TYPES.DELIVERY, 5)).toBe(DELIVERY_TABLE);
    expect(tableForOrderType(ORDER_TYPES.DINE_IN, 5)).toBe(5);
  });

  it("labels each destination distinctly", () => {
    expect(orderDestinationLabel({ orderType: "delivery" })).toContain("Delivery");
    expect(orderDestinationLabel({ orderType: "takeaway" })).toContain("Takeaway");
    expect(orderDestinationLabel({ orderType: "dinein", table: 4 })).toBe("Table 4");
  });

  it("identifies delivery orders", () => {
    expect(isDelivery({ orderType: "delivery" })).toBe(true);
    expect(isDelivery({ orderType: "takeaway" })).toBe(false);
    expect(isDelivery(null)).toBe(false);
  });
});

describe("normalizePhone", () => {
  it("keeps only the digits", () => {
    expect(normalizePhone("+91 98765-43210")).toBe("919876543210");
    expect(normalizePhone("(022) 1234 5678")).toBe("02212345678");
  });

  it("handles nothing", () => {
    expect(normalizePhone(null)).toBe("");
  });
});

describe("validateDeliveryDetails", () => {
  const good = { name: "Asha", phone: "9876543210", address: "12 Hill Road, Bandra West" };

  it("accepts a complete address", () => {
    expect(validateDeliveryDetails(good)).toEqual({});
    expect(isDeliveryValid(good)).toBe(true);
  });

  it("requires a name", () => {
    expect(validateDeliveryDetails({ ...good, name: "  " }).name).toBeTruthy();
  });

  it("requires a phone the kitchen can actually call", () => {
    expect(validateDeliveryDetails({ ...good, phone: "" }).phone).toBeTruthy();
    expect(validateDeliveryDetails({ ...good, phone: "12345" }).phone).toContain("too short");
  });

  it("accepts a country code rather than rejecting +91", () => {
    expect(validateDeliveryDetails({ ...good, phone: "+91 98765 43210" }).phone).toBeUndefined();
  });

  it("rejects a phone number that is far too long", () => {
    expect(validateDeliveryDetails({ ...good, phone: "12345678901234567" }).phone).toContain("too long");
  });

  it("refuses a half-written address at the door", () => {
    // A rider cannot deliver to "near park", and finding that out twenty
    // minutes later is a reception problem.
    expect(validateDeliveryDetails({ ...good, address: "" }).address).toBeTruthy();
    expect(validateDeliveryDetails({ ...good, address: "near park" }).address).toContain("fuller address");
  });

  it("reports every problem at once rather than one at a time", () => {
    const errors = validateDeliveryDetails({});
    expect(Object.keys(errors).sort()).toEqual(["address", "name", "phone"]);
  });
});

describe("formatDeliveryAddress", () => {
  it("joins the landmark on when there is one", () => {
    expect(formatDeliveryAddress({ address: "12 Hill Road", landmark: "Opp. bakery" }))
      .toBe("12 Hill Road · Opp. bakery");
  });

  it("omits an empty landmark cleanly", () => {
    expect(formatDeliveryAddress({ address: "12 Hill Road" })).toBe("12 Hill Road");
    expect(formatDeliveryAddress({})).toBe("");
  });
});
