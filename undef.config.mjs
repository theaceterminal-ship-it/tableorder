// Standalone config for a `no-undef` sweep. The project's Next config disables
// this rule, which is why an identifier used but never imported compiled fine
// and only exploded at runtime — twice.
export default [
  {
    files: ["**/*.js", "**/*.jsx"],
    languageOptions: {
      ecmaVersion: 2024, sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        window: "readonly", document: "readonly", console: "readonly", alert: "readonly",
        confirm: "readonly", prompt: "readonly", setTimeout: "readonly", clearTimeout: "readonly",
        setInterval: "readonly", clearInterval: "readonly", fetch: "readonly", Blob: "readonly",
        URL: "readonly", FileReader: "readonly", File: "readonly", localStorage: "readonly",
        navigator: "readonly", indexedDB: "readonly", process: "readonly", Notification: "readonly",
        AbortController: "readonly", structuredClone: "readonly", FormData: "readonly",
      },
    },
    // The project's eslint-disable comments reference rules that only exist in
    // the Next config, so they are unknown here. That is not a finding.
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: false },
    rules: { "no-undef": "error" },
  },
];
