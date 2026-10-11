# Open OCPP Trace — vendored schema and fixtures

Copied verbatim from [open-ocpp-trace/specification](https://github.com/open-ocpp-trace/specification)
at commit `c9c2499d821f6d5f7d5981da86b50d225c1d9ef8` (format version 1.1):

- `schema/trace-v1.schema.json` — the trace record JSON Schema;
- `fixtures/<name>/trace.jsonl` and `fixtures/<name>/expected.json` — the reference corpus.

These files are licensed under the Apache License 2.0 (see `LICENSE` in this
directory), not under this repository's MIT license. They are used only by the
test suite. `test/trace/conformance.ts` ports the reference consumer's
correlation and raw-fidelity checks from the specification's
`conformance/validate.mjs` (same license).
