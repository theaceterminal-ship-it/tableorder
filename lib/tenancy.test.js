import { describe, it, expect } from "vitest";
import {
  ROLES,
  TIERS,
  canAddOutlet,
  tierLimits,
  roleHasCapability,
  resolveAccess,
  canAccessOutlet,
  can,
  canInvite,
  effectiveMenu,
  sanitizeOverride,
} from "./tenancy";

const BANDRA = "o_bandra";
const ANDHERI = "o_andheri";
const PUNE = "o_pune";

const owner = resolveAccess({ brandId: "b1", brandMember: { role: ROLES.BRAND_OWNER } });
const brandManager = resolveAccess({ brandId: "b1", brandMember: { role: ROLES.BRAND_MANAGER } });
const outletManager = resolveAccess({
  brandId: "b1",
  brandMember: { role: ROLES.OUTLET_MANAGER, outletIds: [BANDRA, ANDHERI] },
});
const reception = resolveAccess({ brandId: "b1", outletStaff: [{ outletId: BANDRA, role: ROLES.RECEPTION }] });
const kitchen = resolveAccess({ brandId: "b1", outletStaff: [{ outletId: BANDRA, role: ROLES.KITCHEN }] });
const platformAdmin = resolveAccess({ isPlatformAdmin: true });
const nobody = resolveAccess({});

describe("tiers", () => {
  it("caps a single-outlet plan at one outlet", () => {
    expect(canAddOutlet(TIERS.SINGLE, 0)).toBe(true);
    expect(canAddOutlet(TIERS.SINGLE, 1)).toBe(false);
  });

  it("lets a multi-outlet plan grow to its ceiling", () => {
    expect(canAddOutlet(TIERS.MULTI, 24)).toBe(true);
    expect(canAddOutlet(TIERS.MULTI, 25)).toBe(false);
  });

  it("does not cap enterprise", () => {
    expect(canAddOutlet(TIERS.ENTERPRISE, 500)).toBe(true);
  });

  it("falls back to single-outlet limits for an unknown tier", () => {
    expect(tierLimits("nonsense").maxOutlets).toBe(1);
    expect(canAddOutlet(undefined, 1)).toBe(false);
  });

  it("withholds the brand console from single-outlet", () => {
    expect(tierLimits(TIERS.SINGLE).brandConsole).toBe(false);
    expect(tierLimits(TIERS.MULTI).brandConsole).toBe(true);
  });
});

describe("resolveAccess", () => {
  it("gives an owner every outlet without listing them", () => {
    expect(owner.role).toBe(ROLES.BRAND_OWNER);
    expect(owner.allOutlets).toBe(true);
  });

  it("scopes an outlet manager to their assigned outlets", () => {
    expect(outletManager.allOutlets).toBe(false);
    expect(outletManager.outletIds).toEqual([BANDRA, ANDHERI]);
  });

  it("resolves floor staff from their outlet documents", () => {
    expect(reception.role).toBe(ROLES.RECEPTION);
    expect(reception.scope).toBe("outlet");
    expect(reception.outletIds).toEqual([BANDRA]);
  });

  it("takes the highest role when someone is rostered at several outlets", () => {
    const both = resolveAccess({
      outletStaff: [
        { outletId: BANDRA, role: ROLES.KITCHEN },
        { outletId: ANDHERI, role: ROLES.RECEPTION },
      ],
    });
    expect(both.role).toBe(ROLES.RECEPTION);
    expect(both.outletIds).toEqual([BANDRA, ANDHERI]);
  });

  it("prefers a brand membership over an outlet staff document", () => {
    const dual = resolveAccess({
      brandMember: { role: ROLES.OUTLET_MANAGER, outletIds: [BANDRA] },
      outletStaff: [{ outletId: BANDRA, role: ROLES.KITCHEN }],
    });
    expect(dual.role).toBe(ROLES.OUTLET_MANAGER);
  });

  it("returns no role for a stranger", () => {
    expect(nobody.role).toBeNull();
    expect(nobody.scope).toBe("none");
  });

  it("ignores an unrecognised role rather than trusting it", () => {
    const bogus = resolveAccess({ brandMember: { role: "super_admin" } });
    expect(bogus.role).toBeNull();
  });

  it("never derives authority from users/{uid}.role", () => {
    // The subject can edit their own user document, so it must not be an input.
    const spoofed = resolveAccess({ brandMember: null, outletStaff: [], role: ROLES.BRAND_OWNER });
    expect(spoofed.role).toBeNull();
  });
});

describe("canAccessOutlet", () => {
  it("lets an owner reach any outlet, including new ones", () => {
    expect(canAccessOutlet(owner, PUNE)).toBe(true);
  });

  it("stops an outlet manager reaching an unassigned outlet", () => {
    expect(canAccessOutlet(outletManager, BANDRA)).toBe(true);
    expect(canAccessOutlet(outletManager, PUNE)).toBe(false);
  });

  it("keeps reception inside their own outlet", () => {
    expect(canAccessOutlet(reception, BANDRA)).toBe(true);
    expect(canAccessOutlet(reception, ANDHERI)).toBe(false);
  });

  it("does not let a platform admin operate an outlet", () => {
    expect(canAccessOutlet(platformAdmin, BANDRA)).toBe(false);
  });

  it("denies a stranger", () => {
    expect(canAccessOutlet(nobody, BANDRA)).toBe(false);
  });
});

describe("capabilities", () => {
  it("reserves brand approval for the platform admin", () => {
    expect(can(platformAdmin, "approveBrand")).toBe(true);
    expect(can(owner, "approveBrand")).toBe(false);
  });

  it("reserves outlet creation and billing for the owner", () => {
    expect(can(owner, "createOutlet")).toBe(true);
    expect(can(outletManager, "createOutlet")).toBe(false);
    expect(can(brandManager, "manageBilling")).toBe(false);
  });

  it("keeps the master menu owner-only", () => {
    expect(can(owner, "editMasterMenu")).toBe(true);
    expect(can(outletManager, "editMasterMenu")).toBe(false);
  });

  it("lets an outlet manager set local prices, but only where they reach", () => {
    expect(can(outletManager, "editOutletMenu", BANDRA)).toBe(true);
    expect(can(outletManager, "editOutletMenu", PUNE)).toBe(false);
  });

  it("makes the brand manager read-only", () => {
    expect(can(brandManager, "viewAllOutletReports")).toBe(true);
    expect(can(brandManager, "operatePos")).toBe(false);
    expect(can(brandManager, "editOutletMenu")).toBe(false);
  });

  it("limits kitchen to the kitchen board", () => {
    expect(can(kitchen, "viewKitchen", BANDRA)).toBe(true);
    expect(can(kitchen, "operatePos", BANDRA)).toBe(false);
  });

  it("denies an unknown capability instead of allowing it", () => {
    expect(roleHasCapability(ROLES.BRAND_OWNER, "launchMissiles")).toBe(false);
    expect(can(owner, "launchMissiles")).toBe(false);
  });
});

describe("canInvite", () => {
  it("lets an owner invite a manager for any outlet", () => {
    expect(canInvite(owner, ROLES.OUTLET_MANAGER, [BANDRA, PUNE])).toBe(true);
  });

  it("lets a manager invite floor staff for their own outlets", () => {
    expect(canInvite(outletManager, ROLES.RECEPTION, [BANDRA])).toBe(true);
    expect(canInvite(outletManager, ROLES.KITCHEN, [ANDHERI])).toBe(true);
  });

  it("stops a manager granting access to an outlet they do not hold", () => {
    expect(canInvite(outletManager, ROLES.RECEPTION, [PUNE])).toBe(false);
    expect(canInvite(outletManager, ROLES.RECEPTION, [BANDRA, PUNE])).toBe(false);
  });

  it("stops a manager creating another manager", () => {
    expect(canInvite(outletManager, ROLES.OUTLET_MANAGER, [BANDRA])).toBe(false);
  });

  it("stops anyone granting a role at or above their own", () => {
    expect(canInvite(owner, ROLES.BRAND_OWNER, [BANDRA])).toBe(false);
    expect(canInvite(outletManager, ROLES.BRAND_MANAGER, [BANDRA])).toBe(false);
  });

  it("stops reception inviting anyone at all", () => {
    expect(canInvite(reception, ROLES.KITCHEN, [BANDRA])).toBe(false);
  });

  it("rejects a grant that names no outlets", () => {
    expect(canInvite(owner, ROLES.RECEPTION, [])).toBe(false);
  });

  it("rejects an unknown target role", () => {
    expect(canInvite(owner, "super_admin", [BANDRA])).toBe(false);
  });
});

describe("effectiveMenu", () => {
  const master = [
    { id: "paneer", name: "Paneer Tikka", price: 280, available: true },
    { id: "naan", name: "Butter Naan", price: 60, available: true },
    { id: "dal", name: "Dal Makhani", price: 320, available: true },
  ];

  it("returns the master menu untouched when there are no overrides", () => {
    expect(effectiveMenu(master, {})).toEqual(master);
  });

  it("applies a local price without touching the master", () => {
    const menu = effectiveMenu(master, { paneer: { price: 320 } });
    expect(menu.find((m) => m.id === "paneer").price).toBe(320);
    expect(master[0].price).toBe(280); // master unchanged
  });

  it("applies a local availability flag", () => {
    const menu = effectiveMenu(master, { dal: { available: false } });
    expect(menu.find((m) => m.id === "dal").available).toBe(false);
  });

  it("removes an item hidden at this outlet", () => {
    const menu = effectiveMenu(master, { naan: { hidden: true } });
    expect(menu.map((m) => m.id)).toEqual(["paneer", "dal"]);
  });

  it("flags overridden items so the console can surface local edits", () => {
    const menu = effectiveMenu(master, { paneer: { price: 320 } });
    expect(menu.find((m) => m.id === "paneer").hasLocalOverride).toBe(true);
    expect(menu.find((m) => m.id === "dal").hasLocalOverride).toBeUndefined();
  });

  it("survives an empty master menu", () => {
    expect(effectiveMenu([], { paneer: { price: 1 } })).toEqual([]);
    expect(effectiveMenu(null, {})).toEqual([]);
  });
});

describe("sanitizeOverride", () => {
  it("keeps only the fields an outlet may change", () => {
    expect(sanitizeOverride({ price: 320, available: false, hidden: true })).toEqual({
      price: 320, available: false, hidden: true,
    });
  });

  it("drops brand-controlled fields a branch must not edit", () => {
    expect(sanitizeOverride({ price: 320, name: "Renamed", category: "Other", imageUrl: "x" }))
      .toEqual({ price: 320 });
  });

  it("returns nothing for empty input", () => {
    expect(sanitizeOverride(null)).toEqual({});
    expect(sanitizeOverride({})).toEqual({});
  });
});
