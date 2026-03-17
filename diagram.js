export function renderModelDiagram(container) {
  const svg = `
  <svg viewBox="0 0 900 520" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Model diagram">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#2d6cdf"/>
        <stop offset="1" stop-color="#1f57ba"/>
      </linearGradient>
      <style>
        .box { fill: rgba(255,255,255,0.06); stroke: rgba(255,255,255,0.18); stroke-width: 2; rx: 16; }
        .title { fill: #e9eef7; font: 700 18px ui-sans-serif, system-ui; }
        .text { fill: rgba(233,238,247,0.85); font: 14px ui-sans-serif, system-ui; }
        .mono { fill: rgba(233,238,247,0.9); font: 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
        .arrow { stroke: rgba(233,238,247,0.55); stroke-width: 3; marker-end: url(#m); }
      </style>
      <marker id="m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(233,238,247,0.55)" />
      </marker>
    </defs>

    <rect class="box" x="30" y="30" width="360" height="140" />
    <text class="title" x="55" y="65">Public Inputs (OSM)</text>
    <text class="text" x="55" y="95">• Food POIs (restaurant / fast_food / cafe)</text>
    <text class="text" x="55" y="120">• Parking candidates (amenity=parking)</text>
    <text class="text" x="55" y="145">• Time-of-night slider (late-night weighting)</text>

    <line class="arrow" x1="390" y1="100" x2="460" y2="100" />

    <rect class="box" x="470" y="30" width="400" height="140" />
    <text class="title" x="495" y="65">Predict (ML-style)</text>
    <text class="text" x="495" y="95">Features from public proxies (OSM POIs, time)</text>
    <text class="text" x="495" y="120">Good=short pickup + higher-tip proxy</text>
    <text class="mono" x="495" y="148">rate=softplus(b+\u03b2·log(λ/λref));  P=1−e^{−rate·T}</text>

    <line class="arrow" x1="670" y1="170" x2="670" y2="235" />

    <rect class="box" x="470" y="245" width="400" height="190" />
    <text class="title" x="495" y="280">Optimize (MIP)</text>
    <text class="text" x="495" y="312">Select K parking lots maximizing expected value</text>
    <text class="text" x="495" y="340">Constraint: min separation between suggestions</text>
    <text class="text" x="495" y="368">Also renders heatmap + click breakdown</text>
    <text class="text" x="495" y="396">All transparent + tunable parameters</text>

    <line class="arrow" x1="390" y1="320" x2="460" y2="320" />

    <rect x="30" y="245" width="360" height="190" rx="16" fill="url(#g)" opacity="0.18" stroke="rgba(255,255,255,0.18)" stroke-width="2" />
    <text class="title" x="55" y="280">Visual Map Layer</text>
    <text class="text" x="55" y="312">Leaflet + OSM basemap (legal attribution)</text>
    <text class="text" x="55" y="340">Heat overlay + markers + click-to-center</text>
    <text class="text" x="55" y="368">Works for Inland Empire coverage by panning</text>

    <rect class="box" x="30" y="455" width="840" height="45" />
    <text class="text" x="55" y="485">Note: This is not DoorDash’s DeepRed or proprietary dispatch; it’s a public-data proxy inspired by public engineering writeups.</text>
  </svg>`;

  container.innerHTML = svg;
}
