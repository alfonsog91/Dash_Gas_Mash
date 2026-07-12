# Phase G Security & Static-Hosting Model

Date: 2026-06-10
Branch: `feature/upgrade-all-aggressive`

Dash Gas Mash is a static site served from GitHub Pages. There is **no server**,
so there are **no server-side response headers** — only `<meta>` tags are
available for policy, and any third-party keys must be client-safe. Phase G's
Place Pages, provider adapters, and website preview are designed around these
constraints.

## Threat model summary

- No secret can be hidden in client code. Anything shipped is public.
- Third-party content (website previews) is untrusted and may be hostile.
- Provider Terms of Service constrain what may be cached and for how long.
- User privacy: no raw traces or identifiers are stored.

## Website preview (sandboxed iframe + new-tab fallback)

The place card previews a place's website in a sandboxed `<iframe>`:

- The sandbox token set **never combines `allow-scripts` with `allow-same-origin`**
  for third-party content — that combination lets a framed page remove its own
  sandbox. `resolveWebsitePreviewPlan()` strips `allow-same-origin` if both are
  present. Default tokens: `allow-scripts allow-popups allow-popups-to-escape-sandbox`.
- Only `http(s)` URLs are eligible; other schemes (e.g. `javascript:`) resolve to
  `{ mode: "none" }` and are never framed.
- `referrerpolicy="no-referrer"` is set on the iframe.
- **Expect framing to be blocked.** Many sites send `X-Frame-Options: DENY` or a
  CSP `frame-ancestors` directive. The card therefore always renders a visible
  "Open site" control that opens the site in a new tab with
  `window.open(url, "_blank", "noopener,noreferrer")`, and auto-falls-back (with a
  short load-timeout) when the frame errors or never loads.
- Phone numbers become `tel:` links built from dialable characters only.

## Content Security Policy (meta only)

On GitHub Pages, CSP can only be delivered via a `<meta http-equiv="Content-Security-Policy">`
tag in `index.html` (there are no server headers). Note that `frame-ancestors`
and `sandbox` are **ignored** in meta-delivered CSP; rely on the iframe `sandbox`
attribute (above) for framing isolation. A meta CSP, if added, should be a
separate reviewed change; Phase G does not modify `index.html`.

## Provider keys (referrer-restricted or serverless proxy)

- **No API keys are committed to the repo.** The synthetic provider needs none.
- Real adapters receive credentials at runtime via the provider registry config
  hook. Two acceptable patterns:
  1. **Referrer-restricted client keys** (e.g. an HTTP-referrer-locked Google Maps
     browser key) — public by necessity, but locked to the Pages origin. Lowest
     friction; still rate-limit and monitor.
  2. **Reviewed serverless proxy** — a small function holds the secret server-side
     and the client calls the proxy. Required when a provider forbids client-side
     keys. This is a separate, explicitly approved change.
- Never log keys; never place keys in query strings that get cached.

## Provider TOS / caching caveats

`describe().cachePolicy` advertises what each provider permits caching; the cache
and photos handler honor it:

- **Google Places**: most fields may **not** be cached beyond `place_id`. Configure
  such adapters with a restrictive `cachePolicy` and `canCacheThumbnail: () => false`.
  Treat names/hours/photos as session-only for these providers.
- **Foursquare / others**: check the specific TOS; set TTL and cacheable-field
  limits accordingly.
- **OSM/Overpass** (already used in the app): attribution required; respect tile
  and API usage policy.
- Full-resolution photo **bytes are never cached** by `place_photos.js`
  (`getFullResolution` returns a URL only). Only bounded, re-encoded thumbnails are
  cached, and only when `canCacheThumbnail` allows it.

## Privacy

- The place cache stores only bounded place metadata + safe thumbnails. No raw
  user GPS traces or identifiers are persisted.
- The GPS smoother in `intelligence/navigation_adapter.js` operates in memory only.
- Debug surfaces (`window.__DGM_DEBUG`, runtime diagnostics) are gated by
  `shouldExposePhaseDDebug()` (Phase D tuning requested or a localhost debug host)
  and expose no secrets.

## Perf-guard effect-constant pattern

Heavy Phase G effects (`phaseGPlacePhotos`, `phaseGVegetationLayer`,
`phaseGVehicleModel`) are registered by appending constants to the frozen
`PHASE_E_PERFORMANCE_GUARD_EFFECTS` object in `performance/monitor.js`, following
the Phase F `OPPORTUNITY_OVERLAY` precedent. The guard remains all-or-nothing on
trip; see `docs/phaseG-vegetation.md` for the full pattern.

## Test instructions

- Local server: `./start.ps1` (or `& ./.venv/Scripts/python.exe -m http.server 5173`), then open `http://localhost:5173/`.
- Browser smoke: `http://localhost:5173/tests/browser-smoke.html` — verifies the place card's sandboxed iframe, the new-tab fallback path, `tel:` links, photo lazy-loading, and debug gating, with zero captured console/page/Mapbox errors.
- Node unit tests live under `tests/intelligence/`; the perf-guard suite is `tests/perf-guard.test.js`. Run with, e.g.:

```sh
node -e "import('./tests/perf-guard.test.js').then(m => m.runPerfGuardTests()).then(r => { if (r.failed) process.exit(1); })"
```

- Manual website-preview check: open a place whose site blocks framing (e.g. a
  major retailer) and confirm the preview falls back to the "Open site" new-tab
  control rather than rendering inline.
