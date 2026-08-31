// lib/invites.js
//
// Staff invitations. The invite document IS the authorization: it is written by
// someone who already held the outlets being granted, and the invitee's own
// membership is created from it verbatim.
//
// Two things this replaces, both of which were security holes:
//
//   1. The old login flow asked the invitee to CHOOSE their role after
//      accepting ("are you reception or kitchen?"). An invited dishwasher
//      could elect to be reception. The role now comes from the invite.
//
//   2. The old staff rule let any signed-in user create their own staff
//      document at any outlet. Now that write must match an invite addressed
//      to their email.
//
// Documents are keyed by the plain lowercased email so security rules can
// resolve them directly from request.auth.token.email, with no key mangling to
// keep in sync between client and rules.

import { db } from "./firebase";
import { doc, getDoc, setDoc, deleteDoc, collection, getDocs, query, where, serverTimestamp } from "firebase/firestore";
import { BRAND_ROLES, OUTLET_ROLES, ROLES } from "./tenancy";

export function inviteKey(email) {
  return (email || "").trim().toLowerCase();
}

export async function fetchInvite(email) {
  const key = inviteKey(email);
  if (!key) return null;
  const snap = await getDoc(doc(db, "staffInvites", key));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/**
 * Outstanding invitations for one brand.
 *
 * The brand filter is part of the QUERY, not applied afterwards in JavaScript.
 * Firestore evaluates read rules against every document a query would return,
 * so listing the whole collection and filtering in the client fails outright —
 * other brands' invites are in the result set and they are not readable. It
 * would also have been the wrong thing to ask for even if it worked.
 */
export async function listInvites(brandId) {
  if (!brandId) return [];
  const snap = await getDocs(query(collection(db, "staffInvites"), where("brandId", "==", brandId)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * Write an invitation. The caller must already have verified with canInvite()
 * that they may grant this role over these outlets — the security rules check
 * it again independently, so a client that skips the check simply fails.
 */
export async function createInvite({ email, role, brandId, outletIds, invitedByUid }) {
  const key = inviteKey(email);
  if (!key) throw new Error("Email is required");
  if (!brandId) throw new Error("Missing brand");
  if (!outletIds || outletIds.length === 0) throw new Error("Pick at least one outlet");

  // Deliberately no read-before-write. Checking whether the document already
  // exists means READING an invite addressed to someone else's email, which is
  // denied — resource is null for a document that does not exist, so every
  // clause of the read rule is false and the check fails before the write is
  // even attempted. Callers detect duplicates against the invite list they have
  // already loaded, which they are entitled to see.
  await setDoc(doc(db, "staffInvites", key), {
    email: key,
    role,
    brandId,
    outletIds,
    invitedByUid,
    invitedAt: serverTimestamp(),
    createdAt: Date.now(),
    active: true,
  });
}

export async function revokeInvite(email) {
  const key = inviteKey(email);
  if (key) await deleteDoc(doc(db, "staffInvites", key));
}

/**
 * Turn an accepted invitation into a real membership.
 *
 * Brand-level roles (manager) become a document under the brand; floor roles
 * (reception, kitchen) become staff documents on each granted outlet. The role
 * and outlets are taken from the invite and never from the caller, so there is
 * nothing here for an invitee to influence.
 */
export async function acceptInvite(invite, user) {
  if (!invite?.active) throw new Error("This invitation is no longer valid.");

  const { role, brandId, outletIds = [] } = invite;

  if (BRAND_ROLES.includes(role)) {
    await setDoc(doc(db, "brands", brandId, "members", user.uid), {
      role,
      outletIds,
      email: user.email,
      name: user.displayName || "",
      addedAt: Date.now(),
    });
  } else if (OUTLET_ROLES.includes(role)) {
    // One staff document per granted outlet, so an outlet's roster is readable
    // without consulting the brand.
    for (const outletId of outletIds) {
      await setDoc(doc(db, "restaurants", outletId, "staff", user.uid), {
        role,
        uid: user.uid,
        email: user.email,
        name: user.displayName || "",
        status: "active",
        addedAt: Date.now(),
      }, { merge: true });
    }
  } else {
    throw new Error(`Unsupported invited role: ${role}`);
  }

  // Routing hints only — never read for authorization.
  await setDoc(doc(db, "users", user.uid), {
    brandId,
    defaultOutletId: outletIds[0] || null,
    email: user.email,
    name: user.displayName || "",
    addedAt: serverTimestamp(),
  }, { merge: true });

  return { brandId, outletId: outletIds[0] || null, role };
}

// Roles that can be invited, in the order they should appear in a picker.
export const INVITABLE_ROLES = [
  { role: ROLES.OUTLET_MANAGER, label: "Outlet Manager", hint: "Runs one or more outlets; can invite floor staff" },
  { role: ROLES.RECEPTION, label: "Reception", hint: "POS, billing, order management" },
  { role: ROLES.KITCHEN, label: "Kitchen", hint: "Kitchen order board only" },
];
