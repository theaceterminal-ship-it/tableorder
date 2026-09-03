import { withSentryConfig } from '@sentry/nextjs/config';

/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin-allow-popups',
          },
        ],
      },
    ];
  },
};

// Wrapping the config is always safe, even with no Sentry project set up yet
// (see lib/sentry-config.js) — with no SENTRY_AUTH_TOKEN, the plugin skips
// source-map upload rather than failing the build. Source maps are what turn
// a minified stack trace back into the actual line of app code that threw;
// worth adding SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT once a real
// Sentry project exists, but the build works fine without them meanwhile.
export default withSentryConfig(nextConfig, {
  silent: true,
});