import { describe, it, expect } from "vitest";
import {
  slugify, validateSlug, isOpenAt, todayHoursLabel,
  deliveryFeeFor, shortfallToMinimum, shortfallToFreeDelivery,
  orderingBlockedReason, blockedMessage, publicOrderUrl, DEFAULT_HOURS,
} from "./website-setup";

// Tue 1 Sep 2026 by default. Month is explicit because new Date(2026, 8, 31)
// is "31 September", which silently rolls into October and lands on a
// different weekday — which is exactly what this suite is testing.
const at = (h, m = 0, day = 1, month = 8) => new Date(2026, month, day, h, m);
const MON_31_AUG = 7; // month index for August

describe("slugify", () => {
  it("makes a predictable web address from a name", () => {
    expect(slugify("Spice Garden")).toBe("spice-garden");
    expect(slugify("  Café  Delhi!!  ")).toBe("caf-delhi");
  });

  it("collapses runs of separators rather than leaving empty segments", () => {
    expect(slugify("A -- B")).toBe("a-b");
  });

  it("caps the length", () => {
    expect(slugify("x".repeat(80)).length).toBe(40);
  });
});

describe("validateSlug", () => {
  it("accepts a clean slug", () => {
    expect(validateSlug("spice-garden")).toBeNull();
  });

  it("rejects an empty or short one", () => {
    expect(validateSlug("")).toBeTruthy();
    expect(validateSlug("ab")).toContain("Too short");
  });

  it("rejects capitals and spaces", () => {
    expect(validateSlug("Spice Garden")).toContain("lowercase");
  });

  it("refuses slugs that would shadow real routes", () => {
    // A restaurant claiming "login" would make staff sign-in unreachable.
    expect(validateSlug("login")).toContain("reserved");
    expect(validateSlug("order")).toContain("reserved");
  });
});

describe("isOpenAt", () => {
  const hours = { ...DEFAULT_HOURS };

  it("is open during service and closed outside it", () => {
    expect(isOpenAt(hours, at(13))).toBe(true);
    expect(isOpenAt(hours, at(9))).toBe(false);
    expect(isOpenAt(hours, at(23, 30))).toBe(false);
  });

  it("respects a day marked closed", () => {
    const closedTue = { ...hours, tue: { open: "11:00", close: "23:00", closed: true } };
    expect(isOpenAt(closedTue, at(13))).toBe(false);
  });

  it("handles a service that runs past midnight", () => {
    // 18:00–01:00 means half past midnight is still inside the PREVIOUS day's
    // service, which is how most late kitchens actually work.
    const late = { ...DEFAULT_HOURS, mon: { open: "18:00", close: "01:00", closed: false } };
    expect(isOpenAt(late, at(23, 0, 31, MON_31_AUG))).toBe(true); // Mon 31 Aug, 11pm
    expect(isOpenAt(late, at(0, 30, 1))).toBe(true);              // Tue 1 Sep, 00:30 — still Monday's service
    expect(isOpenAt(late, at(2, 0, 1))).toBe(false);              // Tue 02:00 — shut
  });

  it("is closed when hours are missing entirely", () => {
    expect(isOpenAt(undefined, at(13))).toBe(false);
    expect(isOpenAt({}, at(13))).toBe(false);
  });
});

describe("todayHoursLabel", () => {
  it("states today's hours", () => {
    expect(todayHoursLabel(DEFAULT_HOURS, at(13))).toBe("Open 11:00 – 23:00");
  });

  it("says so when shut", () => {
    const closed = { ...DEFAULT_HOURS, tue: { closed: true } };
    expect(todayHoursLabel(closed, at(13))).toBe("Closed today");
  });
});

describe("delivery charges", () => {
  const site = { deliveryFee: 40, freeDeliveryAbove: 500, minimumOrder: 200 };

  it("charges the fee below the free threshold", () => {
    expect(deliveryFeeFor(300, site)).toBe(40);
  });

  it("waives it at the threshold, not merely above it", () => {
    // The banner says "free above ₹500"; at exactly 500 the customer expects free.
    expect(deliveryFeeFor(500, site)).toBe(0);
    expect(deliveryFeeFor(600, site)).toBe(0);
  });

  it("charges nothing when no fee is configured", () => {
    expect(deliveryFeeFor(100, { deliveryFee: 0 })).toBe(0);
  });

  it("reports how far short of the minimum an order is", () => {
    expect(shortfallToMinimum(150, site)).toBe(50);
    expect(shortfallToMinimum(200, site)).toBe(0);
  });

  it("reports how far short of free delivery an order is", () => {
    expect(shortfallToFreeDelivery(420, site)).toBe(80);
    expect(shortfallToFreeDelivery(500, site)).toBe(0);
    expect(shortfallToFreeDelivery(100, { deliveryFee: 0 })).toBe(0);
  });
});

describe("orderingBlockedReason", () => {
  const open = { enabled: true, deliveryEnabled: true, pickupEnabled: true, minimumOrder: 200, hours: DEFAULT_HOURS };

  it("allows a valid delivery order during service", () => {
    expect(orderingBlockedReason({ website: open, subtotal: 300, at: at(13) })).toBeNull();
  });

  it("blocks when the site is switched off", () => {
    expect(orderingBlockedReason({ website: { ...open, enabled: false }, subtotal: 300, at: at(13) })).toBe("site-off");
  });

  it("blocks delivery specifically without blocking pickup", () => {
    const noDelivery = { ...open, deliveryEnabled: false };
    expect(orderingBlockedReason({ website: noDelivery, subtotal: 300, mode: "delivery", at: at(13) })).toBe("delivery-off");
    expect(orderingBlockedReason({ website: noDelivery, subtotal: 300, mode: "pickup", at: at(13) })).toBeNull();
  });

  it("blocks outside opening hours", () => {
    expect(orderingBlockedReason({ website: open, subtotal: 300, at: at(4) })).toBe("closed");
  });

  it("blocks below the delivery minimum, but not for pickup", () => {
    expect(orderingBlockedReason({ website: open, subtotal: 150, mode: "delivery", at: at(13) })).toBe("below-minimum");
    expect(orderingBlockedReason({ website: open, subtotal: 150, mode: "pickup", at: at(13) })).toBeNull();
  });
});

describe("blockedMessage", () => {
  it("tells the customer exactly how much more they need", () => {
    const msg = blockedMessage("below-minimum", { website: { minimumOrder: 200 }, subtotal: 150 });
    expect(msg).toContain("₹50");
    expect(msg).toContain("₹200");
  });

  it("has a sentence for every reason", () => {
    for (const r of ["site-off", "delivery-off", "pickup-off", "closed"]) {
      expect(blockedMessage(r, { website: {} })).toBeTruthy();
    }
  });

  it("says nothing when nothing is wrong", () => {
    expect(blockedMessage(null, {})).toBeNull();
  });
});

describe("publicOrderUrl", () => {
  it("prefers the restaurant's own slug", () => {
    expect(publicOrderUrl("https://cabadra.app", { slug: "spice-garden", outletId: "o1" }))
      .toBe("https://cabadra.app/r/spice-garden");
  });

  it("falls back to the outlet id before a slug is chosen", () => {
    expect(publicOrderUrl("https://cabadra.app", { outletId: "o1" }))
      .toBe("https://cabadra.app/order?restaurant=o1");
  });
});
