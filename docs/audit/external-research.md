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
- `VERIFIED EXTERNALLY` — predict-then-optimize separates estimation from a
  constrained decision model; it does not make synthetic labels equivalent to
  observed outcomes. Source:
  [DoorDash public engineering overview](https://careersatdoordash.com/blog/using-ml-and-optimization-to-solve-doordashs-dispatch-problem/).

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
  [Android location permissions](https://developer.android.com/training/location/permissions).
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
  [Microsoft OCR responsible use](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/computer-vision/ocr-guidance-integration-responsible-use).
- `RECOMMENDED` — require explicit capture/import, on-device redaction,
  source/confidence provenance, schema validation, user confirmation, bounded
  retention, and deletion before any OCR-derived value enters DGM state.

## Reliability synthesis

`RECOMMENDED` — combine deterministic unit fixtures, synthetic spatial
scenarios, network-fault injection, browser/device matrices, field performance
measurement, and explicit stop conditions. External standards provide
evaluation methods, but only repository execution and representative outcome
data can verify DGM behavior and calibration.
