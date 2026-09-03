// Server and edge runtime error monitoring.
//
// Until now, if something broke on the server — a Firestore write throwing
// mid-request, a page crashing during render — the first anyone heard of it
// was a customer or a restaurant owner reporting it, or nobody ever hearing
// of it at all. This is what changes that: every unhandled server-side error
// gets reported to Sentry the moment it happens, with a stack trace, instead
// of silently vanishing into a log nobody is watching.
//
// A safe no-op with no DSN set — see the setup note in lib/sentry-config.js.
// That is deliberate: this file ships turned off so a dev session never
// spams a Sentry project that does not exist yet, and turns itself on the
// moment SENTRY_DSN is set, with no code change required.

import * as Sentry from "@sentry/nextjs";
import { sentryInitOptions, sentryEnabled } from "./lib/sentry-config.js";

export async function register() {
  if (!sentryEnabled()) return;
  if (process.env.NEXT_RUNTIME === "nodejs" || process.env.NEXT_RUNTIME === "edge") {
    Sentry.init(sentryInitOptions());
  }
}

// Catches errors from Server Components and Route Handlers that would
// otherwise only ever show up as a blank error page to whoever hit them.
export const onRequestError = Sentry.captureRequestError;
