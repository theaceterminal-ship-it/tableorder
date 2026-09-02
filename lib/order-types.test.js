import { describe, it, expect } from "vitest";
import {
  ORDER_TYPES, TAKEAWAY_TABLE, DELIVERY_TABLE,
  orderTypeMeta, isDelivery, tableForOrderType, orderDestinationLabel,
  normalizePhone, validateDeliveryDetails, isDeliveryValid, formatDeliveryAddress,
  DELIVERY_STAGES, deliveryStage, nextDeliveryAction, validateRider,
  deliveryTimeline, isDeliveryComplete, isInFlightDelivery,
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

describe("the delivery lifecycle", () => {
  const base = { orderType: "delivery", status: "ready" };

  it("starts in the kitchen", () => {
    expect(deliveryStage({ orderType: "delivery", status: "preparing" })).toBe("kitchen");
  });

  it("moves through dispatched to delivered", () => {
    expect(deliveryStage({ ...base, dispatchedAt: 1 })).toBe("dispatched");
    expect(deliveryStage({ ...base, dispatchedAt: 1, deliveredAt: 2 })).toBe("delivered");
  });

  it("has no stage for a dine-in order", () => {
    expect(deliveryStage({ orderType: "dinein", status: "ready" })).toBeNull();
  });

  it("will not offer to dispatch food that is not cooked yet", () => {
    // Offering the button anyway is how orders leave before they are ready.
    expect(nextDeliveryAction({ orderType: "delivery", status: "preparing" })).toBeNull();
    expect(nextDeliveryAction({ orderType: "delivery", status: "confirmed" })).toBeNull();
  });

  it("offers dispatch once the food is ready", () => {
    expect(nextDeliveryAction(base)).toBe("dispatch");
  });

  it("offers delivered once a rider has it", () => {
    expect(nextDeliveryAction({ ...base, dispatchedAt: 1 })).toBe("deliver");
  });

  it("offers nothing once it has arrived", () => {
    expect(nextDeliveryAction({ ...base, dispatchedAt: 1, deliveredAt: 2 })).toBeNull();
  });
});

describe("validateRider", () => {
  it("accepts a rider who can be reached", () => {
    expect(validateRider({ name: "Ramesh", phone: "9876543210" })).toEqual({});
  });

  it("requires a name and a working number", () => {
    // A rider with no reachable number is the commonest reason a delivery fails.
    expect(validateRider({ phone: "9876543210" }).name).toBeTruthy();
    expect(validateRider({ name: "Ramesh" }).phone).toBeTruthy();
    expect(validateRider({ name: "Ramesh", phone: "123" }).phone).toContain("too short");
  });
});

describe("deliveryTimeline", () => {
  it("ticks everything up to where the order actually is", () => {
    const steps = deliveryTimeline({ orderType: "delivery", status: "preparing" });
    expect(steps.find((s) => s.key === "cooking").done).toBe(true);
    expect(steps.find((s) => s.key === "dispatched").done).toBe(false);
  });

  it("highlights exactly one step as active", () => {
    const steps = deliveryTimeline({ orderType: "delivery", status: "confirmed" });
    expect(steps.filter((s) => s.active)).toHaveLength(1);
    expect(steps.find((s) => s.active).key).toBe("cooking");
  });

  it("completes every step once delivered", () => {
    const steps = deliveryTimeline({ orderType: "delivery", status: "paid", dispatchedAt: 1, deliveredAt: 2 });
    expect(steps.every((s) => s.done)).toBe(true);
    expect(steps.find((s) => s.active).key).toBe("delivered");
  });
});

describe("isDeliveryComplete", () => {
  it("is complete once handed over, even before the bill is settled", () => {
    expect(isDeliveryComplete({ orderType: "delivery", status: "ready", deliveredAt: 1 })).toBe(true);
  });

  it("is complete if it was cancelled", () => {
    expect(isDeliveryComplete({ orderType: "delivery", status: "cancelled" })).toBe(true);
  });

  it("is not complete while it is still out", () => {
    expect(isDeliveryComplete({ orderType: "delivery", status: "ready", dispatchedAt: 1 })).toBe(false);
  });
});

describe("dispatch survives an interrupted bill", () => {
  const base = { orderType: "delivery" };

  it("offers dispatch once the food is ready", () => {
    expect(nextDeliveryAction({ ...base, status: "ready" })).toBe("dispatch");
  });

  it("still offers dispatch for an order already billed but not sent", () => {
    // Handing to a rider also bills the order. If that second write failed,
    // the order would otherwise lose its button and strand the food.
    expect(nextDeliveryAction({ ...base, status: "billed" })).toBe("dispatch");
  });

  it("does not offer dispatch before the food is cooked", () => {
    for (const status of ["pending", "confirmed", "preparing"]) {
      expect(nextDeliveryAction({ ...base, status })).toBe(null);
    }
  });

  it("offers delivery once dispatched, whatever the status", () => {
    expect(nextDeliveryAction({ ...base, status: "billed", dispatchedAt: 1 })).toBe("deliver");
  });

  it("offers nothing once delivered", () => {
    expect(nextDeliveryAction({ ...base, status: "paid", dispatchedAt: 1, deliveredAt: 2 })).toBe(null);
  });
});

describe("an order in flight with a rider", () => {
  const d = (extra) => ({ orderType: "delivery", ...extra });

  it("counts a dispatched order as in flight", () => {
    expect(isInFlightDelivery(d({ status: "billed", dispatchedAt: 1 }))).toBe(true);
  });

  it("stops counting once delivered", () => {
    expect(isInFlightDelivery(d({ status: "paid", dispatchedAt: 1, deliveredAt: 2 }))).toBe(false);
  });

  it("does not count an order still in the kitchen", () => {
    expect(isInFlightDelivery(d({ status: "ready" }))).toBe(false);
  });

  it("never counts a dine-in order", () => {
    expect(isInFlightDelivery({ orderType: "dinein", status: "billed" })).toBe(false);
  });
});
