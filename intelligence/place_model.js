// Phase G place data model.
//
// Canonical, provider-agnostic representation of a tappable place. The model is
// intentionally bounded: it carries only the fields the Place Pages UI needs plus
// lightweight photo *references* (never raw image bytes). Provider payloads are
// normalized into this shape so the cache, photos handler, and UI never have to
// branch on provider-specific field names.
//
// Approximations / assumptions documented inline:
// - Structured hours are normalized to a deterministic { periods, weekdayText }
//   form. Provider-specific timezone rules are NOT modeled; periods are treated
//   as local wall-clock times exactly as the provider reported them.
// - Only http(s) websites are kept; anything else is dropped to null so the UI
//   never tries to frame a non-web scheme.
// - photoRefs hold metadata only (ref id + optional dimensions/attribution) to
//   respect provider TOS that forbid caching the underlying image bytes.

const PLACE_SCHEMA_VERSION = 1;

const MAX_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 200;
const MAX_CATEGORY_LENGTH = 80;
const MAX_PHONE_LENGTH = 40;
const MAX_WEBSITE_LENGTH = 2048;
const MAX_PHOTO_REFS = 10;
const MAX_PHOTO_REF_LENGTH = 512;
const MAX_ATTRIBUTION_LENGTH = 256;
const MAX_WEEKDAY_TEXT_ENTRIES = 7;
const MAX_WEEKDAY_TEXT_LENGTH = 160;

const DAY_NAME_TO_INDEX = Object.freeze({
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
});

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function toFiniteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function round6(value) {
  return Math.round((Number(value) || 0) * 1000000) / 1000000;
}

function normalizeString(value, maxLength) {
  if (typeof value !== "string") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value).slice(0, maxLength);
    }
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.slice(0, maxLength);
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  // Returns undefined (not null) so numeric coercion of a missing field yields
  // NaN rather than 0 (Number(null) === 0), keeping required-field validation honest.
  return undefined;
}

function normalizeId(payload) {
  const id = normalizeString(
    firstDefined(payload?.id, payload?.place_id, payload?.placeId, payload?.fsq_id),
    MAX_ID_LENGTH
  );
  if (!id) {
    throw new TypeError("place id is required and must be a non-empty string");
  }
  return id;
}

function normalizeName(payload) {
  const rawName = firstDefined(
    payload?.name,
    typeof payload?.displayName === "object" ? payload?.displayName?.text : payload?.displayName
  );
  const name = normalizeString(rawName, MAX_NAME_LENGTH);
  if (!name) {
    throw new TypeError("place name is required and must be a non-empty string");
  }
  return name;
}

function normalizeLatitude(payload) {
  const lat = toFiniteNumber(
    firstDefined(payload?.lat, payload?.latitude, payload?.geometry?.location?.lat, payload?.location?.latitude),
    null
  );
  if (lat === null || Math.abs(lat) > 90) {
    throw new TypeError("place latitude is required and must be within [-90, 90]");
  }
  return round6(lat);
}

function normalizeLongitude(payload) {
  const lon = toFiniteNumber(
    firstDefined(
      payload?.lon,
      payload?.lng,
      payload?.longitude,
      payload?.geometry?.location?.lng,
      payload?.location?.longitude
    ),
    null
  );
  if (lon === null || Math.abs(lon) > 180) {
    throw new TypeError("place longitude is required and must be within [-180, 180]");
  }
  return round6(lon);
}

function normalizeCategory(payload) {
  const direct = normalizeString(firstDefined(payload?.category, payload?.primaryType), MAX_CATEGORY_LENGTH);
  if (direct) {
    return direct;
  }

  const types = Array.isArray(payload?.types) ? payload.types : null;
  if (types && types.length > 0) {
    return normalizeString(types[0], MAX_CATEGORY_LENGTH);
  }

  return null;
}

function normalizePhone(payload) {
  const raw = normalizeString(
    firstDefined(
      payload?.phone,
      payload?.formatted_phone_number,
      payload?.internationalPhoneNumber,
      payload?.nationalPhoneNumber,
      payload?.tel
    ),
    MAX_PHONE_LENGTH
  );
  if (!raw) {
    return null;
  }

  // Keep only dialable characters so the UI can build a safe tel: link.
  const cleaned = raw.replace(/[^0-9+()\-.\s]/g, "").trim();
  return cleaned || null;
}

function normalizeWebsite(payload) {
  const raw = normalizeString(firstDefined(payload?.website, payload?.websiteUri, payload?.url), MAX_WEBSITE_LENGTH);
  if (!raw) {
    return null;
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.href.slice(0, MAX_WEBSITE_LENGTH);
  } catch {
    return null;
  }
}

function normalizeRating(payload) {
  const rating = toFiniteNumber(payload?.rating, null);
  if (rating === null) {
    return null;
  }
  return Math.round(clampNumber(rating, 0, 5) * 10) / 10;
}

function normalizeTime(value) {
  if (isFiniteNumber(value)) {
    const minutesOfDay = Math.trunc(value);
    if (minutesOfDay < 0 || minutesOfDay > 2359) {
      return null;
    }
    const padded = String(minutesOfDay).padStart(4, "0");
    const hours = Number(padded.slice(0, 2));
    const minutes = Number(padded.slice(2));
    return hours <= 23 && minutes <= 59 ? padded : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const compact = value.replace(/[^0-9]/g, "");
  if (compact.length < 3 || compact.length > 4) {
    return null;
  }

  const padded = compact.padStart(4, "0");
  const hours = Number(padded.slice(0, 2));
  const minutes = Number(padded.slice(2));
  if (hours > 23 || minutes > 59) {
    return null;
  }
  return padded;
}

function normalizeDayIndex(value) {
  if (isFiniteNumber(value)) {
    const day = Math.trunc(value);
    return day >= 0 && day <= 6 ? day : null;
  }

  if (typeof value === "string") {
    const key = value.trim().toLowerCase().slice(0, 3);
    return Object.hasOwn(DAY_NAME_TO_INDEX, key) ? DAY_NAME_TO_INDEX[key] : null;
  }

  return null;
}

function normalizePeriod(period) {
  if (!period || typeof period !== "object") {
    return null;
  }

  // Accept the canonical { day, open, close } form as well as the Google-style
  // { open: { day, time }, close: { day, time } } shape.
  const dayValue = firstDefined(period.day, period.open?.day);
  const openValue = firstDefined(period.open?.time, period.open, period.start);
  const closeValue = firstDefined(period.close?.time, period.close, period.end);

  const day = normalizeDayIndex(dayValue);
  const open = normalizeTime(openValue);
  const close = normalizeTime(closeValue);

  if (day === null || open === null || close === null) {
    return null;
  }

  return { day, open, close };
}

function normalizeWeekdayText(source) {
  const list = Array.isArray(source) ? source : null;
  if (!list) {
    return null;
  }

  const entries = list
    .map((entry) => normalizeString(entry, MAX_WEEKDAY_TEXT_LENGTH))
    .filter((entry) => entry !== null)
    .slice(0, MAX_WEEKDAY_TEXT_ENTRIES);

  return entries.length > 0 ? entries : null;
}

function normalizeHours(payload) {
  const source = firstDefined(
    payload?.hours,
    payload?.opening_hours,
    payload?.openingHours,
    payload?.regularOpeningHours
  );

  if (!source) {
    return null;
  }

  const rawPeriods = Array.isArray(source) ? source : source.periods;
  const periods = (Array.isArray(rawPeriods) ? rawPeriods : [])
    .map(normalizePeriod)
    .filter((period) => period !== null)
    .sort((left, right) => left.day - right.day || left.open.localeCompare(right.open));

  const weekdayText = normalizeWeekdayText(
    firstDefined(source.weekdayText, source.weekday_text, source.weekdayDescriptions)
  );

  if (periods.length === 0 && !weekdayText) {
    return null;
  }

  return { periods, weekdayText: weekdayText || null };
}

function normalizePhotoRef(photo) {
  if (typeof photo === "string") {
    const ref = normalizeString(photo, MAX_PHOTO_REF_LENGTH);
    return ref ? { ref, width: null, height: null, attribution: null } : null;
  }

  if (!photo || typeof photo !== "object") {
    return null;
  }

  const ref = normalizeString(
    firstDefined(photo.ref, photo.reference, photo.photo_reference, photo.name),
    MAX_PHOTO_REF_LENGTH
  );
  if (!ref) {
    return null;
  }

  const width = toFiniteNumber(firstDefined(photo.width, photo.widthPx, photo.width_px), null);
  const height = toFiniteNumber(firstDefined(photo.height, photo.heightPx, photo.height_px), null);
  const attributionSource = firstDefined(photo.attribution, photo.attributions, photo.html_attributions);
  const attribution = normalizeString(
    Array.isArray(attributionSource) ? attributionSource[0] : attributionSource,
    MAX_ATTRIBUTION_LENGTH
  );

  return {
    ref,
    width: width !== null && width > 0 ? Math.trunc(width) : null,
    height: height !== null && height > 0 ? Math.trunc(height) : null,
    attribution: attribution || null,
  };
}

function normalizePhotoRefs(payload) {
  const source = firstDefined(payload?.photoRefs, payload?.photos);
  const list = Array.isArray(source) ? source : [];
  return list
    .map(normalizePhotoRef)
    .filter((photo) => photo !== null)
    .slice(0, MAX_PHOTO_REFS);
}

function normalizeLastFetchedTs(payload) {
  const ts = toFiniteNumber(firstDefined(payload?.lastFetchedTs, payload?.fetchedAt, payload?.fetched_ts), null);
  return ts !== null && ts >= 0 ? Math.trunc(ts) : null;
}

// Normalize an arbitrary provider payload (or an already-normalized place) into
// the canonical, deterministic in-memory place form. Throws TypeError when any
// required field (id, name, lat, lon) is missing or invalid; everything else
// degrades gracefully to null. Idempotent: normalizing a normalized place is a
// no-op aside from re-validation.
function normalizePlace(payload) {
  if (!payload || typeof payload !== "object") {
    throw new TypeError("place payload must be an object");
  }

  return {
    id: normalizeId(payload),
    name: normalizeName(payload),
    lat: normalizeLatitude(payload),
    lon: normalizeLongitude(payload),
    category: normalizeCategory(payload),
    phone: normalizePhone(payload),
    website: normalizeWebsite(payload),
    hours: normalizeHours(payload),
    rating: normalizeRating(payload),
    photoRefs: normalizePhotoRefs(payload),
    lastFetchedTs: normalizeLastFetchedTs(payload),
  };
}

function isValidPlace(value) {
  try {
    normalizePlace(value);
    return true;
  } catch {
    return false;
  }
}

// JSON-safe record for IndexedDB/localStorage persistence. A schemaVersion tag is
// prepended so future migrations can branch deterministically.
function serializePlace(place) {
  const normalized = normalizePlace(place);
  return {
    schemaVersion: PLACE_SCHEMA_VERSION,
    ...normalized,
  };
}

// Rehydrate a persisted record back into the in-memory place form. Re-validates
// and drops the schemaVersion tag so deserialize(serialize(place)) round-trips to
// the canonical shape.
function deserializePlace(record) {
  if (!record || typeof record !== "object") {
    throw new TypeError("place record must be an object");
  }
  return normalizePlace(record);
}

export {
  PLACE_SCHEMA_VERSION,
  normalizePlace,
  isValidPlace,
  serializePlace,
  deserializePlace,
  normalizeHours,
  normalizePhotoRef,
};
