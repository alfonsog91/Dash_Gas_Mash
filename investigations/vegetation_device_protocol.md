# Vegetation iPhone Safari Device Protocol

Status: `TODO: HUMAN_DEVICE_TEST`

This protocol separates physical-device evidence collection from agent analysis.
Only a human operating a physical iPhone may execute Phases 1 through 5. Agents
may prepare this protocol, validate the evidence file structure, and analyze
submitted evidence. Agents must not claim, simulate, or substitute device results.

## Scope

The investigation characterizes the existing Mapbox GL JS v2 vegetation overlay
on iPhone Safari. It does not authorize a vegetation implementation change.

Expected LOD behavior:

| Zoom | Expected mode |
| --- | --- |
| below 8 | hidden |
| 8 through 13.99 | aggregated extrusion |
| 14 and above | tree sprites |

The default test location is Rancho Cucamonga at latitude `34.1064`, longitude
`-117.5931`.

## Phase 1: Prepare the build

1. Use a physical iPhone, not Simulator, an emulated viewport, or a desktop
   browser.
2. Record the iPhone model, iOS version, Safari version, display zoom, text size,
   Low Power Mode state, network type, and orientation in
   `investigations/vegetation_evidence.json`.
3. Record the exact deployed HTTPS URL and 40-character Git commit SHA. Do not
   include access tokens, signed URLs, cookies, or credentials.
4. Confirm the tested commit contains no vegetation fix created from this
   investigation.
5. In Settings > Safari > Advanced, enable Web Inspector if console/network
   collection will be used. Connect the iPhone to a trusted Mac and inspect the
   page from Safari > Develop. If unavailable, record that limitation rather
   than substituting desktop evidence.
6. Remove site data for the test origin in Settings > Safari > Advanced > Website
   Data, then close all Safari tabs for that origin.

## Phase 2: Establish the clean baseline

1. Open the deployed app with this query string:
   `?vegetation=true`.
2. Wait until the map is visibly loaded and camera movement has stopped.
3. If Safari asks for location permission, choose **Don't Allow** so the map
   remains at the deterministic default center. Record the choice.
4. Confirm the map center is the Rancho Cucamonga default. Do not search, route,
   or move to another region.
5. Open the right-edge **Map** drawer.
6. Expand **Vegetation** and confirm its initial status is **Disabled**.
7. Capture `01-baseline-disabled.png`, showing the full Safari viewport, map,
   Map drawer, Vegetation control, and status.
8. Record any console error or failed request already present before enabling
   vegetation. Preserve the complete message and URL with secret query values
   redacted.

## Phase 3: Reproduce each LOD state

Use portrait orientation and keep the map centered on the default location.
After every zoom change, wait three seconds without touching the screen before
capturing evidence.

1. Turn on the **Vegetation** checkbox and leave **Density** at `1`.
2. Set zoom to `15` using normal pinch gestures. Capture
   `02-enabled-zoom15-sprites.png` with the control status and visible map.
3. Zoom out to `10`. Capture `03-enabled-zoom10-extrusions.png`.
4. Zoom out to `7`. Capture `04-enabled-zoom7-hidden.png`.
5. Return to zoom `15`, set **Density** to `6`, wait three seconds, and capture
   `05-density6-zoom15.png`.
6. Set **Density** back to `1`, wait three seconds, and capture
   `06-density1-restored-zoom15.png`.
7. Record for each step whether the observed mode was hidden, extrusion, sprite,
   mixed, blank, flickering, or other. Never infer a mode from the expected table.

If exact integer zoom cannot be read on-screen, use remote Web Inspector to run
`window.__DGM_DEBUG?.debugDumpState?.()?.camera?.zoom` only if that existing
surface is present. Otherwise record the zoom as `null`, include a screenshot of
the gesture state, and do not invent a value.

## Phase 4: Lifecycle reproduction

1. At zoom `15`, pan one screen east and release. Wait three seconds. Capture
   `07-pan-east-settled.png`.
2. Pan one screen west and release. Wait three seconds. Capture
   `08-pan-west-settled.png`.
3. Switch Safari to another app for 30 seconds, return to Safari, wait three
   seconds, and capture `09-resume-after-30s.png`.
4. Rotate to landscape, wait three seconds, and capture
   `10-landscape-zoom15.png`.
5. Rotate back to portrait, turn Vegetation off and on once, wait three seconds,
   and capture `11-toggle-restored.png`.
6. Record whether each transition preserved, duplicated, hid, flickered, or
   permanently lost vegetation.

## Phase 5: Collect evidence

Create `investigations/vegetation_evidence.json` from
`investigations/vegetation_evidence_template.json` and complete every field.

Required evidence:

- exact commit SHA and tested HTTPS URL without secrets;
- physical device and Safari metadata;
- all 11 PNG screenshots at native screenshot resolution;
- observed result and reproduction status for every protocol step;
- timestamps in UTC for session start and end;
- console errors and warnings, including count and first occurrence time;
- relevant failed network requests, HTTP status, and redacted URL;
- whether Low Power Mode, content blockers, Private Relay, or VPN were active;
- tester notes distinguishing visible facts from interpretation; and
- SHA-256 for every screenshot so PR attachments can be matched to the JSON.

Do not edit screenshots except to redact secrets or personal notifications. Any
redaction must be declared in the evidence JSON. Do not include precise live
location, account identity, cookies, tokens, or unrelated browsing data.

## Phase 6: Human approval gate

### TODO: HUMAN_DEVICE_TEST

No vegetation fix may be designed, generated, executed, committed, or proposed
until all of the following are true:

1. `investigations/vegetation_evidence.json` is attached to the vegetation PR.
2. Every required screenshot is attached and its SHA-256 matches the JSON.
3. The evidence records a physical iPhone Safari session and the exact tested
   commit.
4. A named human reviewer sets `humanApproval.status` to `approved`, records
   their name and UTC approval time, and approves the PR evidence in GitHub.
5. The reviewer explicitly authorizes analysis to proceed. Approval of evidence
   is not approval of a fix.

Until the gate is satisfied, agents may only report missing/contradictory
evidence and keep the status `TODO: HUMAN_DEVICE_TEST`. Agents never operate or
claim to operate the physical device.

After approval, analysis must cite evidence IDs and classify conclusions as
observed, inferred, or unknown. Any proposed vegetation fix requires a separate
work order, its own characterization, and the same device protocol rerun against
the fixed commit.
