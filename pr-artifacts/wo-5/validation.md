# Work Order 5 Validation

Date: 2026-08-26

Stack base: `20ceae5b41983dfcf3209b1a941081f298ac1776`

## Workflow contract

```text
event: pull_request
base filters: main-agent, agent/**
runner: windows-latest
shell: pwsh
Node source: .nvmrc (24.13.0)
command: node eng/run_all_tests.mjs
artifact: test-results.txt
artifact condition: always()
```

No secret is read or written by the workflow.

## Green path

The exact PowerShell body used by the workflow produced:

```text
Test summary: PASS 233, FAIL 0
Recorded baseline: PASS 233
Exit: 0
test-results.txt: created
```

## Temporary red path

One coordinate assertion was changed locally and never committed or pushed.
The exact workflow body produced:

```text
FAIL accepts lat and lng: intentional WO-5 CI failure probe
Test summary: PASS 232, FAIL 1
Recorded baseline: PASS 233
PASS count is below baseline: 232 < 233
Exit: 1
```

The assertion was restored, `git diff -- tests/coordinates.test.js` returned no
output, and the exact workflow body returned to the 233 PASS baseline with exit
0. The generated local `test-results.txt` was deleted before staging.

## Remote limitation

Draft PR #25 ran `Exported Node runners` successfully in GitHub Actions run
`33047259964`, job `98434068497`.

Producing an actual remote red check would require committing or pushing the
intentional break, which the execution rules prohibit. The same command, output
artifact, and exit propagation were exercised locally instead.
