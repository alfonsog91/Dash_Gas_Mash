function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeCoord(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const lat = toFiniteNumber(input.lat ?? input.latitude);
  const lon = toFiniteNumber(input.lng ?? input.lon ?? input.longitude);
  if (
    lat === null
    || lon === null
    || lat < -90
    || lat > 90
    || lon < -180
    || lon > 180
  ) {
    return null;
  }

  return { lat, lng: lon, lon };
}

export { normalizeCoord };