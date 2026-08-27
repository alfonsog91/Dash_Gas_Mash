# Work Order 4 Acceptance

Branch: `agent/task-1787807004-wo4`

Stack base: `agent/task-1787807004-wo3` (WO-3 draft PR #23)

Status: `TODO: HUMAN_DEVICE_TEST`

## Scope

- Define exact physical iPhone Safari reproduction steps for vegetation.
- Define screenshot, console, network, device, build, and integrity evidence.
- Provide a fillable JSON evidence template.
- Enforce a human-approved Phase 6 gate before any vegetation fix work.

## Acceptance evidence

- [x] Protocol uses a physical iPhone and Safari, not emulation.
- [x] Protocol fixes the test center, owner flag, density, zoom bands, wait time,
  orientation, pan, background/resume, and toggle steps.
- [x] Eleven required screenshots have deterministic names and SHA-256 fields.
- [x] Evidence template parses as JSON and contains 11 unique evidence IDs.
- [x] Evidence template records exact build, device, session, environment,
  console, network, observations, redactions, and human approval.
- [x] Phase 6 requires `investigations/vegetation_evidence.json` and matching PR
  attachments before analysis or fix work.
- [x] Phase 6 requires named human approval and explicit analysis authorization.
- [x] No device result, screenshot, evidence file, or vegetation fix is claimed.
- [x] Agents are restricted to evidence validation and analysis.
- [ ] `TODO: HUMAN_DEVICE_TEST`: a human must execute Phases 1 through 5.

## Risk and rollback

This work changes documentation only. Its risk is an incomplete future evidence
package, which the Phase 6 gate rejects. Rollback is a revert of the focused
WO-4 commit. A vegetation fix requires a separate approved work order.
