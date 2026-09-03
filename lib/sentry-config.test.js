import { describe, it, expect } from "vitest";
import { sentryDsn, sentryEnabled, sentryEnvironmentName, sentryInitOptions } from "./sentry-config";

describe("sentryDsn", () => {
  it("prefers the server-only DSN when both are set", () => {
    expect(sentryDsn({ SENTRY_DSN: "server-dsn", NEXT_PUBLIC_SENTRY_DSN: "public-dsn" })).toBe("server-dsn");
  });

  it("falls back to the public DSN for the client bundle", () => {
    expect(sentryDsn({ NEXT_PUBLIC_SENTRY_DSN: "public-dsn" })).toBe("public-dsn");
  });

  it("is empty with neither set", () => {
    expect(sentryDsn({})).toBe("");
  });
});

describe("sentryEnabled", () => {
  it("stays off until a DSN exists — a dev session must never spam a project that is not configured", () => {
    expect(sentryEnabled({})).toBe(false);
    expect(sentryEnabled({ SENTRY_DSN: "" })).toBe(false);
  });

  it("turns on the moment either DSN is set, no code change required", () => {
    expect(sentryEnabled({ SENTRY_DSN: "x" })).toBe(true);
    expect(sentryEnabled({ NEXT_PUBLIC_SENTRY_DSN: "x" })).toBe(true);
  });
});

describe("sentryEnvironmentName", () => {
  it("prefers Vercel's own environment label", () => {
    expect(sentryEnvironmentName({ VERCEL_ENV: "production", NODE_ENV: "production" })).toBe("production");
    expect(sentryEnvironmentName({ VERCEL_ENV: "preview", NODE_ENV: "production" })).toBe("preview");
  });

  it("falls back to NODE_ENV outside Vercel", () => {
    expect(sentryEnvironmentName({ NODE_ENV: "development" })).toBe("development");
  });

  it("defaults to development with neither set", () => {
    expect(sentryEnvironmentName({})).toBe("development");
  });
});

describe("sentryInitOptions", () => {
  it("samples less aggressively in production, to protect a free-tier quota", () => {
    const prod = sentryInitOptions({ VERCEL_ENV: "production", SENTRY_DSN: "x" });
    const dev = sentryInitOptions({ NODE_ENV: "development", SENTRY_DSN: "x" });
    expect(prod.tracesSampleRate).toBeLessThan(dev.tracesSampleRate);
  });

  it("carries the resolved dsn and environment through", () => {
    const opts = sentryInitOptions({ VERCEL_ENV: "preview", SENTRY_DSN: "abc" });
    expect(opts.dsn).toBe("abc");
    expect(opts.environment).toBe("preview");
  });
});
