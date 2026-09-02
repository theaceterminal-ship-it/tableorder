import { describe, it, expect } from "vitest";
import { toE164, isValidE164, maskPhone, samePhone, isReachablePhone } from "./phone";
import {
  initialOtpState, canSend, beginSend, sendSucceeded, sendFailed,
  canVerify, verifySucceeded, verifyFailed, isPhoneVerified,
  normalizeCode, isCodeComplete, codeExpired, sendsRemaining, cooldownRemainingMs,
  OTP_PHASES, MAX_SENDS_PER_WINDOW, MAX_ATTEMPTS, RESEND_COOLDOWN_MS, CODE_TTL_MS, SEND_WINDOW_MS,
} from "./otp";

describe("phone normalisation", () => {
  it("accepts the shapes people actually type", () => {
    expect(toE164("98765 43210")).toBe("+919876543210");
    expect(toE164("098765-43210")).toBe("+919876543210");
    expect(toE164("+91 98765 43210")).toBe("+919876543210");
    expect(toE164("919876543210")).toBe("+919876543210");
    expect(toE164("(98765) 43210")).toBe("+919876543210");
  });

  it("keeps an explicit country code rather than assuming India", () => {
    expect(toE164("+1 415 555 0132")).toBe("+14155550132");
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("refuses what it cannot turn into a real number", () => {
    // Returning "" beats guessing: a wrong country code texts a stranger.
    for (const bad of ["", null, undefined, "12345", "abcdef", "+", "+1"]) {
      expect(toE164(bad)).toBe("");
      expect(isReachablePhone(bad)).toBe(false);
    }
  });

  it("validates E.164 shape", () => {
    expect(isValidE164("+919876543210")).toBe(true);
    expect(isValidE164("919876543210")).toBe(false);
    expect(isValidE164("+0123456789")).toBe(false);
  });

  it("masks the middle but keeps the country code readable", () => {
    expect(maskPhone("9876543210")).toBe("+91 ······3210");
  });

  it("compares numbers by meaning, not by typing", () => {
    expect(samePhone("098765 43210", "+919876543210")).toBe(true);
    expect(samePhone("9876543210", "9876543211")).toBe(false);
    expect(samePhone("", "")).toBe(false);
  });
});

describe("sending a code", () => {
  const PHONE = "9876543210";

  it("refuses to send to a number that is not valid yet", () => {
    const r = canSend(initialOtpState(), "98765");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid");
  });

  it("allows the first send", () => {
    expect(canSend(initialOtpState(), PHONE).ok).toBe(true);
  });

  it("holds a resend behind the cooldown", () => {
    const s = sendSucceeded(beginSend(initialOtpState(), PHONE), 1000);
    const r = canSend(s, PHONE, 1000 + 5000);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("cooldown");
    expect(r.message).toContain("25s");
  });

  it("releases the cooldown once it has run out", () => {
    const s = sendSucceeded(beginSend(initialOtpState(), PHONE), 1000);
    expect(canSend(s, PHONE, 1000 + RESEND_COOLDOWN_MS).ok).toBe(true);
  });

  it("does not make a corrected typo wait out the old number's cooldown", () => {
    // The cooldown belongs to a number, not to the customer.
    const s = sendSucceeded(beginSend(initialOtpState(), "9876543210"), 1000);
    expect(canSend(s, "9876543219", 2000).ok).toBe(true);
  });

  it("stops after the hourly quota", () => {
    let s = initialOtpState();
    let t = 0;
    for (let i = 0; i < MAX_SENDS_PER_WINDOW; i++) {
      t += RESEND_COOLDOWN_MS;
      s = sendSucceeded(beginSend(s, PHONE), t);
    }
    expect(sendsRemaining(s, t)).toBe(0);
    const r = canSend(s, PHONE, t + RESEND_COOLDOWN_MS);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("quota");
  });

  it("lets the quota expire with the window", () => {
    let s = initialOtpState();
    let t = 0;
    for (let i = 0; i < MAX_SENDS_PER_WINDOW; i++) {
      t += RESEND_COOLDOWN_MS;
      s = sendSucceeded(beginSend(s, PHONE), t);
    }
    expect(canSend(s, PHONE, t + SEND_WINDOW_MS + 1).ok).toBe(true);
  });

  it("does not charge a failed send against the quota", () => {
    // We never sent an SMS, so the customer should not lose an attempt to it.
    const s = sendFailed(beginSend(initialOtpState(), PHONE), "network down");
    expect(sendsRemaining(s)).toBe(MAX_SENDS_PER_WINDOW);
    expect(s.phase).toBe(OTP_PHASES.IDLE);
    expect(s.error).toBe("network down");
  });

  it("does not re-send to a number already verified", () => {
    const s = verifySucceeded(sendSucceeded(beginSend(initialOtpState(), PHONE), 0));
    expect(canSend(s, PHONE, 10 ** 7).reason).toBe("verified");
  });

  it("reports the cooldown as zero before anything is sent", () => {
    expect(cooldownRemainingMs(initialOtpState())).toBe(0);
  });
});

describe("verifying a code", () => {
  const PHONE = "9876543210";
  const sent = (t = 0) => sendSucceeded(beginSend(initialOtpState(), PHONE), t);

  it("needs a code to have been sent", () => {
    expect(canVerify(initialOtpState(), "123456").reason).toBe("nocode");
  });

  it("needs all six digits", () => {
    expect(canVerify(sent(), "1234", 0).reason).toBe("incomplete");
    expect(canVerify(sent(), "123456", 0).ok).toBe(true);
  });

  it("expires a stale code", () => {
    const s = sent(0);
    expect(codeExpired(s, CODE_TTL_MS - 1)).toBe(false);
    expect(codeExpired(s, CODE_TTL_MS + 1)).toBe(true);
    expect(canVerify(s, "123456", CODE_TTL_MS + 1).reason).toBe("expired");
  });

  it("counts down wrong guesses and then stops", () => {
    let s = sent();
    s = verifyFailed(s);
    expect(s.error).toContain("4 attempts left");
    for (let i = 1; i < MAX_ATTEMPTS; i++) s = verifyFailed(s);
    expect(s.attempts).toBe(MAX_ATTEMPTS);
    expect(canVerify(s, "123456", 0).reason).toBe("attempts");
  });

  it("says 'attempt' not 'attempts' on the last one", () => {
    let s = sent();
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) s = verifyFailed(s);
    expect(s.error).toContain("1 attempt left");
  });

  it("marks the number proven on success", () => {
    const s = verifySucceeded(sent());
    expect(s.phase).toBe(OTP_PHASES.VERIFIED);
    expect(isPhoneVerified(s, PHONE)).toBe(true);
    expect(isPhoneVerified(s, "098765 43210")).toBe(true);
  });
});

describe("verification is bound to the number", () => {
  it("does not survive the customer editing the phone field", () => {
    // Otherwise the check is theatre: verify your own number, then swap in
    // someone else's before submitting.
    const s = verifySucceeded(sendSucceeded(beginSend(initialOtpState(), "9876543210"), 0));
    expect(isPhoneVerified(s, "9876543210")).toBe(true);
    expect(isPhoneVerified(s, "9000000000")).toBe(false);
  });

  it("clears a proven number when a code is sent to a different one", () => {
    let s = verifySucceeded(sendSucceeded(beginSend(initialOtpState(), "9876543210"), 0));
    s = beginSend(s, "9000000000");
    expect(s.verifiedPhone).toBe("");
    expect(isPhoneVerified(s, "9876543210")).toBe(false);
  });

  it("keeps it when resending to the same number", () => {
    let s = sendSucceeded(beginSend(initialOtpState(), "9876543210"), 0);
    s = verifySucceeded(s);
    s = beginSend(s, "098765 43210");
    expect(s.verifiedPhone).toBe("+919876543210");
  });

  it("treats an unverified state as unverified for any number", () => {
    expect(isPhoneVerified(initialOtpState(), "9876543210")).toBe(false);
  });
});

describe("code input", () => {
  it("keeps digits only and stops at six", () => {
    expect(normalizeCode("1 2-3 4 5 6")).toBe("123456");
    expect(normalizeCode("12345678")).toBe("123456");
    expect(normalizeCode("abc123")).toBe("123");
    expect(normalizeCode(null)).toBe("");
  });

  it("knows when it is complete", () => {
    expect(isCodeComplete("12345")).toBe(false);
    expect(isCodeComplete("123456")).toBe(true);
    expect(isCodeComplete("1234567")).toBe(true);
  });
});
