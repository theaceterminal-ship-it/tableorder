// Security rules, tested against the Firestore emulator.
//
// Run with:  npm run test:rules
//
// These are the tests that should have existed from the start. Every boundary
// here was broken at least once during the build and found by a person clicking
// through the app — including several that locked staff out of their own
// restaurant. This is that class of bug, caught in a second instead.
//
// Rules are read from firestore.rules, so a change there is exercised here.

import { describe, it, beforeAll, afterAll, beforeEach, expect } from "vitest";
import fs from "node:fs";
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from "@firebase/rules-unit-testing";
import {
  doc, setDoc, getDoc, updateDoc, deleteDoc, collection, getDocs, addDoc, query, where,
} from "firebase/firestore";

let testEnv;

// --- the cast --------------------------------------------------------------
const OWNER = { uid: "u_owner", email: "owner@spice.test" };
const MANAGER = { uid: "u_manager", email: "manager@spice.test" };
const RECEPTION = { uid: "u_reception", email: "reception@spice.test" };
const KITCHEN = { uid: "u_kitchen", email: "kitchen@spice.test" };
const OUTSIDER = { uid: "u_outsider", email: "someone@else.test" };
const ADMIN = { uid: "u_admin", email: "admin@cabadra.test" };
const INVITEE = { uid: "u_invitee", email: "newhire@spice.test" };

const BRAND = "b_spice";
const BANDRA = "o_bandra";
const ANDHERI = "o_andheri";

function as(user) {
  return testEnv.authenticatedContext(user.uid, { email: user.email }).firestore();
}
const anon = () => testEnv.unauthenticatedContext().firestore();

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "cabadra-rules-test",
    firestore: {
      rules: fs.readFileSync("firestore.rules", "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

afterAll(async () => { await testEnv?.cleanup(); });

// Seed with rules DISABLED, so the fixture itself never depends on the rules
// under test — otherwise a broken rule silently produces an empty world and
// every test passes for the wrong reason.
beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "platformAdmins", ADMIN.uid), { email: ADMIN.email });

    await setDoc(doc(db, "brands", BRAND), {
      ownerUid: OWNER.uid, name: "Spice Garden", tier: "multi", orgId: null,
      outletIds: [BANDRA, ANDHERI],
      subscription: { status: "active", plan: "pro", planEndDate: Date.now() + 8.64e7 },
    });
    await setDoc(doc(db, "brands", BRAND, "members", OWNER.uid), { role: "brand_owner", outletIds: [BANDRA, ANDHERI] });
    await setDoc(doc(db, "brands", BRAND, "members", MANAGER.uid), { role: "outlet_manager", outletIds: [BANDRA] });

    for (const o of [BANDRA, ANDHERI]) {
      await setDoc(doc(db, "restaurants", o), { brandId: BRAND, name: o });
      await setDoc(doc(db, "restaurants", o, "info", "profile"), { name: o });
      await setDoc(doc(db, "restaurants", o, "info", "billing"), { taxPercent: 5, upiId: "x@y" });
    }
    await setDoc(doc(db, "restaurants", BANDRA, "staff", RECEPTION.uid), { role: "reception", email: RECEPTION.email });
    await setDoc(doc(db, "restaurants", BANDRA, "staff", KITCHEN.uid), { role: "kitchen", email: KITCHEN.email });

    await setDoc(doc(db, "restaurants", BANDRA, "orders", "ord1"), {
      table: 1, status: "pending", items: [{ itemId: "x", name: "Dal", qty: 1, price: 320 }], createdAt: Date.now(),
    });
    await setDoc(doc(db, "restaurants", BANDRA, "billCustomers", "bill1"), { name: "Guest", phone: "9999999999" });
  });
});

// ===========================================================================
describe("the diner's table client (unauthenticated)", () => {
  it("reads the menu and the outlet, because the QR page must render", async () => {
    const db = anon();
    await assertSucceeds(getDoc(doc(db, "restaurants", BANDRA)));
    await assertSucceeds(getDoc(doc(db, "restaurants", BANDRA, "info", "profile")));
    await assertSucceeds(getDocs(collection(db, "restaurants", BANDRA, "menuItems")));
  });

  it("places an order", async () => {
    await assertSucceeds(addDoc(collection(anon(), "restaurants", BANDRA, "orders"), {
      table: 3, status: "pending", items: [{ itemId: "x", name: "Naan", qty: 1, price: 60 }],
      orderType: "dinein", isVIP: false, etaMinutes: null, preparingAt: null, createdAt: Date.now(),
    }));
  });

  it("cannot invent a bill on the order it places", async () => {
    await assertFails(addDoc(collection(anon(), "restaurants", BANDRA, "orders"), {
      table: 3, status: "pending", items: [{ name: "Naan", qty: 1, price: 60 }],
      createdAt: Date.now(), billTotal: 0,
    }));
  });

  it("cannot place an empty order", async () => {
    await assertFails(addDoc(collection(anon(), "restaurants", BANDRA, "orders"), {
      table: 3, status: "pending", items: [], createdAt: Date.now(),
    }));
  });

  it("cannot jump an order straight to paid", async () => {
    await assertFails(addDoc(collection(anon(), "restaurants", BANDRA, "orders"), {
      table: 3, status: "paid", items: [{ name: "Naan", qty: 1, price: 60 }], createdAt: Date.now(),
    }));
  });

  it("cannot zero out a bill", async () => {
    await assertFails(updateDoc(doc(anon(), "restaurants", BANDRA, "orders", "ord1"), { billTotal: 0 }));
  });

  it("cannot read customer names and phone numbers", async () => {
    // The whole reason billCustomers exists as a separate collection.
    await assertFails(getDoc(doc(anon(), "restaurants", BANDRA, "billCustomers", "bill1")));
  });

  it("cannot read the outlet's UPI id and tax configuration", async () => {
    await assertFails(getDoc(doc(anon(), "restaurants", BANDRA, "info", "billing")));
  });

  it("cannot edit the menu or prices", async () => {
    await assertFails(setDoc(doc(anon(), "restaurants", BANDRA, "menuItems", "hack"), { name: "Free", price: 0 }));
  });
});

// ===========================================================================
describe("brand owner", () => {
  it("manages every outlet in the brand, including ones not listed on their membership", async () => {
    const db = as(OWNER);
    await assertSucceeds(setDoc(doc(db, "restaurants", ANDHERI, "info", "profile"), { name: "Andheri West" }, { merge: true }));
    await assertSucceeds(setDoc(doc(db, "restaurants", BANDRA, "menuItems", "m1"), { name: "Dal", price: 320 }));
  });

  it("edits the master menu", async () => {
    await assertSucceeds(setDoc(doc(as(OWNER), "brands", BRAND, "menuItems", "mm1"), { name: "Dal", price: 320 }));
  });

  it("adds an outlet to their own brand", async () => {
    await assertSucceeds(updateDoc(doc(as(OWNER), "brands", BRAND), { outletIds: [BANDRA, ANDHERI, "o_new"] }));
  });

  it("CANNOT activate their own subscription", async () => {
    // The whole commercial model rests on this one.
    await assertFails(updateDoc(doc(as(OWNER), "brands", BRAND), {
      subscription: { status: "active", plan: "pro", planEndDate: Date.now() + 9e11 },
      tier: "enterprise",
    }));
  });

  it("CANNOT change their own tier", async () => {
    await assertFails(updateDoc(doc(as(OWNER), "brands", BRAND), { tier: "enterprise" }));
  });

  it("cannot touch another brand", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "brands", "b_other"), { ownerUid: OUTSIDER.uid, name: "Other", tier: "single", outletIds: [] });
    });
    await assertFails(updateDoc(doc(as(OWNER), "brands", "b_other"), { name: "Mine now" }));
  });
});

// ===========================================================================
describe("outlet manager", () => {
  it("manages the outlet they were assigned", async () => {
    // Regression: canManageOutlet passed an OUTLET id to a function expecting a
    // BRAND id, so a manager could not manage anything at all.
    const db = as(MANAGER);
    await assertSucceeds(setDoc(doc(db, "restaurants", BANDRA, "info", "profile"), { name: "Bandra W" }, { merge: true }));
    await assertSucceeds(setDoc(doc(db, "restaurants", BANDRA, "menuItems", "m2"), { name: "Naan", price: 60 }));
  });

  it("cannot manage an outlet they were NOT assigned", async () => {
    await assertFails(setDoc(doc(as(MANAGER), "restaurants", ANDHERI, "info", "profile"), { name: "Mine" }, { merge: true }));
  });

  it("cannot edit the master menu", async () => {
    await assertFails(setDoc(doc(as(MANAGER), "brands", BRAND, "menuItems", "mm2"), { name: "Sneaky", price: 1 }));
  });

  it("cannot add outlets", async () => {
    await assertFails(updateDoc(doc(as(MANAGER), "brands", BRAND), { outletIds: [BANDRA, ANDHERI, "o_mine"] }));
  });

  it("cannot promote themselves", async () => {
    await assertFails(updateDoc(doc(as(MANAGER), "brands", BRAND, "members", MANAGER.uid), {
      role: "brand_owner", outletIds: [BANDRA, ANDHERI],
    }));
  });

  it("cannot widen their own outlet assignment", async () => {
    await assertFails(updateDoc(doc(as(MANAGER), "brands", BRAND, "members", MANAGER.uid), {
      role: "outlet_manager", outletIds: [BANDRA, ANDHERI],
    }));
  });

  it("edits their own name and phone", async () => {
    await assertSucceeds(updateDoc(doc(as(MANAGER), "brands", BRAND, "members", MANAGER.uid), {
      name: "Priya", phone: "9000000000",
    }));
  });
});

// ===========================================================================
describe("floor staff", () => {
  it("works their own outlet's orders", async () => {
    await assertSucceeds(updateDoc(doc(as(RECEPTION), "restaurants", BANDRA, "orders", "ord1"), { status: "confirmed" }));
  });

  it("reads customer details for their own outlet", async () => {
    await assertSucceeds(getDoc(doc(as(RECEPTION), "restaurants", BANDRA, "billCustomers", "bill1")));
  });

  it("cannot reach another outlet's customer details", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "restaurants", ANDHERI, "billCustomers", "bill2"), { name: "Other", phone: "1" });
    });
    await assertFails(getDoc(doc(as(RECEPTION), "restaurants", ANDHERI, "billCustomers", "bill2")));
  });

  it("cannot edit the menu", async () => {
    await assertFails(setDoc(doc(as(RECEPTION), "restaurants", BANDRA, "menuItems", "m3"), { name: "Free", price: 0 }));
  });

  it("cannot invite anyone", async () => {
    await assertFails(setDoc(doc(as(RECEPTION), "staffInvites", "friend@x.test"), {
      email: "friend@x.test", role: "reception", brandId: BRAND, outletIds: [BANDRA], invitedByUid: RECEPTION.uid, active: true,
    }));
  });

  it("kitchen staff cannot promote themselves to reception", async () => {
    await assertFails(updateDoc(doc(as(KITCHEN), "restaurants", BANDRA, "staff", KITCHEN.uid), { role: "reception" }));
  });

  it("kitchen staff can fix their own name", async () => {
    await assertSucceeds(updateDoc(doc(as(KITCHEN), "restaurants", BANDRA, "staff", KITCHEN.uid), { name: "Ravi" }));
  });
});

// ===========================================================================
describe("a complete outsider", () => {
  it("cannot read the brand", async () => {
    await assertFails(getDoc(doc(as(OUTSIDER), "brands", BRAND)));
  });

  it("cannot write to any outlet", async () => {
    await assertFails(setDoc(doc(as(OUTSIDER), "restaurants", BANDRA, "info", "profile"), { name: "hacked" }, { merge: true }));
  });

  it("cannot join an outlet by writing their own staff document", async () => {
    // Without an invitation addressed to them, this must fail.
    await assertFails(setDoc(doc(as(OUTSIDER), "restaurants", BANDRA, "staff", OUTSIDER.uid), {
      role: "reception", uid: OUTSIDER.uid, status: "active",
    }));
  });

  it("cannot make themselves a brand member", async () => {
    await assertFails(setDoc(doc(as(OUTSIDER), "brands", BRAND, "members", OUTSIDER.uid), {
      role: "brand_owner", outletIds: [BANDRA],
    }));
  });
});

// ===========================================================================
describe("invitations", () => {
  const inviteFor = (email, role, outletIds, invitedByUid) => ({
    email, role, brandId: BRAND, outletIds, invitedByUid, active: true, createdAt: Date.now(),
  });

  it("an owner invites a manager for any outlet", async () => {
    await assertSucceeds(setDoc(doc(as(OWNER), "staffInvites", INVITEE.email),
      inviteFor(INVITEE.email, "outlet_manager", [BANDRA, ANDHERI], OWNER.uid)));
  });

  it("a manager invites floor staff for an outlet they hold", async () => {
    await assertSucceeds(setDoc(doc(as(MANAGER), "staffInvites", INVITEE.email),
      inviteFor(INVITEE.email, "reception", [BANDRA], MANAGER.uid)));
  });

  it("a manager CANNOT grant an outlet they do not hold", async () => {
    // The Bandra-manager-adds-someone-to-Andheri case.
    await assertFails(setDoc(doc(as(MANAGER), "staffInvites", INVITEE.email),
      inviteFor(INVITEE.email, "reception", [ANDHERI], MANAGER.uid)));
    await assertFails(setDoc(doc(as(MANAGER), "staffInvites", INVITEE.email),
      inviteFor(INVITEE.email, "reception", [BANDRA, ANDHERI], MANAGER.uid)));
  });

  it("a manager cannot create another manager", async () => {
    await assertFails(setDoc(doc(as(MANAGER), "staffInvites", INVITEE.email),
      inviteFor(INVITEE.email, "outlet_manager", [BANDRA], MANAGER.uid)));
  });

  it("an invitee reads the invitation addressed to them", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "staffInvites", INVITEE.email),
        inviteFor(INVITEE.email, "outlet_manager", [BANDRA], OWNER.uid));
    });
    await assertSucceeds(getDoc(doc(as(INVITEE), "staffInvites", INVITEE.email)));
  });

  it("an invitee cannot read somebody else's invitation", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "staffInvites", "other@x.test"),
        inviteFor("other@x.test", "reception", [BANDRA], OWNER.uid));
    });
    await assertFails(getDoc(doc(as(INVITEE), "staffInvites", "other@x.test")));
  });

  it("an invitee creates their own membership from their invitation", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "staffInvites", INVITEE.email),
        inviteFor(INVITEE.email, "outlet_manager", [BANDRA], OWNER.uid));
    });
    await assertSucceeds(setDoc(doc(as(INVITEE), "brands", BRAND, "members", INVITEE.uid), {
      role: "outlet_manager", outletIds: [BANDRA], email: INVITEE.email,
    }));
  });

  it("an invitee cannot accept a BIGGER role than they were offered", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "staffInvites", INVITEE.email),
        inviteFor(INVITEE.email, "reception", [BANDRA], OWNER.uid));
    });
    await assertFails(setDoc(doc(as(INVITEE), "brands", BRAND, "members", INVITEE.uid), {
      role: "outlet_manager", outletIds: [BANDRA],
    }));
  });

  it("an invitee cannot claim MORE outlets than they were offered", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "staffInvites", INVITEE.email),
        inviteFor(INVITEE.email, "outlet_manager", [BANDRA], OWNER.uid));
    });
    await assertFails(setDoc(doc(as(INVITEE), "brands", BRAND, "members", INVITEE.uid), {
      role: "outlet_manager", outletIds: [BANDRA, ANDHERI],
    }));
  });

  it("an invitee marks their own invitation consumed", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "staffInvites", INVITEE.email),
        inviteFor(INVITEE.email, "reception", [BANDRA], OWNER.uid));
    });
    await assertSucceeds(setDoc(doc(as(INVITEE), "staffInvites", INVITEE.email), {
      active: false, acceptedAt: Date.now(), acceptedByUid: INVITEE.uid,
    }, { merge: true }));
  });

  it("an invitee cannot rewrite their invitation into a bigger one", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "staffInvites", INVITEE.email),
        inviteFor(INVITEE.email, "reception", [BANDRA], OWNER.uid));
    });
    await assertFails(setDoc(doc(as(INVITEE), "staffInvites", INVITEE.email), {
      role: "brand_owner",
    }, { merge: true }));
  });
});

// ===========================================================================
describe("platform admin", () => {
  it("reads every brand, which is what makes the approvals queue one query", async () => {
    await assertSucceeds(getDocs(collection(as(ADMIN), "brands")));
  });

  it("activates a subscription", async () => {
    await assertSucceeds(updateDoc(doc(as(ADMIN), "brands", BRAND), {
      subscription: { status: "active", plan: "pro", planEndDate: Date.now() + 9e10 },
    }));
  });

  it("writes an audit entry against their own uid", async () => {
    await assertSucceeds(addDoc(collection(as(ADMIN), "auditLog"), {
      brandId: BRAND, action: "approve", actorUid: ADMIN.uid, actorEmail: ADMIN.email, at: Date.now(),
    }));
  });

  it("cannot write an audit entry attributed to somebody else", async () => {
    await assertFails(addDoc(collection(as(ADMIN), "auditLog"), {
      brandId: BRAND, action: "approve", actorUid: OWNER.uid, at: Date.now(),
    }));
  });

  it("CANNOT edit or delete an audit entry, so the log is real evidence", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "auditLog", "e1"), { actorUid: ADMIN.uid, action: "approve", at: 1 });
    });
    await assertFails(updateDoc(doc(as(ADMIN), "auditLog", "e1"), { action: "reject" }));
    await assertFails(deleteDoc(doc(as(ADMIN), "auditLog", "e1")));
  });

  it("nobody can make themselves a platform admin", async () => {
    await assertFails(setDoc(doc(as(OWNER), "platformAdmins", OWNER.uid), { email: OWNER.email }));
    await assertFails(setDoc(doc(as(OUTSIDER), "platformAdmins", OUTSIDER.uid), { email: OUTSIDER.email }));
    await assertFails(setDoc(doc(as(ADMIN), "platformAdmins", OUTSIDER.uid), { email: "x" }));
  });

  it("an owner cannot read the audit log", async () => {
    await assertFails(getDocs(collection(as(OWNER), "auditLog")));
  });
});

// ===========================================================================
describe("signup bootstrap", () => {
  // The order signup writes in. This broke account creation entirely once,
  // because a rule required staff membership before the membership existed.
  const NEW = { uid: "u_new", email: "new@owner.test" };
  const NEW_BRAND = "b_new";
  const NEW_OUTLET = "o_new";

  it("runs brand -> membership -> outlet -> outlet documents -> user", async () => {
    const db = as(NEW);

    await assertSucceeds(setDoc(doc(db, "brands", NEW_BRAND), {
      ownerUid: NEW.uid, name: "New Place", tier: "single", orgId: null, outletIds: [NEW_OUTLET],
      subscription: { status: "pending_approval", plan: "base", ownerEmail: NEW.email },
    }));

    await assertSucceeds(setDoc(doc(db, "brands", NEW_BRAND, "members", NEW.uid), {
      role: "brand_owner", outletIds: [NEW_OUTLET],
    }));

    await assertSucceeds(setDoc(doc(db, "restaurants", NEW_OUTLET), { brandId: NEW_BRAND, name: "Main" }));
    await assertSucceeds(setDoc(doc(db, "restaurants", NEW_OUTLET, "info", "profile"), { name: "Main" }));
    await assertSucceeds(setDoc(doc(db, "restaurants", NEW_OUTLET, "info", "billing"), { taxPercent: 5 }));
    await assertSucceeds(setDoc(doc(db, "users", NEW.uid), { brandId: NEW_BRAND, defaultOutletId: NEW_OUTLET }));
  });

  it("cannot sign up straight into an active subscription", async () => {
    await assertFails(setDoc(doc(as(NEW), "brands", "b_cheeky"), {
      ownerUid: NEW.uid, name: "Free Pro", tier: "enterprise", outletIds: [],
      subscription: { status: "active", plan: "pro", planEndDate: Date.now() + 9e11 },
    }));
  });

  it("cannot create a brand owned by somebody else", async () => {
    await assertFails(setDoc(doc(as(NEW), "brands", "b_theirs"), {
      ownerUid: OWNER.uid, name: "Not mine", tier: "single", outletIds: [],
      subscription: { status: "pending_approval", plan: "base" },
    }));
  });
});
