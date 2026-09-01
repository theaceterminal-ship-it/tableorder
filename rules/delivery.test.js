// Delivery orders, tested against the emulator.
//
// Delivery is the legitimate route for ordering without being in the
// restaurant, so it deliberately does NOT require a table token. That makes it
// the one path a stranger can write to, and these tests are what keep it from
// becoming the new hole.

import { describe, it, beforeAll, afterAll, beforeEach, expect } from "vitest";
import fs from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc, collection, getDocs } from "firebase/firestore";

let testEnv;
const BRAND = "b_spice";
const OUTLET = "o_bandra";
const OWNER = { uid: "u_owner", email: "owner@spice.test" };
const RECEPTION = { uid: "u_reception", email: "reception@spice.test" };
const OUTSIDER = { uid: "u_outsider", email: "x@y.test" };

const anon = () => testEnv.unauthenticatedContext().firestore();
const as = (u) => testEnv.authenticatedContext(u.uid, { email: u.email }).firestore();

const ORDER_ID = "ord_delivery_1";
const details = {
  name: "Asha", phone: "9876543210",
  address: "12 Hill Road, Bandra West", landmark: "Opp. bakery",
  createdAt: Date.now(),
};
const deliveryOrder = (extra = {}) => ({
  table: "DELIVERY",
  status: "pending",
  orderType: "delivery",
  items: [{ itemId: "dal", name: "Dal Makhani", qty: 1, price: 320 }],
  isVIP: false, etaMinutes: null, preparingAt: null,
  createdAt: Date.now(),
  ...extra,
});

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "cabadra-delivery-test",
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

describe("placing a delivery order", () => {
  it("works without any table token, which is the entire point", async () => {
    const db = anon();
    await assertSucceeds(setDoc(doc(db, "restaurants", OUTLET, "deliveryDetails", ORDER_ID), details));
    await assertSucceeds(setDoc(doc(db, "restaurants", OUTLET, "orders", ORDER_ID), deliveryOrder()));
  });

  it("FAILS without delivery details, so no order arrives with nowhere to go", async () => {
    await assertFails(setDoc(doc(anon(), "restaurants", OUTLET, "orders", ORDER_ID), deliveryOrder()));
  });

  it("FAILS when the details belong to a different order", async () => {
    const db = anon();
    await assertSucceeds(setDoc(doc(db, "restaurants", OUTLET, "deliveryDetails", "some_other_id"), details));
    await assertFails(setDoc(doc(db, "restaurants", OUTLET, "orders", ORDER_ID), deliveryOrder()));
  });

  it("FAILS when delivery is switched off for the outlet", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "restaurants", OUTLET, "info", "settings"), { deliveryEnabled: false });
    });
    const db = anon();
    await assertSucceeds(setDoc(doc(db, "restaurants", OUTLET, "deliveryDetails", ORDER_ID), details));
    await assertFails(setDoc(doc(db, "restaurants", OUTLET, "orders", ORDER_ID), deliveryOrder()));
  });

  it("still refuses to let the customer write a bill", async () => {
    const db = anon();
    await assertSucceeds(setDoc(doc(db, "restaurants", OUTLET, "deliveryDetails", ORDER_ID), details));
    await assertFails(setDoc(doc(db, "restaurants", OUTLET, "orders", ORDER_ID),
      deliveryOrder({ billTotal: 0 })));
  });

  it("still refuses a status jump", async () => {
    const db = anon();
    await assertSucceeds(setDoc(doc(db, "restaurants", OUTLET, "deliveryDetails", ORDER_ID), details));
    await assertFails(setDoc(doc(db, "restaurants", OUTLET, "orders", ORDER_ID),
      deliveryOrder({ status: "paid" })));
  });

  it("refuses an empty order", async () => {
    const db = anon();
    await assertSucceeds(setDoc(doc(db, "restaurants", OUTLET, "deliveryDetails", ORDER_ID), details));
    await assertFails(setDoc(doc(db, "restaurants", OUTLET, "orders", ORDER_ID),
      deliveryOrder({ items: [] })));
  });
});

describe("the customer's address", () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "restaurants", OUTLET, "deliveryDetails", ORDER_ID), details);
    });
  });

  it("cannot be read by a stranger who guesses the order id", async () => {
    // Orders are publicly readable so a diner can track their own. The address
    // and phone must NOT be, or every order id becomes a lookup for somebody's
    // home address.
    await assertFails(getDoc(doc(anon(), "restaurants", OUTLET, "deliveryDetails", ORDER_ID)));
  });

  it("cannot be listed", async () => {
    await assertFails(getDocs(collection(anon(), "restaurants", OUTLET, "deliveryDetails")));
  });

  it("cannot be read by staff at another restaurant", async () => {
    await assertFails(getDoc(doc(as(OUTSIDER), "restaurants", OUTLET, "deliveryDetails", ORDER_ID)));
  });

  it("is read by the outlet's own staff, who have to deliver to it", async () => {
    await assertSucceeds(getDoc(doc(as(RECEPTION), "restaurants", OUTLET, "deliveryDetails", ORDER_ID)));
  });

  it("cannot be rewritten by a stranger after the order is placed", async () => {
    await assertFails(setDoc(doc(anon(), "restaurants", OUTLET, "deliveryDetails", ORDER_ID),
      { ...details, address: "somewhere else" }));
  });

  it("refuses details with no phone number", async () => {
    await assertFails(setDoc(doc(anon(), "restaurants", OUTLET, "deliveryDetails", "ord_2"),
      { name: "X", address: "12 Hill Road, Bandra West" }));
  });

  it("refuses details with no address", async () => {
    await assertFails(setDoc(doc(anon(), "restaurants", OUTLET, "deliveryDetails", "ord_3"),
      { name: "X", phone: "9876543210" }));
  });
});
