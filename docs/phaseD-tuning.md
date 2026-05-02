# Phase D Tuning

## Enable tuning

Use either option, then reload the app:

- Open `http://localhost:5173/?phaseD=true`
- Or run `localStorage.DGM_PHASE_D_TUNING = 'true'` in the console, then reload

The tuning gate is active only when the Phase C aggregate lifecycle is active and one of those Phase D flags is set. Localhost exposes `window.__DGM_DEBUG`, but localhost alone does not enable tuning.

## Serve locally

Preferred command from the repo root:

```powershell
.\start.ps1
```

Fallback when `start.ps1` is unavailable:

```powershell
python -m http.server 5173
```

Canonical URL:

```text
http://localhost:5173/
```

## Console check

After the map loads, run:

```js
window.__DGM_DEBUG.isPhaseDTuningEnabled()
```

Expected result with `?phaseD=true` and active Phase C aggregate lifecycle: `true`.

Expected result on localhost without `?phaseD=true` and without `localStorage.DGM_PHASE_D_TUNING = 'true'`: `false`.

## Traffic discovery stop condition

Phase D traffic tuning discovers the existing traffic source and source-layer before adding `dgm-traffic`. If discovery cannot identify exactly one safe source/source-layer, the app stops the Phase D traffic overlay path and logs a console error beginning with:

```text
[DGM] Phase D traffic tuning stopped:
```

Report the console message, the listed layer ids, and the source/source-layer candidates before changing traffic wiring.

## Mobile and performance guard

Test the same URL on a phone by serving from the development machine and opening the machine LAN address with `?phaseD=true`. Pan, rotate, zoom through labels, and toggle traffic. If FPS drops below 30 after a tuning commit, revert that commit immediately.

## Rollback

Find the relevant commit hash:

```powershell
git log --oneline -8
```

Revert one focused tuning commit:

```powershell
git revert <commit-hash>
```

Re-test `http://localhost:5173/` after the revert and confirm the visual behavior is back to the prior state.
