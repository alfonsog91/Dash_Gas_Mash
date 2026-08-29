# Test Execution Notes

Observed on 2026-08-26 from a clean `main-agent` checkout at
`e73df332076b25c3ff9fdc50f3ebef1dad3865c1`.

## Execution mode

- Node version: `v24.13.0`.
- `NODE_OPTIONS`: empty. No Node execution flags were active.
- Package mode: no `package.json` is present.
- The 25 files matching `tests/**/*.test.js` use ESM `import`/`export` syntax and
  each export one named function matching `run*Tests`.
- Existing repository documentation invokes runners with dynamic `import()` via
  `node -e`; those commands do not use module-related flags.
- A dynamic import of `tests/coordinates.test.js` succeeded without flags and
  exposed `runCoordinateTests`. Invoking it returned `{ "passed": 5,
  "failed": 0 }`.
- Direct execution with `node tests/coordinates.test.js` exited zero but ran no
  tests because the module only exports its runner (the browser load hook is
  inactive under Node).
- Node 24 can also return this ESM module namespace from `require()`. That is
  Node's require-of-ESM interoperability, not evidence that the source is
  CommonJS. Dynamic ESM import remains the repository's established mode.

The aggregator therefore uses the `.mjs` extension to make its own ESM mode
explicit and dynamically imports the existing `.js` runners. Adding
`package.json` with `"type": "module"` is not required for the observed mode.

## Clean baseline

A recursive, single-process dynamic-import probe discovered 25 runners, awaited
each invocation, and observed:

```text
PASS lines: 215
FAIL lines: 0
Exit code: 0
```

The preservation runner also reports 179 internal checks using its historical
check-mark output. Those lines do not begin with the `PASS` prefix and are
intentionally not included in the line-prefix baseline.
