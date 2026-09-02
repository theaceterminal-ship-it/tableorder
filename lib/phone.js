// lib/phone.js
//
// Turning what someone types into a number an SMS can actually reach.
//
// Firebase Phone Auth requires E.164 ("+919876543210") and rejects anything
// else outright. People type "98765 43210", "098765-43210", "+91 98765 43210"
// and "919876543210", all meaning the same number, so the normalising happens
// here rather than being half-done at three call sites.

export const DEFAULT_COUNTRY_CODE = "+91";

/** Digits only, dropping spaces, dashes, brackets and the leading plus. */
export function digitsOf(raw) {
  return String(raw || "").replace(/\D/g, "");
}

/**
 * Convert to E.164, or return "" when it cannot be one.
 *
 * Returning "" rather than a best guess is deliberate: a wrong country code
 * sends the code to a stranger's phone and tells the customer their number is
 * fine, which is worse than refusing it.
 */
export function toE164(raw, defaultCode = DEFAULT_COUNTRY_CODE) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";

  const cc = digitsOf(defaultCode);
  const explicit = trimmed.startsWith("+");
  let d = digitsOf(trimmed);

  if (explicit) return d.length >= 11 && d.length <= 15 ? `+${d}` : "";

  // A domestic trunk prefix: "0 98765 43210" is dialled inside the country and
  // the zero is not part of the number.
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);

  if (d.length === 10) return `+${cc}${d}`;
  // Already carries the country code, just without the plus.
  if (d.length === 10 + cc.length && d.startsWith(cc)) return `+${d}`;

  return "";
}

export function isValidE164(value) {
  return /^\+[1-9]\d{9,14}$/.test(String(value || ""));
}

/** Whether what someone has typed so far could become a reachable number. */
export function isReachablePhone(raw, defaultCode = DEFAULT_COUNTRY_CODE) {
  return isValidE164(toE164(raw, defaultCode));
}

/**
 * For display back to the customer: enough to recognise their own number,
 * not enough to be useful on a shoulder-surfed screen.
 */
export function maskPhone(raw, defaultCode = DEFAULT_COUNTRY_CODE) {
  const e164 = toE164(raw, defaultCode);
  if (!e164) return String(raw || "");
  const d = digitsOf(e164);
  // Whatever sits in front of the last ten digits is the country code, which
  // stays visible — it is not the secret part, and hiding it makes the number
  // harder to recognise as your own.
  const cc = d.length > 10 ? d.slice(0, d.length - 10) : "";
  const rest = d.slice(cc.length);
  return `+${cc} ${"·".repeat(Math.max(0, rest.length - 4))}${rest.slice(-4)}`.trim();
}

/** Two numbers are the same number if they normalise to the same E.164. */
export function samePhone(a, b, defaultCode = DEFAULT_COUNTRY_CODE) {
  const x = toE164(a, defaultCode);
  return !!x && x === toE164(b, defaultCode);
}
