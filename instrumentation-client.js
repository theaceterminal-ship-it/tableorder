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
import { sentryInitOptions, sentryEnabled } from "./lib/sentry-config.js";

if (sentryEnabled()) {
  Sentry.init(sentryInitOptions());
}

// Required by the SDK so navigation between pages shows up as its own trace
// in Sentry's performance view, rather than every route change being
// invisible to it. Harmless no-op while Sentry is disabled — it only ever
// fires through Sentry's own router instrumentation, which init() above
// never wires up when there is no DSN.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
