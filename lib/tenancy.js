// lib/tenancy.js
//
// Who someone is, what they can reach, and what a menu actually costs at a
// given outlet. Pure functions over plain data — no Firestore, no React — so
// the permission model can be tested exhaustively instead of discovered in
// production.
//
// The model, in one breath: an ORG owns BRANDS, a brand owns OUTLETS, and a
// person holds a membership at either the brand level or the outlet level.
// Outlets keep the document path they already have (`restaurants/{outletId}`),
// which is why printed QR codes survive the restructure.

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

export const TIERS = {
  SINGLE: "single",
  MULTI: "multi",
  ENTERPRISE: "enterprise",
};

export const TIER_LABELS = {
  single: "Single Outlet",
  multi: "Multi-Outlet",
  enterprise: "Enterprise",
};

// maxOutlets is the hard ceiling the brand console enforces when someone tries
// to add another outlet. Enterprise is uncapped because those deals are priced
// individually — see The Chain Blueprint.
export const TIER_LIMITS = {
  single: { maxOutlets: 1, brandConsole: false, masterMenu: false, managers: false },
  multi: { maxOutlets: 25, brandConsole: true, masterMenu: true, managers: true },
  enterprise: { maxOutlets: Infinity, brandConsole: true, masterMenu: true, managers: true },
};

export function tierLimits(tier) {
  return TIER_LIMITS[tier] || TIER_LIMITS.single;
}

export function canAddOutlet(tier, currentOutletCount) {
  return currentOutletCount < tierLimits(tier).maxOutlets;
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const ROLES = {
  PLATFORM_ADMIN: "platform_admin",
  BRAND_OWNER: "brand_owner",
  BRAND_MANAGER: "brand_manager",
  OUTLET_MANAGER: "outlet_manager",
  RECEPTION: "reception",
  KITCHEN: "kitchen",
};

// Roles stored on a brand membership vs. on an outlet staff document. Where a
// role lives determines how far it reaches, so the two sets must not overlap.
export const BRAND_ROLES = [ROLES.BRAND_OWNER, ROLES.BRAND_MANAGER, ROLES.OUTLET_MANAGER];
export const OUTLET_ROLES = [ROLES.RECEPTION, ROLES.KITCHEN];

export const ROLE_LABELS = {
  platform_admin: "Platform Admin",
  brand_owner: "Owner",
  brand_manager: "Brand Manager",
  outlet_manager: "Outlet Manager",
  reception: "Reception",
  kitchen: "Kitchen",
};

// Strictly ordered. An inviter may only grant a role BELOW their own, which is
// the single constraint that stops a manager promoting themselves or a peer.
export const ROLE_RANK = {
  platform_admin: 100,
  brand_owner: 80,
  brand_manager: 60,
  outlet_manager: 40,
  reception: 20,
  kitchen: 10,
};

export function roleRank(role) {
  return ROLE_RANK[role] ?? 0;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

// The permission matrix from The Chain Blueprint, as data. Anything not listed
// is denied — there is no implicit inheritance, because "manager inherits
// everything reception can do" is exactly how privilege creeps in unnoticed.
export const CAPABILITIES = {
  approveBrand: [ROLES.PLATFORM_ADMIN],
  manageBilling: [ROLES.PLATFORM_ADMIN, ROLES.BRAND_OWNER],
  createOutlet: [ROLES.BRAND_OWNER],
  inviteManager: [ROLES.BRAND_OWNER],
  inviteFloorStaff: [ROLES.BRAND_OWNER, ROLES.OUTLET_MANAGER],
  editMasterMenu: [ROLES.BRAND_OWNER],
  editOutletMenu: [ROLES.BRAND_OWNER, ROLES.OUTLET_MANAGER],
  viewAllOutletReports: [ROLES.BRAND_OWNER, ROLES.BRAND_MANAGER, ROLES.OUTLET_MANAGER],
  operatePos: [ROLES.BRAND_OWNER, ROLES.OUTLET_MANAGER, ROLES.RECEPTION],
  viewKitchen: [ROLES.BRAND_OWNER, ROLES.OUTLET_MANAGER, ROLES.RECEPTION, ROLES.KITCHEN],
};

export function roleHasCapability(role, capability) {
  const allowed = CAPABILITIES[capability];
  if (!allowed) return false; // unknown capability is denied, never allowed
  return allowed.includes(role);
}

// ---------------------------------------------------------------------------
// Access resolution
// ---------------------------------------------------------------------------

/**
 * Turn raw membership documents into one access object.
 *
 * Callers pass what they read from Firestore:
 *   brandMember  — brands/{brandId}/members/{uid}, or null
 *   outletStaff  — [{ outletId, role }] from restaurants/{o}/staff/{uid}
 *   isPlatformAdmin — platformAdmins/{uid} exists
 *
 * Deliberately does NOT accept users/{uid}.role. That document is editable by
 * its own subject, so trusting it for authorization would let anyone promote
 * themselves. It is a routing hint and nothing more.
 */
export function resolveAccess({ isPlatformAdmin = false, brandId = null, brandMember = null, outletStaff = [] } = {}) {
  if (isPlatformAdmin) {
    return { role: ROLES.PLATFORM_ADMIN, scope: "platform", brandId: null, outletIds: [], allOutlets: true };
  }

  if (brandMember && BRAND_ROLES.includes(brandMember.role)) {
    // An owner or brand manager reaches every outlet in the brand; an outlet
    // manager reaches exactly the outlets they were assigned.
    const reachesAll = brandMember.role === ROLES.BRAND_OWNER || brandMember.role === ROLES.BRAND_MANAGER;
    return {
      role: brandMember.role,
      scope: "brand",
      brandId,
      outletIds: reachesAll ? [] : [...(brandMember.outletIds || [])],
      allOutlets: reachesAll,
    };
  }

  const staffEntries = (outletStaff || []).filter((s) => s && OUTLET_ROLES.includes(s.role));
  if (staffEntries.length > 0) {
    // Floor staff can in principle be rostered at more than one outlet; the
    // effective role is the highest they hold.
    const best = staffEntries.reduce((a, b) => (roleRank(b.role) > roleRank(a.role) ? b : a));
    return {
      role: best.role,
      scope: "outlet",
      brandId,
      outletIds: staffEntries.map((s) => s.outletId),
      allOutlets: false,
    };
  }

  return { role: null, scope: "none", brandId, outletIds: [], allOutlets: false };
}

export function canAccessOutlet(access, outletId) {
  if (!access || !access.role) return false;
  if (access.role === ROLES.PLATFORM_ADMIN) return false; // platform admins approve brands, they don't operate outlets
  if (access.allOutlets) return true;
  return access.outletIds.includes(outletId);
}

export function can(access, capability, outletId = null) {
  if (!access || !access.role) return false;
  if (!roleHasCapability(access.role, capability)) return false;
  // Outlet-scoped capabilities additionally require reach over that outlet.
  if (outletId != null && !canAccessOutlet(access, outletId)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

/**
 * May `access` invite `targetRole` covering `targetOutletIds`?
 *
 * Three conditions, all required:
 *   1. the inviter holds an invite capability appropriate to the target role
 *   2. the target role ranks strictly below the inviter's own
 *   3. every outlet in the grant is one the inviter already reaches
 *
 * Condition 3 is the one that stops a manager of Bandra quietly adding a
 * colleague to Andheri.
 */
export function canInvite(access, targetRole, targetOutletIds = []) {
  if (!access || !access.role) return false;
  if (!ROLE_RANK[targetRole]) return false;
  if (roleRank(targetRole) >= roleRank(access.role)) return false;

  const capability = BRAND_ROLES.includes(targetRole) ? "inviteManager" : "inviteFloorStaff";
  if (!roleHasCapability(access.role, capability)) return false;

  if (targetOutletIds.length === 0) return false; // a grant must name its outlets
  return targetOutletIds.every((id) => canAccessOutlet(access, id));
}

// ---------------------------------------------------------------------------
// Effective menu
// ---------------------------------------------------------------------------

/**
 * A brand authors one master menu; each outlet may override price, availability,
 * or hide an item entirely. The effective menu is resolved at read time.
 *
 * Never fork per-outlet copies of the menu: twelve branches editing twelve
 * copies drift apart within a month, and a brand-wide price change becomes
 * twelve manual edits.
 */
export function effectiveMenu(masterItems, overridesById = {}) {
  return (masterItems || [])
    .map((item) => {
      const override = overridesById[item.id];
      if (!override) return item;
      const merged = { ...item };
      if (override.price != null) merged.price = override.price;
      if (override.available != null) merged.available = override.available;
      if (override.hidden != null) merged.hidden = override.hidden;
      // Track that this outlet diverges, so the console can show a badge and
      // the owner can find local edits without diffing by eye.
      merged.hasLocalOverride = true;
      return merged;
    })
    .filter((item) => !item.hidden);
}

/**
 * Which fields an outlet is allowed to override. Anything else — name, recipe,
 * category, photo — stays brand-controlled, because a chain's identity is the
 * thing it is selling and a branch renaming a dish breaks reporting.
 */
export const OVERRIDABLE_FIELDS = ["price", "available", "hidden"];

export function sanitizeOverride(raw) {
  const clean = {};
  for (const field of OVERRIDABLE_FIELDS) {
    if (raw && raw[field] != null) clean[field] = raw[field];
  }
  return clean;
}

// ---------------------------------------------------------------------------
// Where someone lands after signing in
// ---------------------------------------------------------------------------

/**
 * The home screen for a role.
 *
 * Anyone who manages across outlets starts in the brand console — that is where
 * outlets, the master menu, and the team live, and dropping an owner straight
 * into one outlet's till makes the product look like a single-restaurant app.
 * Floor staff start at the surface they actually work.
 */
export function homeRouteFor(role) {
  switch (role) {
    case ROLES.BRAND_OWNER:
    case ROLES.BRAND_MANAGER:
    case ROLES.OUTLET_MANAGER:
      return "/brand";
    case ROLES.RECEPTION:
      return "/receptionist";
    case ROLES.KITCHEN:
      return "/kitchen";
    default:
      return null;
  }
}
