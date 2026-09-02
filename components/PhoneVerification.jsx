"use client";

// components/PhoneVerification.jsx
//
// The phone field, plus the code exchange that proves it.
//
// It owns the whole interaction — typing the number, requesting a code, the
// cooldown, the six digits, the verified badge — and reports upward with one
// callback. The parent keeps the number in its own form state; this component
// only ever tells it whether that number has been PROVEN.
//
// All the decisions (may we send yet, has this expired, how many guesses are
// left) live in lib/otp.js and are unit tested there. What is left here is
// presentation and the two async calls.

import { useEffect, useRef, useState } from "react";
import {
  initialOtpState, canSend, beginSend, sendSucceeded, sendFailed,
  canVerify, verifySucceeded, verifyFailed, isPhoneVerified,
  normalizeCode, cooldownRemainingMs, OTP_PHASES, OTP_LENGTH,
} from "@/lib/otp";
import { maskPhone } from "@/lib/phone";
import { sendOtpCode, confirmOtpCode, staffSessionActive } from "@/lib/phone-auth";

const RECAPTCHA_ID = "cabadra-recaptcha";

const box = {
  width: "100%", padding: "13px 14px", fontSize: 15, borderRadius: 12,
  boxSizing: "border-box", background: "#fff", fontFamily: "inherit",
  border: "1.5px solid #e6e1d6",
};

export default function PhoneVerification({
  phone,
  onPhoneChange,
  onVerifiedChange,
  fieldError,
  required = true,
  label = "Phone number",
  placeholder = "98765 43210",
}) {
  const [otp, setOtp] = useState(initialOtpState);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0); // drives the cooldown countdown
  const confirmationRef = useRef(null);

  const verified = isPhoneVerified(otp, phone);

  // The parent decides whether to allow submission, so it is told every time
  // this changes — including when it goes BACK to false because the customer
  // edited the number after verifying it.
  useEffect(() => { onVerifiedChange?.(verified); }, [verified, onVerifiedChange]);

  // A once-a-second re-render so the "Resend in 12s" label counts down.
  //
  // Depends on primitives, never on the otp object: a state object in a
  // dependency array changes identity on every update, which is how this
  // codebase has already produced one render loop.
  useEffect(() => {
    if (otp.phase !== OTP_PHASES.SENT) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [otp.phase, otp.sentAt]);

  const sendCheck = canSend(otp, phone);
  const cooldown = Math.ceil(cooldownRemainingMs(otp) / 1000);

  async function handleSend() {
    const check = canSend(otp, phone);
    if (!check.ok) { setOtp((s) => ({ ...s, error: check.message })); return; }

    // Phone sign-in replaces whoever holds this browser's session. Refusing
    // here beats silently logging a member of staff out of their own POS.
    if (staffSessionActive()) {
      setOtp((s) => ({
        ...s,
        error: "You are signed in as staff on this device. Use a private window to test the customer flow.",
      }));
      return;
    }

    setBusy(true);
    setOtp((s) => beginSend(s, phone));
    try {
      confirmationRef.current = await sendOtpCode(phone, RECAPTCHA_ID);
      setCode("");
      setOtp((s) => sendSucceeded(s));
    } catch (e) {
      setOtp((s) => sendFailed(s, e.message));
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify(value = code) {
    const check = canVerify(otp, value);
    if (!check.ok) { setOtp((s) => ({ ...s, error: check.message })); return; }
    setBusy(true);
    try {
      await confirmOtpCode(confirmationRef.current, normalizeCode(value));
      setOtp((s) => verifySucceeded(s));
    } catch (e) {
      setOtp((s) => verifyFailed(s, e.message));
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ fontSize: 12, fontWeight: 700, color: "#888", display: "block", marginBottom: 5 }}>
        {label}{required ? "" : " (optional)"}
      </label>

      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="tel"
          value={phone}
          placeholder={placeholder}
          disabled={verified}
          onChange={(e) => onPhoneChange(e.target.value)}
          style={{
            ...box,
            flex: 1,
            border: `1.5px solid ${fieldError ? "#dc2626" : verified ? "#bbf7d0" : "#e6e1d6"}`,
            background: verified ? "#f0fdf4" : "#fff",
          }}
        />
        {verified ? (
          <button
            type="button"
            onClick={() => { setOtp(initialOtpState()); setCode(""); onPhoneChange(""); }}
            className="tap-btn"
            style={{ ...box, width: "auto", border: "none", background: "transparent", color: "#888", fontSize: 13, cursor: "pointer" }}
          >
            Change
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSend}
            disabled={busy || !sendCheck.ok}
            className="tap-btn"
            style={{
              ...box, width: "auto", whiteSpace: "nowrap", border: "none", cursor: busy || !sendCheck.ok ? "not-allowed" : "pointer",
              background: busy || !sendCheck.ok ? "#e6e1d6" : "#1a1a2e",
              color: busy || !sendCheck.ok ? "#888" : "#fff",
              fontSize: 13.5, fontWeight: 700,
            }}
          >
            {busy && otp.phase === OTP_PHASES.SENDING ? "Sending…"
              : cooldown > 0 && otp.phase === OTP_PHASES.SENT ? `${cooldown}s`
              : otp.phase === OTP_PHASES.SENT ? "Resend"
              : "Send code"}
          </button>
        )}
      </div>

      {fieldError && <div style={{ color: "#dc2626", fontSize: 12, marginTop: 4 }}>{fieldError}</div>}

      {verified && (
        <div style={{ color: "#166534", fontSize: 12.5, marginTop: 6, fontWeight: 600 }}>
          ✓ {maskPhone(phone)} verified
        </div>
      )}

      {otp.phase === OTP_PHASES.SENT && !verified && (
        <div style={{ marginTop: 10, background: "#faf8f5", border: "1px solid #e6e1d6", borderRadius: 12, padding: 12 }}>
          <div style={{ fontSize: 12.5, color: "#666", marginBottom: 8 }}>
            We sent a {OTP_LENGTH}-digit code to <strong>{maskPhone(phone)}</strong>.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              placeholder="123456"
              onChange={(e) => {
                const next = normalizeCode(e.target.value);
                setCode(next);
                // Submitting on the sixth digit saves a tap, and matches what
                // every other OTP field people use already does.
                if (next.length === OTP_LENGTH) handleVerify(next);
              }}
              style={{ ...box, flex: 1, letterSpacing: 4, fontSize: 17, fontWeight: 700, textAlign: "center" }}
            />
            <button
              type="button"
              onClick={() => handleVerify()}
              disabled={busy || normalizeCode(code).length !== OTP_LENGTH}
              className="tap-btn"
              style={{
                ...box, width: "auto", border: "none", fontSize: 13.5, fontWeight: 700,
                background: normalizeCode(code).length === OTP_LENGTH && !busy ? "#e8a33d" : "#e6e1d6",
                color: "#1a1a2e",
                cursor: busy ? "wait" : "pointer",
              }}
            >
              {busy ? "…" : "Verify"}
            </button>
          </div>
        </div>
      )}

      {otp.error && !verified && (
        <div style={{ color: "#b91c1c", fontSize: 12.5, marginTop: 6 }}>{otp.error}</div>
      )}

      {/* Invisible reCAPTCHA anchors here. Firebase requires the element to
          exist before a code can be requested, so it is always rendered. */}
      <div id={RECAPTCHA_ID} />
    </div>
  );
}
