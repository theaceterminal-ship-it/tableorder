// Table sessions, tested against the emulator.
//
// This is the P0 that has been open since day one: an order could be placed
// from anywhere by anyone who could guess a URL, or onto somebody else's table
// by changing one digit. Written before the rules that satisfy them.

import { describe, it, beforeAll, afterAll, beforeEach, expect } from "vitest";
import fs from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc, collection, addDoc, getDocs } from "firebase/firestore";

let testEnv;

const BRAND = "b_spice";
const OUTLET = "o_bandra";
const OWNER = { uid: "u_owner", email: "owner@spice.test" };
const RECEPTION = { uid: "u_reception", email: "reception@spice.test" };

const T1_TOKEN = "k9f2a7x3mqr5tw8bnpvz";
const T2_TOKEN = "qq11ww22ee33rr44tt55";
const HOUR = 60 * 60 * 1000;

const anon = () => testEnv.unauthenticatedContext().firestore();
const as = (u) => testEnv.authenticatedContext(u.uid, { email: u.email }).firestore();

const order = (table, extra = {}) => ({
  table,
  status: "pending",
  items: [{ itemId: "dal", name: "Dal Makhani", qty: 1, price: 320 }],
  orderType: "dinein",
  isVIP: false,
  etaMinutes: null,
  preparingAt: null,
  createdAt: Date.now(),
  ...extra,
});

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "cabadra-session-test",
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

    // Table 1 is seated. Table 2 has a token but nobody sitting at it.
    await setDoc(doc(db, "restaurants", OUTLET, "tableSecrets", "1"), { token: T1_TOKEN });
    await setDoc(doc(db, "restaurants", OUTLET, "tableSecrets", "2"), { token: T2_TOKEN });
    await setDoc(doc(db, "restaurants", OUTLET, "tableSessions", "1"), {
      open: true, token: T1_TOKEN, openedAt: Date.now(), expiresAt: Date.now() + 4 * HOUR,
    });
  });
});

describe("the token nobody can read", () => {
  it("is unreadable by the diner, which is the entire mechanism", async () => {
    // If this ever passes, the scheme is worthless: an attacker would simply
    // look up the token for any table and order onto it.
    await assertFails(getDoc(doc(anon(), "restaurants", OUTLET, "tableSecrets", "1")));
  });

  it("is unreadable even by the restaurant's own staff", async () => {
    // Staff have no reason to read it, and it only takes one leaked screenshot.
    // The QR generator writes tokens; nothing reads them back.
    await assertFails(getDoc(doc(as(RECEPTION), "restaurants", OUTLET, "tableSecrets", "1")));
  });

  it("cannot be listed", async () => {
    await assertFails(getDocs(collection(anon(), "restaurants", OUTLET, "tableSecrets")));
  });

  it("cannot be overwritten by a diner to one they know", async () => {
    await assertFails(setDoc(doc(anon(), "restaurants", OUTLET, "tableSecrets", "1"), { token: "mine" }));
  });

  it("is written by outlet staff, so QR codes can be generated", async () => {
    await assertSucceeds(setDoc(doc(as(OWNER), "restaurants", OUTLET, "tableSecrets", "3"), { token: "newtoken000000000000" }));
  });
});

describe("placing an order", () => {
  it("succeeds with the right token at a seated table", async () => {
    await assertSucceeds(addDoc(collection(anon(), "restaurants", OUTLET, "orders"),
      order(1, { tableToken: T1_TOKEN })));
  });

  it("FAILS with no token at all — the sofa-ordering case", async () => {
    // Typing ?restaurant=…&table=1 by hand gets you exactly this.
    await assertFails(addDoc(collection(anon(), "restaurants", OUTLET, "orders"), order(1)));
  });

  it("FAILS with a guessed token", async () => {
    await assertFails(addDoc(collection(anon(), "restaurants", OUTLET, "orders"),
      order(1, { tableToken: "aaaaaaaaaaaaaaaaaaaa" })));
  });

  it("FAILS when using table 2's token on table 1", async () => {
    await assertFails(addDoc(collection(anon(), "restaurants", OUTLET, "orders"),
      order(1, { tableToken: T2_TOKEN })));
  });

  it("FAILS on a table nobody is sitting at, even with its real token", async () => {
    // Table 2's token is genuine; there is simply no open session.
    await assertFails(addDoc(collection(anon(), "restaurants", OUTLET, "orders"),
      order(2, { tableToken: T2_TOKEN })));
  });

  it("FAILS once the session has expired", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "restaurants", OUTLET, "tableSessions", "1"), {
        open: true, token: T1_TOKEN, openedAt: Date.now() - 9 * HOUR, expiresAt: Date.now() - HOUR,
      });
    });
    await assertFails(addDoc(collection(anon(), "restaurants", OUTLET, "orders"),
      order(1, { tableToken: T1_TOKEN })));
  });

  it("FAILS once the table has been cleared", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "restaurants", OUTLET, "tableSessions", "1"), {
        open: false, token: T1_TOKEN, expiresAt: Date.now() + 4 * HOUR,
      });
    });
    await assertFails(addDoc(collection(anon(), "restaurants", OUTLET, "orders"),
      order(1, { tableToken: T1_TOKEN })));
  });

  it("still works on a table whose QR has not been reprinted yet", async () => {
    // Protection turns on per table, when a secret exists for it. Table 9 has
    // none, so its old printed code keeps working — this is what makes the
    // rollout a migration rather than a flag day where every table breaks at
    // once. It is also, deliberately, the remaining hole: it closes for each
    // table the moment its new code is printed.
    await assertSucceeds(addDoc(collection(anon(), "restaurants", OUTLET, "orders"), order(9)));
  });

  it("protects a table the instant its secret is written", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "restaurants", OUTLET, "tableSecrets", "9"), { token: "zzz99999999999999999" });
    });
    await assertFails(addDoc(collection(anon(), "restaurants", OUTLET, "orders"), order(9)));
  });

  it("still refuses to let a diner write bill fields, token or not", async () => {
    await assertFails(addDoc(collection(anon(), "restaurants", OUTLET, "orders"),
      order(1, { tableToken: T1_TOKEN, billTotal: 0 })));
  });

  it("lets staff place an order without any token, because they are authenticated", async () => {
    await assertSucceeds(addDoc(collection(as(RECEPTION), "restaurants", OUTLET, "orders"),
      { ...order(7), status: "confirmed" }));
  });
});

describe("sessions", () => {
  it("are readable, so the diner's client can tell them their table is closed", async () => {
    // Deliberately readable: it holds no secret worth protecting beyond the
    // token, and a diner facing a refusal deserves to know why.
    await assertSucceeds(getDoc(doc(anon(), "restaurants", OUTLET, "tableSessions", "1")));
  });

  it("are opened and closed by staff", async () => {
    await assertSucceeds(setDoc(doc(as(RECEPTION), "restaurants", OUTLET, "tableSessions", "2"), {
      open: true, token: T2_TOKEN, openedAt: Date.now(), expiresAt: Date.now() + 4 * HOUR,
    }));
    await assertSucceeds(setDoc(doc(as(RECEPTION), "restaurants", OUTLET, "tableSessions", "1"), {
      open: false, token: T1_TOKEN, expiresAt: Date.now(),
    }, { merge: true }));
  });

  it("cannot be opened by a diner, which would defeat the seating requirement", async () => {
    await assertFails(setDoc(doc(anon(), "restaurants", OUTLET, "tableSessions", "2"), {
      open: true, token: T2_TOKEN, expiresAt: Date.now() + 4 * HOUR,
    }));
  });

  it("cannot be extended by a diner to keep a closed table alive", async () => {
    await assertFails(setDoc(doc(anon(), "restaurants", OUTLET, "tableSessions", "1"), {
      expiresAt: Date.now() + 90 * 24 * HOUR,
    }, { merge: true }));
  });
});
