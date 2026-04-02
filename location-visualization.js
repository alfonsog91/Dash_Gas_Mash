export function normalizeHeading(heading) {
  if (heading === null || heading === undefined || heading === "") return null;
  const value = Number(heading);
  if (!Number.isFinite(value)) return null;
  return ((value % 360) + 360) % 360;
}

export function projectPointMeters(center, distanceMeters, headingDegrees) {
  const heading = normalizeHeading(headingDegrees);
  if (!center || heading === null) return null;

  const origin = {
    lat: Number(center.lat),
    lng: Number(center.lng ?? center.lon),
  };

  if (!Number.isFinite(origin.lat) || !Number.isFinite(origin.lng)) {
    return null;
  }

  const radians = (heading * Math.PI) / 180;
  const dx = Math.sin(radians) * distanceMeters;
  const dy = Math.cos(radians) * distanceMeters;
  const lngScale = Math.max(Math.cos((origin.lat * Math.PI) / 180), 0.1);

  return {
    lat: origin.lat + (dy / 111320),
    lng: origin.lng + (dx / (111320 * lngScale)),
  };
}

export function buildHeadingConeFeature(center, headingDegrees, options = {}) {
  const heading = normalizeHeading(headingDegrees);
  if (!center || heading === null) return null;

  const origin = {
    lat: Number(center.lat),
    lng: Number(center.lng ?? center.lon),
  };

  if (!Number.isFinite(origin.lat) || !Number.isFinite(origin.lng)) {
    return null;
  }

  const radiusMeters = Math.max(Number(options.radiusMeters) || 0, 12);
  const spreadDegrees = Math.max(Number(options.spreadDegrees) || 0, 8);
  const stepDegrees = Math.max(Number(options.stepDegrees) || 0, 1);
  const halfSpread = spreadDegrees / 2;
  const coordinates = [[origin.lng, origin.lat]];

  for (let angle = heading - halfSpread; angle <= heading + halfSpread + 0.001; angle += stepDegrees) {
    const point = projectPointMeters(origin, radiusMeters, angle);
    if (point) {
      coordinates.push([point.lng, point.lat]);
    }
  }

  if (coordinates.length < 3) return null;

  coordinates.push([origin.lng, origin.lat]);

  return {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [coordinates],
    },
    properties: {
      heading,
    },
  };
}
