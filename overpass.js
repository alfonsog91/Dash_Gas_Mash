// ──────────────────────────────────────────────────────────────────
// GOVERNANCE: This module fetches spatial data (§1 domain X).
// It does not perform scoring, aggregation, or advisory output.
// Signal independence (§2 S-1) is preserved: raw POI data is
// passed to model.js without pre-coupling or inference.
// See docs/GOVERNANCE.md and docs/CLASSIFICATION_REGISTRY.md.
// ──────────────────────────────────────────────────────────────────

const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
];

// Simple last-result cache per query type (food / parking).
// Avoids redundant Overpass fetches when the view hasn't changed.
const _overpassCache = { food: { key: null, data: null }, parking: { key: null, data: null } };

function bboxToOverpass(bbox) {
  // Explicitly Number()-coerce each bound so a monkey-patched or
  // non-numeric value throws instead of being silently interpolated.
  const south = Number(bbox.getSouth());
  const west  = Number(bbox.getWest());
  const north = Number(bbox.getNorth());
  const east  = Number(bbox.getEast());
  if (!isFinite(south) || !isFinite(west) || !isFinite(north) || !isFinite(east)) {
    throw new Error("Invalid bounding box coordinates");
  }
  return `${south},${west},${north},${east}`;
}

// Rounds bbox coords to 3 decimal places (~100 m) for cache key comparison.
function bboxCacheKey(bbox) {
  const r = (x) => Math.round(Number(x) * 1000) / 1000;
  return `${r(bbox.getSouth())},${r(bbox.getWest())},${r(bbox.getNorth())},${r(bbox.getEast())}`;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true }
      );
    }
  });
}

function shouldRetryStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

async function overpassQuery(query, signal) {
  const body = new URLSearchParams({ data: query });
  const errors = [];

  // Try each endpoint, with up to 2 attempts (backoff) per endpoint.
  for (const url of OVERPASS_URLS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
          body,
          signal,
        });

        if (res.ok) {
          const ct = res.headers.get("content-type") || "";
          if (ct.includes("application/json")) {
            return res.json();
          }

          const text = await res.text();
          errors.push(
            `Overpass ${new URL(url).host} returned non-JSON (${ct}): ${text.slice(0, 200)}`
          );
          break; // try next endpoint

          if (!json || !Array.isArray(json.elements)) {
            throw new Error("Overpass JSON missing elements array");
          }
        }

        const text = await res.text().catch(() => "");
        const msg = `Overpass ${new URL(url).host} HTTP ${res.status}: ${text.slice(0, 200)}`;
        errors.push(msg);

        if (!shouldRetryStatus(res.status)) break;

        // Exponential-ish backoff: 500ms then 1500ms.
        await sleep(attempt === 0 ? 500 : 1500, signal);
      } catch (e) {
        // Network/CORS errors are retriable on the next endpoint.
        errors.push(`Overpass ${new URL(url).host} failed: ${e?.message ?? String(e)}`);
        await sleep(attempt === 0 ? 300 : 900, signal);
      }
    }
  }

  throw new Error(
    `Overpass failed across endpoints (try zooming in / smaller area).\n` +
      errors.slice(0, 5).join("\n")
  );
}

function extractPointElements(osmJson) {
  const out = [];
  for (const el of osmJson.elements ?? []) {
    if (el.type === "node" && typeof el.lat === "number" && typeof el.lon === "number") {
      out.push({
        id: `node/${el.id}`,
        lat: el.lat,
        lon: el.lon,
        tags: el.tags ?? {},
      });
    }

    if (el.type === "way" && el.center && typeof el.center.lat === "number") {
      out.push({
        id: `way/${el.id}`,
        lat: el.center.lat,
        lon: el.center.lon,
        tags: el.tags ?? {},
      });
    }
  }
  return out;
}

export async function fetchFoodPlaces(bbox, signal) {
  const ck = bboxCacheKey(bbox);
  if (_overpassCache.food.key === ck && _overpassCache.food.data !== null) {
    return _overpassCache.food.data;
  }

  const b = bboxToOverpass(bbox);

  // Food merchant proxies: restaurants, fast food, cafes, food courts.
  // Keep query simple to reduce Overpass load.
  const query = `
  [out:json][timeout:25];
  (
    node[amenity~"^(restaurant|fast_food|cafe|food_court)$"](${b});
    way[amenity~"^(restaurant|fast_food|cafe|food_court)$"](${b});
  );
  out center tags qt;
  `;

  const json = await overpassQuery(query, signal);
  const result = extractPointElements(json);
  _overpassCache.food = { key: ck, data: result };
  return result;
}

export async function fetchParkingCandidates(bbox, signal) {
  const ck = bboxCacheKey(bbox);
  if (_overpassCache.parking.key === ck && _overpassCache.parking.data !== null) {
    return _overpassCache.parking.data;
  }

  const b = bboxToOverpass(bbox);

  // Parking proxies: amenity=parking and common parking tags.
  const query = `
  [out:json][timeout:25];
  (
    node[amenity=parking](${b});
    way[amenity=parking](${b});
    node[parking](${b});
    way[parking](${b});
  );
  out center tags qt;
  `;

  const json = await overpassQuery(query, signal);
  const result = extractPointElements(json);
  _overpassCache.parking = { key: ck, data: result };
  return result;
}
