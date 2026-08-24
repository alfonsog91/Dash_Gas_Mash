# External Research Dossier

**Retrieval date:** August 24, 2026
External evidence supports evaluation criteria; it does not prove that DGM
meets them.

## Probability and optimization

- `VERIFIED EXTERNALLY` — Gneiting and Raftery's *Strictly Proper Scoring
  Rules, Prediction, and Estimation* establishes proper scoring rules as a
  principled basis for probabilistic forecast evaluation. Source:
  [JASA DOI](https://doi.org/10.1198/016214506000001437).
  `RECOMMENDED` — use Brier/log scores and reliability analysis rather than
  relying on visual plausibility.
- `VERIFIED EXTERNALLY` — Nemhauser, Wolsey, and Fisher's analysis establishes
  the classical greedy guarantee for monotone submodular maximization under a
  cardinality constraint. Source:
  [Mathematical Programming DOI](https://doi.org/10.1007/BF01588971).
  `RECOMMENDED` — state the guarantee only after non-negativity, monotonicity,
  and the actual constraint family are verified.
- `VERIFIED EXTERNALLY` — calibration and discrimination are distinct; useful
  validation includes calibration-in-the-large, slope, and a flexible
  calibration curve. Source:
  [Van Calster et al.](https://doi.org/10.1186/s12916-019-1466-7).
- `VERIFIED EXTERNALLY` — MIP termination can yield a feasible incumbent
  without proving optimality. Source:
  [Google OR-Tools MIP introduction](https://developers.google.com/optimization/mip/mip_intro).
  `RECOMMENDED` — record status, incumbent, bound, gap, runtime, formulation,
  and seed rather than reporting solver presence as optimality.
- `VERIFIED EXTERNALLY` — predict-then-optimize separates estimation from a
  constrained decision model; it does not make synthetic labels equivalent to
  observed outcomes. Source:
  [DoorDash public engineering overview](https://careersatdoordash.com/blog/using-ml-and-optimization-to-solve-doordashs-dispatch-problem/).
- `VERIFIED EXTERNALLY` — published dispatch systems combine feasible-trip
  construction with constrained assignment, or learned long-term values with
  combinatorial optimization. Sources:
  [Alonso-Mora et al.](https://doi.org/10.1073/pnas.1611675114),
  [Xu et al.](https://doi.org/10.1145/3219819.3219824).
  `RECOMMENDED` — retain constrained OR as the baseline and treat learned value
  functions as inputs, not substitutes for feasibility and safety constraints.

## Accessibility and web platform

- `VERIFIED EXTERNALLY` — W3C publishes WCAG 2.2 and
  recommends using the current WCAG version for accessibility work. Source:
  [W3C WCAG overview](https://www.w3.org/WAI/standards-guidelines/wcag/).
- `VERIFIED EXTERNALLY` — MDN describes a web app manifest as the basis for
  installability criteria and explains that offline experience is separately
  implemented, commonly through a service worker. Source:
  [MDN installable PWAs](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable).
- `VERIFIED EXTERNALLY` — Google's Web Vitals guidance defines LCP, INP, and
  CLS as field-oriented user-experience signals and recommends real-user plus
  lab measurement. Source: [web.dev Vitals](https://web.dev/articles/vitals).

## Mobile and location privacy

- `VERIFIED EXTERNALLY` — Android's official location-permission guidance
  distinguishes foreground, approximate, precise, and background access and
  directs apps to request only the access needed. Source:
  [Android location permissions](https://developer.android.com/develop/sensors-and-location/location/permissions).
- `VERIFIED EXTERNALLY` — the W3C Geolocation Recommendation directs
  recipients to request location only when necessary, use it for the disclosed
  task, dispose of it afterward absent permission, and disclose retention and
  retransmission. Source:
  [W3C Geolocation privacy](https://www.w3.org/TR/geolocation/#privacy_recipient).
- `VERIFIED EXTERNALLY` — RFC 7946 warns that precise GeoJSON can have
  profound privacy implications and that parsers must anticipate oversized
  input. Source:
  [IETF RFC 7946](https://www.rfc-editor.org/rfc/rfc7946.html#section-10).
- `VERIFIED EXTERNALLY` — Capacitor's official Geolocation plugin documents
  Android permissions and platform-specific option behavior. Source:
  [Capacitor Geolocation](https://capacitorjs.com/docs/apis/geolocation).
- `RECOMMENDED` — a wrapper feasibility decision must include permission
  purpose, denial behavior, lifecycle, precision, and background-access review;
  WebView packaging alone is insufficient.

## Security

- `VERIFIED EXTERNALLY` — OWASP describes Content Security Policy as
  defense-in-depth and recommends delivering policy by HTTP response header.
  Source:
  [OWASP CSP Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html).
- `VERIFIED EXTERNALLY` — OWASP's third-party JavaScript guidance treats remote
  scripts as a supply-chain and data-access boundary. Source:
  [OWASP Third Party JavaScript Management](https://cheatsheetseries.owasp.org/cheatsheets/Third_Party_Javascript_Management_Cheat_Sheet.html).
- `RECOMMENDED` — assess CSP, provider token restriction, dependency pinning,
  integrity feasibility, URL/output validation, and deployed response headers
  together rather than treating a public client token as a standalone secret.

## AI, OCR, and screenshots

- `VERIFIED EXTERNALLY` — NIST AI RMF organizes AI risk work into Govern, Map,
  Measure, and Manage functions. Source:
  [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework).
- `VERIFIED EXTERNALLY` — the European Data Protection Board's OCR risk
  material identifies extraction, re-identification, unauthorized access, and
  retention risks. Source:
  [EDPB OCR risks and mitigations](https://www.edpb.europa.eu/system/files/2024-06/ai-risks_d2optical-character-recognition_edpb-spe-programme_en_2.pdf).
- `VERIFIED EXTERNALLY` — Microsoft responsible-AI OCR guidance emphasizes
  intended use, human oversight, limitations, privacy, and security. Source:
  [Microsoft OCR responsible use](https://learn.microsoft.com/en-us/azure/ai-services/foundry/responsible-ai/computer-vision/ocr-guidance-integration-responsible-use).
- `VERIFIED EXTERNALLY` — Android Photo Picker grants access only to
  user-selected media without broad library permission. Source:
  [Android Photo Picker](https://developer.android.com/training/data-storage/shared/photo-picker).
- `VERIFIED EXTERNALLY` — ML Kit states that text-recognition image/input
  processing remains on device while operational API metrics may be sent to
  Google. Source:
  [ML Kit terms and privacy](https://developers.google.com/ml-kit/terms).
- `VERIFIED EXTERNALLY` — Android warns against exposing native bridges to
  untrusted WebView content and recommends HTTPS and restricted file access.
  Sources:
  [WebView bridge risk](https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges),
  [unsafe file inclusion](https://developer.android.com/privacy-and-security/risks/webview-unsafe-file-inclusion).
- `RECOMMENDED` — require explicit capture/import, on-device redaction,
  source/confidence provenance, schema validation, user confirmation, bounded
  retention, and deletion before any OCR-derived value enters DGM state.

## Reliability synthesis

`VERIFIED EXTERNALLY` — Google's published "good" field thresholds are
seventy-fifth-percentile LCP at or below 2.5 seconds, INP at or below
200 milliseconds, and CLS at or below 0.1. Source:
[Core Web Vitals thresholds](https://web.dev/articles/defining-core-web-vitals-thresholds).
Lab diagnostics and field measurement answer different questions; source:
[lab versus field data](https://web.dev/articles/lab-and-field-data-differences).

`VERIFIED EXTERNALLY` — browser installability is not equivalent to offline
reliability; Chrome removed the service-worker fetch-handler requirement for
some menu-install flows. Source:
[Chrome install-criteria clarification](https://developer.chrome.com/blog/update-install-criteria).

`RECOMMENDED` — combine deterministic unit fixtures, synthetic spatial
scenarios, network-fault injection, browser/device matrices, field performance
measurement, and explicit stop conditions. External standards provide
evaluation methods, but only repository execution and representative outcome
data can verify DGM behavior and calibration.

## Citation verification record

**Verification date:** August 24, 2026
**Method:** `VERIFIED EXTERNALLY` through externally indexed primary-source and
publisher records. Direct fetches from the sandbox failed because outbound DNS
was unavailable; no citation is represented as directly fetched from the
sandbox.

Every linked citation above was checked for title/publisher identity and support
for the adjacent claim. The following corrections or qualifications were found:

- `VERIFIED EXTERNALLY` — the Xu et al. dispatch paper supports learned
  long-term value plus combinatorial dispatch, but the draft DOI was wrong. The
  corrected DOI is `https://doi.org/10.1145/3219819.3219824`.
- `VERIFIED EXTERNALLY` — Android location-permission content remains accurate;
  the citation now uses the canonical sensors-and-location path.
- `VERIFIED EXTERNALLY` — Microsoft OCR responsible-use content remains
  accurate; the citation now uses the canonical Azure AI Services path.
- `VERIFIED EXTERNALLY` — the DoorDash article content supports the claim, but
  the careers-domain URL is at migration risk; publisher identity and indexed
  article content were confirmed.
- `VERIFIED EXTERNALLY` — all remaining citations resolve in authoritative
  publisher or standards indexes and support their adjacent, narrowly stated
  claims.

## External-evidence limits

The following remain deliberately uncited or incompletely supported and must
not be promoted beyond their existing labels:

- `UNVERIFIED HYPOTHESIS` — DGM-specific congestion, minority-game,
  information-cascade, herding, or platform-feedback behavior;
- `RECOMMENDED`, not verified — robust OR, contextual bandit, offline RL, and
  multi-agent RL dispositions for this product;
- `UNKNOWN` — Mapbox commercial/WebView terms for any future wrapper;
- `UNKNOWN` — Play Store approval under any future background-location design;
- `UNKNOWN` — the magnitude of distracted-driving risk for this exact
  interface;
- `UNKNOWN` — whether any external method produces valid calibration,
  accessibility conformance, safety, or performance in DGM without repository
  execution and representative data.

External sources provide methods, constraints, and platform documentation. They
do not verify DGM's implementation quality, legal compliance, product benefit,
or suitability for use while driving.
