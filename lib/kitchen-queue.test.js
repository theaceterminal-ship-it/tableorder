import { describe, it, expect } from "vitest";
import {
  kitchenQueue, hasOpenStove, nextToAutoStart,
  MAX_CONCURRENT_PREPARING,
} from "./kitchen-queue";

const o = (id, createdAt, isVIP = false) => ({ id, createdAt, isVIP });

describe("kitchenQueue", () => {
  it("cooks oldest first", () => {
    expect(kitchenQueue([o("b", 200), o("a", 100), o("c", 300)]).map((x) => x.id))
      .toEqual(["a", "b", "c"]);
  });

  it("puts VIP ahead of everything, even later arrivals", () => {
    expect(kitchenQueue([o("a", 100), o("vip", 500, true), o("b", 200)]).map((x) => x.id))
      .toEqual(["vip", "a", "b"]);
  });

  it("keeps VIPs among themselves in arrival order", () => {
    expect(kitchenQueue([o("v2", 300, true), o("v1", 100, true)]).map((x) => x.id))
      .toEqual(["v1", "v2"]);
  });

  it("does not mutate its input", () => {
    const input = [o("b", 200), o("a", 100)];
    kitchenQueue(input);
    expect(input[0].id).toBe("b");
  });

  it("survives nothing", () => {
    expect(kitchenQueue(null)).toEqual([]);
  });
});

describe("hasOpenStove", () => {
  it("is open below the cap and closed at it", () => {
    expect(hasOpenStove(MAX_CONCURRENT_PREPARING - 1)).toBe(true);
    expect(hasOpenStove(MAX_CONCURRENT_PREPARING)).toBe(false);
    expect(hasOpenStove(MAX_CONCURRENT_PREPARING + 1)).toBe(false);
  });
});

describe("nextToAutoStart", () => {
  const confirmed = [o("a", 100), o("b", 200), o("vip", 300, true)];

  it("picks the front of the queue when a stove is free", () => {
    expect(nextToAutoStart({ confirmed, preparingCount: 2 }).id).toBe("vip");
  });

  it("starts nothing when every stove is busy", () => {
    expect(nextToAutoStart({ confirmed, preparingCount: MAX_CONCURRENT_PREPARING })).toBeNull();
  });

  it("starts nothing when the queue is empty", () => {
    expect(nextToAutoStart({ confirmed: [], preparingCount: 0 })).toBeNull();
  });

  it("skips orders that already failed, so a denied write is not retried forever", () => {
    // This is the loop that hammered Firestore: a rejected write rolls back the
    // local cache, which re-triggers the effect, which retries the same order.
    expect(nextToAutoStart({ confirmed, preparingCount: 0, skipIds: ["vip"] }).id).toBe("a");
    expect(nextToAutoStart({ confirmed, preparingCount: 0, skipIds: ["vip", "a", "b"] })).toBeNull();
  });

  it("fills exactly one slot at a time, so the backlog drains in order", () => {
    // Called repeatedly as slots free, it walks the queue rather than dumping
    // everything onto the stove at once.
    const started = [];
    let count = 3;
    for (let i = 0; i < 3; i++) {
      const next = nextToAutoStart({ confirmed, preparingCount: count, skipIds: started });
      if (!next) break;
      started.push(next.id);
      count += 1;
    }
    expect(started).toEqual(["vip", "a"]); // stops at the cap of 5
  });
});
