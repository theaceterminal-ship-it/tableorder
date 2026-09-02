import { describe, it, expect } from "vitest";
import { validateRiderProfile, activeRiders, riderById } from "./riders";

describe("validateRiderProfile", () => {
  it("requires a name and a reachable phone", () => {
    expect(validateRiderProfile({ name: "", phone: "" })).toHaveProperty("name");
    expect(validateRiderProfile({ name: "Ramesh", phone: "123" })).toHaveProperty("phone");
    expect(validateRiderProfile({ name: "Ramesh", phone: "9876543210" })).toEqual({});
  });
});

describe("activeRiders", () => {
  const roster = [
    { id: "r1", name: "Ramesh", active: true },
    { id: "r2", name: "Suresh", active: false },
    // Riders added before "active" existed default to shown, not hidden —
    // otherwise turning this feature on would silently empty every roster.
    { id: "r3", name: "Old Roster Entry" },
  ];

  it("keeps riders marked active", () => {
    expect(activeRiders(roster).map((r) => r.id)).toEqual(["r1", "r3"]);
  });

  it("drops riders explicitly deactivated", () => {
    expect(activeRiders(roster).some((r) => r.id === "r2")).toBe(false);
  });

  it("handles an empty or missing roster", () => {
    expect(activeRiders([])).toEqual([]);
    expect(activeRiders(undefined)).toEqual([]);
  });
});

describe("riderById", () => {
  const roster = [{ id: "r1", name: "Ramesh", phone: "9876543210" }];

  it("finds the matching rider", () => {
    expect(riderById(roster, "r1")?.name).toBe("Ramesh");
  });

  it("returns null rather than undefined for a miss", () => {
    // A caller checking `if (!rider)` should not need to also know about
    // undefined vs null — this is a lookup, not an array method passthrough.
    expect(riderById(roster, "nope")).toBe(null);
    expect(riderById([], "r1")).toBe(null);
    expect(riderById(undefined, "r1")).toBe(null);
  });
});
