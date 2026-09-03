// lib/sentry-config.js
//
// Whether error monitoring turns on, and how, kept pure and testable —
// everything else in this codebase that decides something significant lives
// in lib/ with tests, and "does error reporting silently stay off" is exactly
// the kind of thing worth being sure about rather than assuming.
//
// Off by design until a DSN exists: instrumentation.js and
// instrumentation-client.js both check sentryEnabled() before calling
// Sentry.init() at all, so a dev session with no Sentry project configured
// yet never tries to talk to Sentry's servers, and never spams a project
// that does not exist.

export function sentryDsn(env = process.env) {
  return env.SENTRY_DSN || env.NEXT_PUBLIC_SENTRY_DSN || "";
}

export function sentryEnabled(env = process.env) {
  return sentryDsn(env) !== "";
}

/** Vercel sets this automatically; falls back to NODE_ENV where Vercel is absent (local dev). */
export function sentryEnvironmentName(env = process.env) {
  return env.VERCEL_ENV || env.NODE_ENV || "development";
}

export function sentryInitOptions(env = process.env) {
  const environment = sentryEnvironmentName(env);
  return {
    dsn: sentryDsn(env),
    environment,
    // A SAMPLE of requests get full performance tracing, not every one —
    // tracing every request would burn through a free-tier Sentry quota in
    // days on even modest traffic. Errors are always captured regardless of
    // this setting; this only controls performance-trace volume.
    tracesSampleRate: environment === "production" ? 0.2 : 1.0,
  };
}
