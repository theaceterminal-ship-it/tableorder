// lib/otp.js
//
// The rules around a one-time code: how often one may be sent, how long it is
// good for, and how many wrong guesses end the attempt.
//
// Pure and time-injected, with no Firebase in sight, because this is the part
// worth testing. Every SMS costs real money and an unthrottled "Resend" button
// is a bill someone else can run up on your behalf — so the throttle is logic,
// not a disabled attribute on a button.
//
// The client-side limits here are a courtesy to the customer and a brake on
// accidental spend. They are NOT the security boundary: anyone can bypass them
// by reloading. Firebase enforces its own per-number and per-IP quotas server
// side, and that is what actually stops abuse.

import { toE164, samePhone } from "./phone";

export const OTP_LENGTH = 6;
export const RESEND_COOLDOWN_MS = 30_000;      // between one send and the next
export const MAX_SENDS_PER_WINDOW = 5;
export const SEND_WINDOW_MS = 60 * 60 * 1000;  // an hour
export const MAX_ATTEMPTS = 5;                 // wrong guesses before restarting
export const CODE_TTL_MS = 10 * 60 * 1000;

export const OTP_PHASES = {
  IDLE: "idle",         // no code requested yet
  SENDING: "sending",
  SENT: "sent",         // waiting for the customer to type it
  VERIFYING: "verifying",
  VERIFIED: "verified",
};

export function initialOtpState() {
  return {
    phase: OTP_PHASES.IDLE,
    phone: "",          // the E.164 the code was sent to
    verifiedPhone: "",  // the E.164 that has been proven
    sentAt: 0,
    sends: [],          // timestamps, for the hourly window
    attempts: 0,
    error: "",
  };
}

/** Sends still left in the rolling window. */
export function sendsRemaining(state, now = Date.now()) {
  const recent = (state.sends || []).filter((t) => now - t < SEND_WINDOW_MS);
  return Math.max(0, MAX_SENDS_PER_WINDOW - recent.length);
}

export function cooldownRemainingMs(state, now = Date.now()) {
  if (!state.sentAt) return 0;
  return Math.max(0, RESEND_COOLDOWN_MS - (now - state.sentAt));
}

/**
 * Whether a code may be sent to this number right now.
 *
 * Returns a reason rather than a bare false so the button can say why it is
 * disabled — "wait 12s" and "too many attempts, try later" need different
 * responses from the customer.
 */
export function canSend(state, rawPhone, now = Date.now()) {
  const e164 = toE164(rawPhone);
  if (!e164) return { ok: false, reason: "invalid", message: "Enter a valid phone number first." };
  if (state.phase === OTP_PHASES.SENDING) return { ok: false, reason: "busy", message: "Sending…" };

  // Changing the number resets the clock: it is a different phone, and making
  // someone wait out a cooldown they earned on a typo is pure friction.
  const sameNumber = samePhone(state.phone, e164);
  if (sameNumber && state.phase === OTP_PHASES.VERIFIED) {
    return { ok: false, reason: "verified", message: "This number is already verified." };
  }
  if (sameNumber) {
    const wait = cooldownRemainingMs(state, now);
    if (wait > 0) {
      return { ok: false, reason: "cooldown", waitMs: wait, message: `Resend in ${Math.ceil(wait / 1000)}s` };
    }
  }
  if (sendsRemaining(state, now) <= 0) {
    return { ok: false, reason: "quota", message: "Too many codes requested. Please try again later." };
  }
  return { ok: true, e164 };
}

export function beginSend(state, rawPhone) {
  const e164 = toE164(rawPhone);
  const changed = !samePhone(state.phone, e164);
  return {
    ...state,
    phase: OTP_PHASES.SENDING,
    phone: e164,
    error: "",
    // A code proven against one number says nothing about another.
    verifiedPhone: changed ? "" : state.verifiedPhone,
    attempts: changed ? 0 : state.attempts,
  };
}

export function sendSucceeded(state, now = Date.now()) {
  return {
    ...state,
    phase: OTP_PHASES.SENT,
    sentAt: now,
    sends: [...(state.sends || []).filter((t) => now - t < SEND_WINDOW_MS), now],
    attempts: 0,
    error: "",
  };
}

export function sendFailed(state, message) {
  // The failed send is not recorded against the quota — the customer got no
  // SMS, so charging them an attempt for our outage is wrong.
  return { ...state, phase: OTP_PHASES.IDLE, error: message || "Could not send the code." };
}

export function codeExpired(state, now = Date.now()) {
  // The phase is the guard — a state that has not reached SENT has no code to
  // expire. Testing sentAt as well would add a second, wrong condition.
  return state.phase === OTP_PHASES.SENT && now - state.sentAt > CODE_TTL_MS;
}

export function canVerify(state, code, now = Date.now()) {
  if (state.phase !== OTP_PHASES.SENT) return { ok: false, reason: "nocode", message: "Request a code first." };
  if (codeExpired(state, now)) return { ok: false, reason: "expired", message: "That code has expired. Send a new one." };
  if (state.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "attempts", message: "Too many wrong codes. Send a new one." };
  if (!isCodeComplete(code)) return { ok: false, reason: "incomplete", message: `Enter the ${OTP_LENGTH}-digit code.` };
  return { ok: true };
}

export function verifySucceeded(state) {
  return { ...state, phase: OTP_PHASES.VERIFIED, verifiedPhone: state.phone, attempts: 0, error: "" };
}

export function verifyFailed(state, message) {
  const attempts = state.attempts + 1;
  return {
    ...state,
    phase: OTP_PHASES.SENT,
    attempts,
    error: attempts >= MAX_ATTEMPTS
      ? "Too many wrong codes. Send a new one."
      : message || `That code is not right. ${MAX_ATTEMPTS - attempts} attempt${MAX_ATTEMPTS - attempts === 1 ? "" : "s"} left.`,
  };
}

/** Only six digits, and only the first six of them. */
export function normalizeCode(raw) {
  return String(raw || "").replace(/\D/g, "").slice(0, OTP_LENGTH);
}

export function isCodeComplete(raw) {
  return normalizeCode(raw).length === OTP_LENGTH;
}

/**
 * Is the number currently in the form the one that was actually proven?
 *
 * The whole point: editing the phone field after verifying must invalidate the
 * verification, or the check is theatre — verify your own number, then change
 * it to somebody else's before submitting.
 */
export function isPhoneVerified(state, rawPhone) {
  return !!state.verifiedPhone && samePhone(state.verifiedPhone, rawPhone);
}
