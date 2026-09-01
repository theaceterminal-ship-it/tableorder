// lib/table-sessions-store.js
//
// Writing the two documents that protect a table: its permanent token, and
// whether it is currently seated.
//
// The token is written when a QR code is generated and never read back by
// anything — not by staff, not by this file. Only a security rule can see it,
// which is what makes the whole scheme work. That also means REGENERATING a
// code invalidates the printed one, so it is a deliberate act with a warning
// attached rather than something that happens quietly.

import { db } from "./firebase";
import { doc, getDoc, setDoc, updateDoc, writeBatch } from "firebase/firestore";
import { generateTableToken, sessionExpiry, SESSION_HOURS } from "./table-session";

const secretRef = (outletId, tableNumber) =>
  doc(db, "restaurants", outletId, "tableSecrets", String(tableNumber));
const sessionRef = (outletId, tableNumber) =>
  doc(db, "restaurants", outletId, "tableSessions", String(tableNumber));

/**
 * Give a table a token, returning it so a QR code can be drawn.
 *
 * The token is returned ONCE, here, and never readable again. Print the code
 * now or generate a fresh one later; there is no way to look this value up.
 */
export async function issueTableToken(outletId, tableNumber) {
  const token = generateTableToken();
  await setDoc(secretRef(outletId, tableNumber), {
    token,
    issuedAt: Date.now(),
  });
  return token;
}

/** Whether a table has been given a token yet, without revealing it. */
export async function hasTableToken(outletId, tableNumber) {
  try {
    // Reading tableSecrets is denied to every client, so existence is checked
    // by attempting the read and treating a denial as "it is protected". A
    // missing document reads successfully and reports not-exists.
    const snap = await getDoc(secretRef(outletId, tableNumber));
    return snap.exists();
  } catch {
    // permission-denied means the document is there and guarded, which is
    // exactly the state we are asking about.
    return true;
  }
}

/**
 * Seat a table: open a session so its QR code starts accepting orders.
 *
 * Sessions expire on their own so a table nobody remembered to clear stops
 * taking orders overnight rather than staying open indefinitely.
 */
export async function openTableSession(outletId, tableNumber, { hours = SESSION_HOURS } = {}) {
  const now = Date.now();
  await setDoc(sessionRef(outletId, tableNumber), {
    open: true,
    openedAt: now,
    expiresAt: sessionExpiry(now, hours),
  }, { merge: true });
}

/** Clear a table: its code stops accepting orders immediately. */
export async function closeTableSession(outletId, tableNumber) {
  await setDoc(sessionRef(outletId, tableNumber), {
    open: false,
    closedAt: Date.now(),
    expiresAt: Date.now(),
  }, { merge: true });
}

/** Give a long sitting more time without reopening a closed table. */
export async function extendTableSession(outletId, tableNumber, { hours = SESSION_HOURS } = {}) {
  await updateDoc(sessionRef(outletId, tableNumber), {
    expiresAt: sessionExpiry(Date.now(), hours),
  });
}

/**
 * Seat several tables at once — used when a party is spread across a merged
 * group, so one action does not leave half the party unable to order.
 */
export async function openSessionsFor(outletId, tableNumbers, { hours = SESSION_HOURS } = {}) {
  const now = Date.now();
  const batch = writeBatch(db);
  tableNumbers.forEach((n) => {
    batch.set(sessionRef(outletId, n), {
      open: true, openedAt: now, expiresAt: sessionExpiry(now, hours),
    }, { merge: true });
  });
  await batch.commit();
}

export async function closeSessionsFor(outletId, tableNumbers) {
  const now = Date.now();
  const batch = writeBatch(db);
  tableNumbers.forEach((n) => {
    batch.set(sessionRef(outletId, n), { open: false, closedAt: now, expiresAt: now }, { merge: true });
  });
  await batch.commit();
}
