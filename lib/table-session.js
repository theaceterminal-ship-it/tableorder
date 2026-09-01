// lib/table-session.js
//
// Proving that whoever is ordering is actually sitting at the table.
//
// THE PROBLEM
// A QR code encodes ?restaurant=<outletId>&table=3. Both are guessable, so
// typing that URL from anywhere worked exactly as well as scanning it at the
// table: you could order from home, or onto somebody else's tab by changing one
// digit.
//
// THE MECHANISM
// Security rules can read documents the client cannot. tableSecrets/{table}
// holds a random token with `allow read: if false`, so no client can ever look
// it up — but a rule can, via get(). The token travels in the QR code, the
// diner's client sends it back when placing an order, and the rule compares the
// two. The client proves it knows the secret without being able to read it.
//
// A second condition is that the table has an OPEN session, which is what stops
// orders arriving for an empty table or in the middle of the night.
//
// WHAT THIS DOES NOT SOLVE
// Someone who physically sat at the table and photographed the code still holds
// a valid token. The session requirement limits how long that is useful for, and
// strict seating (below) removes it entirely at the cost of staff having to
// seat tables. The threat model moves from "anyone who can type a URL" to
// "someone who has actually been in the restaurant", which is the point.

/** How long a session stays valid without being renewed. */
export const SESSION_HOURS = 4;

/**
 * A table's token.
 *
 * 20 characters from a 32-symbol alphabet is about 100 bits — not guessable,
 * and short enough to keep the QR code sparse and easy to scan on a cheap
 * phone camera. Ambiguous characters are excluded so a token stays readable if
 * anyone ever has to type or read one aloud.
 */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function generateTableToken(randomValues) {
  const bytes = randomValues || crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function sessionExpiry(from = Date.now(), hours = SESSION_HOURS) {
  return from + hours * 60 * 60 * 1000;
}

/** Is this session usable right now? */
export function isSessionOpen(session, now = Date.now()) {
  if (!session) return false;
  if (session.open !== true) return false;
  if (!session.expiresAt) return false;
  return session.expiresAt > now;
}

/**
 * Why an order cannot be placed, or null when it can.
 *
 * Returns a reason rather than a boolean so the diner sees something they can
 * act on — "ask a staff member to seat you" is useful, "denied" is not.
 */
export function orderBlockedReason({ token, session, strictSeating = false, now = Date.now() }) {
  if (!token) return "no-token";
  if (!session) return strictSeating ? "not-seated" : "no-session";
  if (session.token && session.token !== token) return "wrong-table";
  if (!isSessionOpen(session, now)) return "session-expired";
  return null;
}

export const BLOCKED_MESSAGES = {
  "no-token": "This link is missing its table code. Please scan the QR code on your table.",
  "no-session": "This table isn't open for ordering yet. Please ask a staff member.",
  "not-seated": "Please ask a staff member to seat you before ordering.",
  "wrong-table": "This code doesn't match this table. Please scan the code on your own table.",
  "session-expired": "This ordering session has ended. Please scan the QR code again.",
};

/** The diner URL for a table, including its token. */
export function tableUrl(origin, outletId, tableNumber, token) {
  const params = new URLSearchParams({ restaurant: outletId, table: String(tableNumber) });
  if (token) params.set("t", token);
  return `${origin}/table?${params.toString()}`;
}
