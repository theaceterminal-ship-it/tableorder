// Browser-side error monitoring.
//
// The customer- and reception-facing screens run almost entirely client
// side — a Firestore listener throwing, a render crash on the ordering page
// — and none of that reaches a server log at all. This is what catches it:
// every unhandled error in a customer's or a staff member's browser gets
// reported here, the same way instrumentation.js catches server-side ones.
//
// Off by design until a DSN exists — see lib/sentry-config.js.

import * as Sentry from "@sentry/nextjs";
import { sentryInitOptions } from "./lib/sentry-config.js";

// This exact expression — process.env.NEXT_PUBLIC_SENTRY_DSN, written out in
// full, right here — is what lets Next.js inline the real value into the
// browser bundle at build time. It replaces this literal text; it does not
// give the browser a working process.env object to read from generally. The
// pure, tested sentryDsn()/sentryEnabled() helpers in lib/sentry-config.js
// take an env PARAMETER instead of reading process.env directly, which is
// exactly right for server code (Node always has real env vars, however you
// reach them) but is invisible to this build-time substitution here — a
// silent miss that shows up as Sentry.init() correctly compiled into the
// bundle but never actually enabled — the code is present, the condition
// guarding it just never resolves true.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init(sentryInitOptions({ NEXT_PUBLIC_SENTRY_DSN: dsn }));
}

// Required by the SDK so navigation between pages shows up as its own trace
// in Sentry's performance view, rather than every route change being
// invisible to it. Harmless no-op while Sentry is disabled — it only ever
// fires through Sentry's own router instrumentation, which init() above
// never wires up when there is no DSN.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
