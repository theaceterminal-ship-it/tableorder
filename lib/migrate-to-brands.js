// lib/migrate-to-brands.js
//
// One-time migration off the old tenancy model, where a restaurant's id WAS its
// owner's Firebase Auth uid — a permanent 1:1 that made chains impossible.
//
// The migration is deliberately ADDITIVE. It creates a brand, a membership, and
// a back-reference, and touches no orders, no menu items, and no tables. The
// outlet keeps the id it already has, so every printed QR code, every order
// document, and every existing subcollection carry over untouched.
//
// Run by the account holder from /setup/migrate while signed in. Safe to run
// twice: it detects an already-migrated account and reports rather than
// duplicating.

import { db } from "./firebase";
import {
  doc, getDoc, setDoc, updateDoc, collection, getDocs, writeBatch, serverTimestamp,
} from "firebase/firestore";
import { TIERS, ROLES } from "./tenancy";

// Mirrors what the console shows, so a half-finished run is legible rather than
// a silent partial state.
export const MIGRATION_STEPS = [
  "inspect",
  "createBrand",
  "createMembership",
  "linkOutlet",
  "linkUser",
  "done",
];

async function alreadyMigrated(uid) {
  const outletSnap = await getDoc(doc(db, "restaurants", uid));
  const brandId = outletSnap.exists() ? outletSnap.data().brandId : null;
  if (!brandId) return null;
  const brandSnap = await getDoc(doc(db, "brands", brandId));
  return brandSnap.exists() ? { brandId, brand: brandSnap.data() } : null;
}

/**
 * @param {string} uid            the signed-in account holder
 * @param {(step, detail) => void} onProgress
 * @returns {{ status, brandId, outletId, message }}
 */
export async function migrateAccountToBrand(uid, onProgress = () => {}) {
  if (!uid) throw new Error("Not signed in.");

  onProgress("inspect", "Checking whether this account has already been migrated…");
  const existing = await alreadyMigrated(uid);
  if (existing) {
    return {
      status: "already-migrated",
      brandId: existing.brandId,
      outletId: uid,
      message: `Already migrated. Brand ${existing.brandId} owns this outlet.`,
    };
  }

  // The outlet keeps the old id. This is the whole reason the migration is
  // cheap: nothing that references restaurants/{uid} has to change.
  const outletId = uid;

  // Carry the existing subscription across verbatim. hotels/{uid} is left in
  // place, untouched, so this is reversible until it is deliberately deleted.
  onProgress("inspect", "Reading your current subscription…");
  let subscription = { status: "pending_approval", plan: "base" };
  let profileName = "";
  try {
    const hotelSnap = await getDoc(doc(db, "hotels", uid));
    if (hotelSnap.exists()) {
      const h = hotelSnap.data();
      subscription = {
        status: h.status || "pending_approval",
        plan: h.plan || "base",
        planEndDate: h.planEndDate ?? null,
        planAmount: h.planAmount ?? null,
        txnRef: h.txnRef ?? null,
        ownerEmail: h.ownerEmail ?? null,
      };
    }
  } catch {
    // Unreadable subscription is not fatal — the platform admin can repair it.
  }
  try {
    const profileSnap = await getDoc(doc(db, "restaurants", outletId, "info", "profile"));
    if (profileSnap.exists()) profileName = profileSnap.data().name || "";
  } catch {}

  const brandId = doc(collection(db, "brands")).id;

  onProgress("createBrand", `Creating brand ${brandId}…`);
  await setDoc(doc(db, "brands", brandId), {
    ownerUid: uid,
    orgId: null,                 // Enterprise multi-brand hook; null for everyone else
    name: profileName || "My Restaurant",
    tier: TIERS.SINGLE,          // existing accounts are single-outlet by definition
    subscription,
    outletIds: [outletId],
    migratedFrom: `restaurants/${outletId}`,
    createdAt: Date.now(),
    updatedAt: serverTimestamp(),
  });

  onProgress("createMembership", "Granting you ownership…");
  await setDoc(doc(db, "brands", brandId, "members", uid), {
    role: ROLES.BRAND_OWNER,
    outletIds: [outletId],
    addedAt: Date.now(),
  });

  onProgress("linkOutlet", "Linking your outlet to the brand…");
  // setDoc with merge, because on the old model restaurants/{uid} often had
  // subcollections but no parent document of its own.
  await setDoc(
    doc(db, "restaurants", outletId),
    { brandId, name: profileName || "Main Outlet", createdAt: Date.now() },
    { merge: true }
  );

  onProgress("linkUser", "Updating your profile…");
  await setDoc(
    doc(db, "users", uid),
    { brandId, defaultOutletId: outletId },
    { merge: true }
  );

  onProgress("done", "Migration complete.");
  return {
    status: "migrated",
    brandId,
    outletId,
    message: "Your account now has a brand. Nothing about your menu, tables, or QR codes changed.",
  };
}

/**
 * Backfills staff documents for anyone who was already working at this outlet.
 * Separate from the main migration because it is only needed where the old
 * signup flow half-completed and left staff records missing — which is exactly
 * the state that produced "Missing or insufficient permissions" in the kitchen.
 */
export async function repairOutletStaff(outletId) {
  const staffSnap = await getDocs(collection(db, "restaurants", outletId, "staff"));
  const existing = new Set(staffSnap.docs.map((d) => d.id));

  // users/{uid} is not authoritative for permissions, but it is a usable
  // *hint* about who used to work here — enough to rebuild a roster that a
  // failed signup never wrote.
  const repaired = [];
  const batch = writeBatch(db);
  staffSnap.docs.forEach((d) => {
    const data = d.data();
    if (!data.role) {
      batch.update(d.ref, { role: "reception", status: "active" });
      repaired.push(d.id);
    }
  });
  if (repaired.length > 0) await batch.commit();
  return { existing: [...existing], repaired };
}
