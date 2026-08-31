// lib/brand.js
//
// Brand-level operations: outlets, the master menu, and today's numbers rolled
// up across a chain. Everything here is guarded by security rules as well —
// these functions are the convenient path, not the enforcement.

import { db } from "./firebase";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, addDoc,
  query, where, orderBy, writeBatch,
} from "firebase/firestore";
import { startOfDay, revenueOrders } from "./orders";
import { canAddOutlet, tierLimits } from "./tenancy";

// ---------------------------------------------------------------------------
// Outlets
// ---------------------------------------------------------------------------

export async function fetchOutlet(outletId) {
  const snap = await getDoc(doc(db, "restaurants", outletId));
  return snap.exists() ? { id: outletId, ...snap.data() } : null;
}

export async function fetchOutlets(outletIds = []) {
  const loaded = await Promise.all(outletIds.map(async (id) => {
    try {
      const snap = await getDoc(doc(db, "restaurants", id));
      return snap.exists() ? { id, ...snap.data() } : { id, name: "(missing)", missing: true };
    } catch {
      return { id, name: "(unreadable)", unreadable: true };
    }
  }));
  return loaded;
}

/**
 * Create an outlet and add it to the brand.
 *
 * The tier ceiling is checked here for a decent error message and again by the
 * caller's plan, but the authoritative limit is commercial rather than
 * technical — the platform admin sets the tier, and the tier sets the ceiling.
 */
export async function createOutlet({ brand, name, address = "" }) {
  const current = (brand.outletIds || []).length;
  if (!canAddOutlet(brand.tier, current)) {
    const max = tierLimits(brand.tier).maxOutlets;
    throw new Error(
      `Your ${brand.tier} plan allows ${max} outlet${max === 1 ? "" : "s"}. Upgrade to add more.`
    );
  }
  if (!name?.trim()) throw new Error("Outlet name is required");

  const outletId = doc(collection(db, "restaurants")).id;
  const now = Date.now();

  await setDoc(doc(db, "restaurants", outletId), {
    brandId: brand.id, name: name.trim(), createdAt: now,
  });
  await setDoc(doc(db, "restaurants", outletId, "info", "profile"), {
    name: name.trim(), tagline: "", address, logoUrl: "", createdAt: now,
  });
  await setDoc(doc(db, "restaurants", outletId, "info", "billing"), {
    taxPercent: 5, servicePercent: 0, upiId: "",
  });

  // Appending to the brand is a separate write on purpose: if it fails, the
  // outlet exists but is unlisted, which is recoverable. The reverse — listed
  // but nonexistent — shows up as a broken row everywhere.
  await updateDoc(doc(db, "brands", brand.id), {
    outletIds: [...(brand.outletIds || []), outletId],
    updatedAt: now,
  });

  return outletId;
}

export async function renameOutlet(outletId, name) {
  if (!name?.trim()) throw new Error("Name is required");
  await updateDoc(doc(db, "restaurants", outletId), { name: name.trim() });
  await setDoc(doc(db, "restaurants", outletId, "info", "profile"), { name: name.trim() }, { merge: true });
}

/**
 * Unlist an outlet from its brand. The outlet's documents are deliberately NOT
 * deleted: its orders are financial history, and a brand that drops a branch
 * still has to be able to answer questions about last quarter.
 */
export async function removeOutletFromBrand(brand, outletId) {
  await updateDoc(doc(db, "brands", brand.id), {
    outletIds: (brand.outletIds || []).filter((id) => id !== outletId),
    updatedAt: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Today's numbers
// ---------------------------------------------------------------------------

/**
 * Today's revenue and order count for one outlet.
 *
 * Bounded to today, and counted through revenueOrders() so a merged-table bill
 * is not counted once per table.
 *
 * NOTE: this is one query per outlet. Fine for a chain of this size and a
 * single day; it is NOT how historical reporting should work. That wants the
 * pre-aggregated dailyStats rollups — see The Ten Percent Plan, Phase 1.
 */
export async function fetchOutletToday(outletId) {
  try {
    const snap = await getDocs(query(
      collection(db, "restaurants", outletId, "orders"),
      where("createdAt", ">=", startOfDay()),
      orderBy("createdAt", "asc"),
    ));
    const orders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const revenue = revenueOrders(orders);
    return {
      outletId,
      orderCount: orders.length,
      billedCount: revenue.length,
      sales: revenue.reduce((s, o) => s + (o.billTotal || 0), 0),
      itemsSold: revenue.reduce((s, o) => s + (o.items || []).reduce((n, it) => n + (it.qty || 0), 0), 0),
      pending: orders.filter((o) => o.status === "pending").length,
    };
  } catch {
    return { outletId, unreadable: true, orderCount: 0, billedCount: 0, sales: 0, itemsSold: 0, pending: 0 };
  }
}

export async function fetchBrandToday(outletIds = []) {
  const perOutlet = await Promise.all(outletIds.map(fetchOutletToday));
  const totals = perOutlet.reduce((acc, o) => ({
    sales: acc.sales + o.sales,
    orderCount: acc.orderCount + o.orderCount,
    billedCount: acc.billedCount + o.billedCount,
    itemsSold: acc.itemsSold + o.itemsSold,
    pending: acc.pending + o.pending,
  }), { sales: 0, orderCount: 0, billedCount: 0, itemsSold: 0, pending: 0 });
  return {
    perOutlet,
    totals: { ...totals, avgOrderValue: totals.billedCount ? Math.round(totals.sales / totals.billedCount) : 0 },
  };
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

// Brand-level members: owners and managers. Floor staff live on outlets, not
// here, so this is exactly the list an owner manages.
export async function listBrandMembers(brandId) {
  if (!brandId) return [];
  const snap = await getDocs(collection(db, "brands", brandId, "members"));
  return snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
}

// Floor staff rostered at one outlet.
export async function listOutletStaff(outletId) {
  try {
    const snap = await getDocs(collection(db, "restaurants", outletId, "staff"));
    return snap.docs.map((d) => ({ uid: d.id, outletId, ...d.data() }));
  } catch {
    return [];
  }
}

export async function removeBrandMember(brandId, uid) {
  await deleteDoc(doc(db, "brands", brandId, "members", uid));
}

export async function removeOutletStaff(outletId, uid) {
  await deleteDoc(doc(db, "restaurants", outletId, "staff", uid));
}

// ---------------------------------------------------------------------------
// Master menu
// ---------------------------------------------------------------------------
//
// The master menu is a TEMPLATE, not a live parent. Outlets keep their own
// menuItems collection exactly as before — every existing menu feature keeps
// working untouched — and can pull items in from the master when they want to.
//
// Chosen over live master-plus-override resolution because it changes nothing
// about how outlet menus already work. The trade-off is real and worth stating:
// editing a master item does not update outlets that already seeded it.

export async function fetchMasterMenu(brandId) {
  const snap = await getDocs(collection(db, "brands", brandId, "menuItems"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * Bulk-add parsed items to the master menu.
 *
 * Skips names the master already has, so re-importing a corrected file tops it
 * up instead of duplicating everything. Chunked because Firestore caps a batch
 * at 500 writes and a full restaurant menu can exceed that.
 */
export async function importMasterItems(brandId, items, existing = []) {
  const have = new Set(existing.map((m) => (m.name || "").trim().toLowerCase()));
  const toAdd = items.filter((m) => !have.has(m.name.trim().toLowerCase()));
  if (toAdd.length === 0) return { added: 0, duplicates: items.length };

  for (let i = 0; i < toAdd.length; i += 400) {
    const batch = writeBatch(db);
    toAdd.slice(i, i + 400).forEach((m) => {
      batch.set(doc(collection(db, "brands", brandId, "menuItems")), {
        name: m.name,
        description: m.description || "",
        price: m.price,
        category: m.category || "Mains",
        foodType: m.foodType || "veg",
        imageUrl: m.imageUrl || "",
        etaMinutes: m.etaMinutes || 15,
        createdAt: Date.now(),
      });
    });
    await batch.commit();
  }
  return { added: toAdd.length, duplicates: items.length - toAdd.length };
}

/** A member editing their own name and contact. Role and outlets are untouched. */
export async function updateMyMemberProfile(brandId, uid, { name, phone }) {
  await updateDoc(doc(db, "brands", brandId, "members", uid), {
    name: (name || "").trim(),
    phone: (phone || "").trim(),
  });
}

/** Brand identity: what the owner's staff and diners actually see. */
export async function updateBrandIdentity(brandId, { name, logoUrl, accentColor }) {
  const patch = {};
  if (name != null) patch.name = name.trim();
  if (logoUrl != null) patch.logoUrl = logoUrl;
  if (accentColor != null) patch.accentColor = accentColor;
  patch.updatedAt = Date.now();
  await updateDoc(doc(db, "brands", brandId), patch);
}

export async function addMasterItem(brandId, item) {
  if (!item.name?.trim()) throw new Error("Name is required");
  if (!item.price) throw new Error("Price is required");
  return addDoc(collection(db, "brands", brandId, "menuItems"), {
    name: item.name.trim(),
    description: item.description || "",
    price: parseFloat(item.price),
    category: item.category || "Mains",
    foodType: item.foodType || "veg",
    imageUrl: item.imageUrl || "",
    etaMinutes: parseInt(item.etaMinutes) || 15,
    createdAt: Date.now(),
  });
}

export async function updateMasterItem(brandId, itemId, patch) {
  await updateDoc(doc(db, "brands", brandId, "menuItems", itemId), patch);
}

export async function deleteMasterItem(brandId, itemId) {
  await deleteDoc(doc(db, "brands", brandId, "menuItems", itemId));
}

/**
 * Copy master items into an outlet's own menu.
 *
 * Matches on name to decide what is already there, so seeding twice does not
 * create duplicates, and an item the outlet has since re-priced is left alone
 * rather than being reset to the brand price.
 *
 * Returns what it did so the UI can say so precisely — "added 12, skipped 4
 * already on your menu" is a much better message than "done".
 */
export async function seedOutletFromMaster(brandId, outletId, masterItems, outletItems) {
  const existing = new Set((outletItems || []).map((m) => m.name.trim().toLowerCase()));
  const toAdd = (masterItems || []).filter((m) => !existing.has(m.name.trim().toLowerCase()));

  if (toAdd.length === 0) return { added: 0, skipped: (masterItems || []).length };

  // Firestore caps a batch at 500 writes; chunk so a large master menu works.
  for (let i = 0; i < toAdd.length; i += 400) {
    const batch = writeBatch(db);
    toAdd.slice(i, i + 400).forEach((m) => {
      const ref = doc(collection(db, "restaurants", outletId, "menuItems"));
      batch.set(ref, {
        name: m.name,
        description: m.description || "",
        price: m.price,
        category: m.category || "Mains",
        foodType: m.foodType || "veg",
        imageUrl: m.imageUrl || "",
        etaMinutes: m.etaMinutes || 15,
        available: true,
        featured: false,
        chefSpecial: false,
        isCombo: false,
        bogoEnabled: false,
        variations: [],
        addons: [],
        seededFromMaster: true,
        createdAt: Date.now(),
      });
    });
    await batch.commit();
  }

  return { added: toAdd.length, skipped: (masterItems || []).length - toAdd.length };
}
