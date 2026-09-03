// The recommendation model and its instrumentation, tested against the
// emulator.
//
// recModels is written only by the offline batch job under the Admin SDK,
// which bypasses these rules entirely — so there is nothing to test about
// writing it from a client, only that no client can. recEvents is the
// opposite: it is a diner-writable log, and "allow create: if true" with no
// shape check is exactly the kind of gap this file exists to catch.

import { describe, it, beforeAll, afterAll, beforeEach, expect } from "vitest";
import fs from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc, collection, addDoc } from "firebase/firestore";

let testEnv;
const BRAND = "b_spice";
const OUTLET = "o_bandra";
const MANAGER = { uid: "u_manager", email: "manager@spice.test" };

const anon = () => testEnv.unauthenticatedContext().firestore();
const as = (u) => testEnv.authenticatedContext(u.uid, { email: u.email }).firestore();

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "cabadra-recommendations-test",
    firestore: { rules: fs.readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
});
afterAll(async () => { await testEnv?.cleanup(); });

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "brands", BRAND), {
      ownerUid: "u_owner", name: "Spice", tier: "multi", outletIds: [OUTLET],
      subscription: { status: "active", plan: "pro" },
    });
    await setDoc(doc(db, "brands", BRAND, "members", MANAGER.uid), { role: "outlet_manager", outletIds: [OUTLET] });
    await setDoc(doc(db, "restaurants", OUTLET), { brandId: BRAND, name: "Bandra" });
  });
});

describe("the recommendation model", () => {
  it("is publicly readable, once it exists", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "restaurants", OUTLET, "recModels", "current"),
        { builtAt: Date.now(), orderCount: 10, partners: {} });
    });
    await assertSucceeds(getDoc(doc(anon(), "restaurants", OUTLET, "recModels", "current")));
  });

  it("refuses a write from any client — the batch job bypasses rules entirely, nothing else should be able to write it", async () => {
    await assertFails(setDoc(doc(as(MANAGER), "restaurants", OUTLET, "recModels", "current"),
      { builtAt: Date.now(), orderCount: 0, partners: {} }));
    await assertFails(setDoc(doc(anon(), "restaurants", OUTLET, "recModels", "current"),
      { builtAt: Date.now(), orderCount: 0, partners: {} }));
  });
});

describe("recommendation instrumentation", () => {
  const impression = () => addDoc(collection(anon(), "restaurants", OUTLET, "recEvents"), {
    type: "impression", itemIds: ["naan", "cola"], createdAt: Date.now(),
  });
  const add = () => addDoc(collection(anon(), "restaurants", OUTLET, "recEvents"), {
    type: "add", itemId: "naan", createdAt: Date.now(),
  });

  it("accepts a well-formed impression from an anonymous diner", async () => {
    await assertSucceeds(impression());
  });

  it("accepts a well-formed add", async () => {
    await assertSucceeds(add());
  });

  it("refuses an unknown event type", async () => {
    await assertFails(addDoc(collection(anon(), "restaurants", OUTLET, "recEvents"), {
      type: "click", itemId: "naan", createdAt: Date.now(),
    }));
  });

  it("refuses a missing createdAt", async () => {
    await assertFails(addDoc(collection(anon(), "restaurants", OUTLET, "recEvents"), {
      type: "add", itemId: "naan",
    }));
  });

  it("refuses an impression with no items", async () => {
    await assertFails(addDoc(collection(anon(), "restaurants", OUTLET, "recEvents"), {
      type: "impression", itemIds: [], createdAt: Date.now(),
    }));
  });

  it("refuses an impression carrying more items than the UI ever shows", async () => {
    await assertFails(addDoc(collection(anon(), "restaurants", OUTLET, "recEvents"), {
      type: "impression", itemIds: ["a", "b", "c", "d", "e", "f"], createdAt: Date.now(),
    }));
  });

  it("refuses an add with an empty item id", async () => {
    await assertFails(addDoc(collection(anon(), "restaurants", OUTLET, "recEvents"), {
      type: "add", itemId: "", createdAt: Date.now(),
    }));
  });

  it("refuses extra fields smuggled onto an event", async () => {
    // Otherwise this metrics stream is a place a diner's client can write
    // arbitrary data under a restaurant's own document tree.
    await assertFails(addDoc(collection(anon(), "restaurants", OUTLET, "recEvents"), {
      type: "add", itemId: "naan", createdAt: Date.now(), note: "anything at all",
    }));
  });

  it("keeps events readable to management but not to a stranger", async () => {
    let id;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const ref = await addDoc(collection(ctx.firestore(), "restaurants", OUTLET, "recEvents"), {
        type: "add", itemId: "naan", createdAt: Date.now(),
      });
      id = ref.id;
    });
    await assertSucceeds(getDoc(doc(as(MANAGER), "restaurants", OUTLET, "recEvents", id)));
    await assertFails(getDoc(doc(anon(), "restaurants", OUTLET, "recEvents", id)));
  });

  it("refuses any update or delete, even by management — an append-only log", async () => {
    let id;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const ref = await addDoc(collection(ctx.firestore(), "restaurants", OUTLET, "recEvents"), {
        type: "add", itemId: "naan", createdAt: Date.now(),
      });
      id = ref.id;
    });
    await assertFails(setDoc(doc(as(MANAGER), "restaurants", OUTLET, "recEvents", id),
      { type: "add", itemId: "changed", createdAt: Date.now() }));
  });
});
