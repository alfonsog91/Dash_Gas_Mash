import {
  PLACE_SCHEMA_VERSION,
  normalizePlace,
  isValidPlace,
  serializePlace,
  deserializePlace,
  normalizeHours,
} from "../../intelligence/place_model.js";

const PASS = "PASS";
const FAIL = "FAIL";

function createLogger() {
  const logEl = typeof document !== "undefined" ? document.getElementById("log") : null;
  const entries = [];
  return {
    write(message) {
      entries.push(message);
      if (logEl) {
        logEl.textContent = `${entries.join("\n")}\n`;
      }
      console.log(message);
    },
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

function assertThrows(fn, message) {
  let thrown = false;
  try {
    fn();
  } catch {
    thrown = true;
  }
  assert(thrown, message);
}

const GOOGLE_LIKE_PAYLOAD = Object.freeze({
  place_id: "ChIJ_synthetic_001",
  name: "Guasti Gas & Go",
  geometry: { location: { lat: 34.063412, lng: -117.589934 } },
  types: ["gas_station", "convenience_store"],
  formatted_phone_number: "(909) 555-0148",
  websiteUri: "https://example.com/guasti-gas",
  rating: 4.37,
  opening_hours: {
    periods: [
      { open: { day: 1, time: "0600" }, close: { day: 1, time: "2200" } },
      { open: { day: 0, time: "0700" }, close: { day: 0, time: "2100" } },
    ],
    weekday_text: ["Sunday: 7:00 AM – 9:00 PM", "Monday: 6:00 AM – 10:00 PM"],
  },
  photos: [
    { photo_reference: "ref-a", width: 1600, height: 1200, html_attributions: ["Owner A"] },
    "ref-b",
  ],
  lastFetchedTs: 1_700_000_000_000,
});

export function runPlaceModelTests() {
  const log = createLogger();
  let passed = 0;
  let failed = 0;

  function runTest(name, fn) {
    try {
      fn();
      passed += 1;
      log.write(`${PASS} ${name}`);
    } catch (error) {
      failed += 1;
      log.write(`${FAIL} ${name}: ${error.message}`);
    }
  }

  log.write("DGM Phase G place model tests");

  runTest("normalizes a Google-like provider payload into the canonical shape", () => {
    const place = normalizePlace(GOOGLE_LIKE_PAYLOAD);
    assertEqual(place.id, "ChIJ_synthetic_001", "place_id maps to id");
    assertEqual(place.name, "Guasti Gas & Go", "name is carried through");
    assertEqual(place.lat, 34.063412, "nested geometry latitude is read");
    assertEqual(place.lon, -117.589934, "nested geometry longitude is read");
    assertEqual(place.category, "gas_station", "first type becomes the category");
    assertEqual(place.phone, "(909) 555-0148", "formatted phone is preserved as dialable text");
    assertEqual(place.website, "https://example.com/guasti-gas", "website uri is normalized");
    assertEqual(place.rating, 4.4, "rating is clamped and rounded to one decimal");
    assertEqual(place.lastFetchedTs, 1_700_000_000_000, "lastFetchedTs is carried through");
  });

  runTest("structured hours are sorted deterministically", () => {
    const place = normalizePlace(GOOGLE_LIKE_PAYLOAD);
    assertDeepEqual(place.hours.periods, [
      { day: 0, open: "0700", close: "2100" },
      { day: 1, open: "0600", close: "2200" },
    ], "periods are sorted by day then open time");
    assertDeepEqual(place.hours.weekdayText, [
      "Sunday: 7:00 AM – 9:00 PM",
      "Monday: 6:00 AM – 10:00 PM",
    ], "weekday text is preserved");
  });

  runTest("photo refs are normalized to bounded metadata only", () => {
    const place = normalizePlace(GOOGLE_LIKE_PAYLOAD);
    assertDeepEqual(place.photoRefs, [
      { ref: "ref-a", width: 1600, height: 1200, attribution: "Owner A" },
      { ref: "ref-b", width: null, height: null, attribution: null },
    ], "photo refs keep metadata only and accept string shorthand");
  });

  runTest("photo refs are capped to a bounded count", () => {
    const manyPhotos = Array.from({ length: 25 }, (_, index) => `ref-${index}`);
    const place = normalizePlace({ ...GOOGLE_LIKE_PAYLOAD, photos: manyPhotos });
    assert(place.photoRefs.length === 10, "photo refs are capped at the bounded maximum");
  });

  runTest("required fields are validated", () => {
    assertThrows(() => normalizePlace({ name: "No Id", lat: 1, lon: 2 }), "missing id throws");
    assertThrows(() => normalizePlace({ id: "x", lat: 1, lon: 2 }), "missing name throws");
    assertThrows(() => normalizePlace({ id: "x", name: "n", lon: 2 }), "missing lat throws");
    assertThrows(() => normalizePlace({ id: "x", name: "n", lat: 1 }), "missing lon throws");
    assertThrows(() => normalizePlace({ id: "x", name: "n", lat: 200, lon: 2 }), "out-of-range lat throws");
    assertThrows(() => normalizePlace(null), "null payload throws");
  });

  runTest("invalid optional fields degrade to null", () => {
    const place = normalizePlace({
      id: "x",
      name: "n",
      lat: 1,
      lon: 2,
      website: "javascript:alert(1)",
      rating: 99,
      hours: { periods: [{ day: 9, open: "9999", close: "0000" }] },
    });
    assertEqual(place.website, null, "non-http websites are dropped");
    assertEqual(place.rating, 5, "out-of-range rating is clamped to 5");
    assertEqual(place.hours, null, "fully invalid hours degrade to null");
  });

  runTest("isValidPlace mirrors normalize validation", () => {
    assert(isValidPlace(GOOGLE_LIKE_PAYLOAD) === true, "valid payload is reported valid");
    assert(isValidPlace({ name: "no id" }) === false, "invalid payload is reported invalid");
  });

  runTest("serialization round-trips to the canonical shape", () => {
    const place = normalizePlace(GOOGLE_LIKE_PAYLOAD);
    const record = serializePlace(place);
    assertEqual(record.schemaVersion, PLACE_SCHEMA_VERSION, "serialized record carries the schema version");
    const roundTripped = deserializePlace(record);
    assertDeepEqual(roundTripped, place, "deserialize(serialize(place)) equals the original place");
  });

  runTest("normalization is deterministic", () => {
    const first = normalizePlace(GOOGLE_LIKE_PAYLOAD);
    const second = normalizePlace(GOOGLE_LIKE_PAYLOAD);
    assertDeepEqual(first, second, "identical inputs produce identical output");
  });

  runTest("normalizeHours accepts the canonical day/open/close form", () => {
    const hours = normalizeHours({ hours: [{ day: "Tue", open: "08:30", close: "1730" }] });
    assertDeepEqual(hours, {
      periods: [{ day: 2, open: "0830", close: "1730" }],
      weekdayText: null,
    }, "named days and HH:MM times normalize to the canonical period form");
  });

  const result = { passed, failed };
  log.write(`Results: ${passed} passed, ${failed} failed`);
  if (typeof document !== "undefined") {
    document.title = failed === 0
      ? `All ${passed} place model tests passed`
      : `${failed}/${passed + failed} place model tests failed`;
  }
  return result;
}

if (typeof window !== "undefined") {
  window.addEventListener("load", runPlaceModelTests);
}
