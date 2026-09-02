// Phone verification, tested against the emulator.
//
// Two separate claims are being checked here, and they fail in opposite
// directions:
//
//   1. A verified DINER must not gain staff powers. Phone sign-in hands a
//      stranger a real request.auth, so every rule that only asked "is anyone
//      signed in?" would start letting them through.
//
//   2. A verified diner must only be able to file an order under the number
//      Firebase actually verified — not one they typed. Otherwise verification
//      is decorative: verify your own phone, submit somebody else's.

import { describe, it, beforeAll, afterAll, beforeEach, expect } from "vitest";
import fs from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc } from "firebase/firestore";

let testEnv;
const BRAND = "b_spice";
const OUTLET = "o_bandra";
const OWNER = { uid: "u_owner", email: "owner@spice.test" };
const RECEPTION = { uid: "u_reception", email: "reception@spice.test" };

const DINER_PHONE = "+919876543210";
const OTHER_PHONE = "+919000000000";

// A phone-verified diner: no email, and a token minted by the phone provider.
const asDiner = (phone = DINER_PHONE, uid = "u_diner") =>
  testEnv.authenticatedContext(uid, {
    phone_number: phone,
    firebase: { sign_in_provider: "phone", identities: { phone: [phone] } },
  }).firestore();

const asStaff = (u) => testEnv.authenticatedContext(u.uid, { email: u.email }).firestore();
const anon = () => testEnv.unauthenticatedContext().firestore();

const ORDER_ID = "ord_1";
const detailsFor = (phoneE164, extra = {}) => ({
  name: "Asha",
  phone: "9876543210",
  phoneE164,
  address: "12 Hill Road, Bandra West",
  createdAt: Date.now(),
  ...extra,
});

async function setVerificationRequired(required) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "restaurants", OUTLET, "info", "settings"), {
      deliveryEnabled: true,
      requirePhoneVerification: required,
    });
  });
}

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "cabadra-phone-test",
    firestore: { rules: fs.readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
});
afterAll(async () => { await testEnv?.cleanup(); });

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "brands", BRAND), {
      ownerUid: OWNER.uid, name: "Spice", tier: "multi", outletIds: [OUTLET],
      subscription: { status: "active", plan: "pro" },
    });
    await setDoc(doc(db, "brands", BRAND, "members", OWNER.uid), { role: "brand_owner", outletIds: [OUTLET] });
    await setDoc(doc(db, "restaurants", OUTLET), { brandId: BRAND, name: "Bandra" });
    await setDoc(doc(db, "restaurants", OUTLET, "staff", RECEPTION.uid), { role: "reception" });
    await setDoc(doc(db, "restaurants", OUTLET, "info", "settings"), { deliveryEnabled: true });
  });
});

describe("a verified diner is not staff", () => {
  it("cannot create a brand", async () => {
    // The failure this guards: phone sign-in gives a diner a real auth token,
    // and the brand rule only asked whether SOMEBODY was signed in. Every
    // curious customer could file themselves into the approvals queue.
    await assertFails(setDoc(doc(asDiner(), "brands", "b_mine"), {
      ownerUid: "u_diner", name: "Mine", tier: "single",
      subscription: { status: "pending_approval", plan: "basic" },
    }));
  });

  it("cannot create an org", async () => {
    await assertFails(setDoc(doc(asDiner(), "orgs", "org_mine"), { ownerUid: "u_diner", name: "Mine" }));
  });

  it("cannot read the outlet's staff list", async () => {
    await assertFails(getDoc(doc(asDiner(), "restaurants", OUTLET, "staff", RECEPTION.uid)));
  });

  it("cannot read another customer's delivery details", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "restaurants", OUTLET, "deliveryDetails", ORDER_ID),
        detailsFor(OTHER_PHONE));
    });
    await assertFails(getDoc(doc(asDiner(), "restaurants", OUTLET, "deliveryDetails", ORDER_ID)));
  });

  it("can read the delivery details filed under their own number", async () => {
    // This is what lets someone recover their order after a refresh without
    // opening every other customer's address alongside it.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "restaurants", OUTLET, "deliveryDetails", ORDER_ID),
        detailsFor(DINER_PHONE));
    });
    await assertSucceeds(getDoc(doc(asDiner(), "restaurants", OUTLET, "deliveryDetails", ORDER_ID)));
  });
});

describe("with verification switched off", () => {
  it("an anonymous diner can still place a delivery order", async () => {
    // Absent means off, which is what keeps every outlet already running today
    // working exactly as it does.
    await assertSucceeds(setDoc(
      doc(anon(), "restaurants", OUTLET, "deliveryDetails", ORDER_ID),
      detailsFor("")
    ));
  });
});

describe("with verification switched on", () => {
  beforeEach(() => setVerificationRequired(true));

  it("refuses an unverified diner", async () => {
    await assertFails(setDoc(
      doc(anon(), "restaurants", OUTLET, "deliveryDetails", ORDER_ID),
      detailsFor(DINER_PHONE)
    ));
  });

  it("accepts a diner filing under their own verified number", async () => {
    await assertSucceeds(setDoc(
      doc(asDiner(), "restaurants", OUTLET, "deliveryDetails", ORDER_ID),
      detailsFor(DINER_PHONE)
    ));
  });

  it("refuses a diner filing under somebody else's number", async () => {
    // The whole point. Without this the check is decorative: verify your own
    // phone, then submit an order against a number you do not hold.
    await assertFails(setDoc(
      doc(asDiner(), "restaurants", OUTLET, "deliveryDetails", ORDER_ID),
      detailsFor(OTHER_PHONE)
    ));
  });

  it("refuses a diner who omits the verified number entirely", async () => {
    await assertFails(setDoc(
      doc(asDiner(), "restaurants", OUTLET, "deliveryDetails", ORDER_ID),
      detailsFor("")
    ));
  });

  it("still refuses details with no address", async () => {
    await assertFails(setDoc(
      doc(asDiner(), "restaurants", OUTLET, "deliveryDetails", ORDER_ID),
      { name: "Asha", phone: "9876543210", phoneE164: DINER_PHONE, address: "" }
    ));
  });

  it("does not let a staff token pass as a verified diner", async () => {
    // Staff are not exempt from the diner rule -- they take orders through
    // reception, not through the customer form.
    await assertFails(setDoc(
      doc(asStaff(RECEPTION), "restaurants", OUTLET, "deliveryDetails", ORDER_ID),
      detailsFor(DINER_PHONE)
    ));
  });
});

describe("staff are unaffected by the provider split", () => {
  it("reception still reads delivery details for its own outlet", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "restaurants", OUTLET, "deliveryDetails", ORDER_ID),
        detailsFor(DINER_PHONE));
    });
    await assertSucceeds(getDoc(doc(asStaff(RECEPTION), "restaurants", OUTLET, "deliveryDetails", ORDER_ID)));
  });

  it("an owner can still create a brand", async () => {
    // The regression risk of isStaffAuth(): tightening the create rule must not
    // break signup for the people it is actually for.
    await assertSucceeds(setDoc(doc(asStaff(OWNER), "brands", "b_new"), {
      ownerUid: OWNER.uid, name: "New", tier: "single",
      subscription: { status: "pending_approval", plan: "basic" },
    }));
  });
});
