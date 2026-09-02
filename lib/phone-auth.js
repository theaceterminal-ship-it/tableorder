"use client";

// lib/phone-auth.js
//
// The Firebase half of phone verification: reCAPTCHA, sending the SMS, and
// exchanging the code for a signed-in identity.
//
// Firebase rather than Twilio, deliberately. Twilio would tell US that a code
// came back correct — a claim living in this app's memory, which a rule cannot
// see and a determined customer can skip by talking to Firestore directly.
// Firebase Phone Auth instead mints a real credential, so `request.auth.token
// .phone_number` shows up inside firestore.rules and the check becomes a
// boundary rather than a screen.
//
// -------------------------------------------------------------------------
// TURNING THIS ON  (no code changes needed — this file is already complete)
//
//   1. Firebase Console → Authentication → Sign-in method → enable "Phone".
//   2. Authentication → Settings → Authorized domains → add the domain the
//      customer site is served from. localhost is there by default.
//   3. For local testing without spending anything: Sign-in method → Phone →
//      "Phone numbers for testing" → add e.g. +91 99999 99999 with code
//      123456. No SMS is sent and no quota is consumed.
//   4. Set NEXT_PUBLIC_OTP_ENABLED=true in .env.local.
//
// There is no API key or account SID to paste anywhere: phone auth rides on
// the Firebase config already in lib/firebase.js. Step 4 is the whole switch.
//
// Costs money past the free tier, so it is per-outlet (info/settings ->
// requirePhoneVerification) as well as global — a brand can leave it off.
// -------------------------------------------------------------------------

import { auth } from "./firebase";
import { RecaptchaVerifier, signInWithPhoneNumber, signOut } from "firebase/auth";
import { toE164 } from "./phone";

/** The global switch. False keeps every call below a no-op. */
export function isOtpEnabled() {
  return process.env.NEXT_PUBLIC_OTP_ENABLED === "true";
}

/**
 * Whether a member of staff is signed in on this browser.
 *
 * Phone sign-in replaces whoever holds the session, so verifying a customer on
 * a device where reception is logged in would sign reception out mid-service.
 * Rare — staff and diners use different devices — but it happens the first time
 * an owner opens their own delivery site to check it, which is exactly the
 * person you least want to log out.
 */
export function staffSessionActive() {
  const u = auth.currentUser;
  if (!u) return false;
  return !u.providerData?.some((p) => p.providerId === "phone");
}

// The verifier owns a DOM node and a Google-issued challenge; recreating it per
// send leaks widgets and eventually fails silently.
let verifier = null;
let verifierContainerId = null;

export function clearRecaptcha() {
  try { verifier?.clear(); } catch {}
  verifier = null;
  verifierContainerId = null;
}

function ensureRecaptcha(containerId) {
  if (verifier && verifierContainerId === containerId) return verifier;
  clearRecaptcha();
  verifier = new RecaptchaVerifier(auth, containerId, {
    size: "invisible",
    // A challenge that expired is worthless; drop it so the next send builds a
    // fresh one instead of failing on a stale token.
    "expired-callback": () => clearRecaptcha(),
  });
  verifierContainerId = containerId;
  return verifier;
}

/**
 * Send a code. Returns an opaque handle to pass back to confirmOtpCode.
 *
 * The handle lives in memory only: a refresh loses it and the customer has to
 * request a new code. That is Firebase's design — the confirmation is tied to
 * the reCAPTCHA challenge, not to anything storable.
 */
export async function sendOtpCode(rawPhone, containerId) {
  if (!isOtpEnabled()) throw new Error("Phone verification is not enabled.");
  const e164 = toE164(rawPhone);
  if (!e164) throw new Error("That phone number does not look right.");

  try {
    return await signInWithPhoneNumber(auth, e164, ensureRecaptcha(containerId));
  } catch (err) {
    // A failed send usually burns the challenge, so the next attempt needs a
    // new one. Without this, one failure makes every later attempt fail too.
    clearRecaptcha();
    throw new Error(mapAuthError(err));
  }
}

/** Exchange the typed code for a verified identity. */
export async function confirmOtpCode(confirmation, code) {
  if (!confirmation) throw new Error("Request a code first.");
  try {
    const cred = await confirmation.confirm(code);
    return { uid: cred.user.uid, phoneNumber: cred.user.phoneNumber };
  } catch (err) {
    throw new Error(mapAuthError(err));
  }
}

/** The phone number Firebase has actually verified for this browser, if any. */
export function verifiedPhoneNumber() {
  const u = auth.currentUser;
  return u?.phoneNumber || "";
}

export async function signOutDiner() {
  if (auth.currentUser?.phoneNumber) await signOut(auth);
  clearRecaptcha();
}

/**
 * Firebase's error codes, in words a diner can act on.
 *
 * The raw codes leak implementation ("auth/too-many-requests") and give no hint
 * what to do next, which turns a recoverable typo into an abandoned order.
 */
export function mapAuthError(err) {
  switch (err?.code) {
    case "auth/invalid-phone-number":
      return "That phone number does not look right.";
    case "auth/invalid-verification-code":
      return "That code is not right.";
    case "auth/code-expired":
      return "That code has expired. Send a new one.";
    case "auth/too-many-requests":
      return "Too many attempts from this device. Please try again in a little while.";
    case "auth/quota-exceeded":
      return "We cannot send codes right now. Please try again later.";
    case "auth/captcha-check-failed":
    case "auth/missing-app-credential":
      return "Verification could not start. Please reload the page and try again.";
    case "auth/operation-not-allowed":
      // Reaching this in production means step 1 of the setup notes was missed.
      return "Phone verification is not switched on for this restaurant.";
    case "auth/network-request-failed":
      return "Network problem. Check your connection and try again.";
    default:
      return err?.message || "Something went wrong. Please try again.";
  }
}
