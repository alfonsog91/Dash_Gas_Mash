const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const LIVE_WEATHER_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_RAIN_BOOST = 0.25;

const liveWeatherCache = {
  key: null,
  fetchedAt: 0,
  value: null,
};

function clampRainBoost(value) {
  return Math.max(0, Math.min(MAX_RAIN_BOOST, Number(value) || 0));
}

function roundCoordinate(value) {
  return Math.round(Number(value) * 100) / 100;
}

function buildLiveWeatherCacheKey(lat, lon) {
  return `${roundCoordinate(lat)},${roundCoordinate(lon)}`;
}

function buildOpenMeteoWeatherUrl(lat, lon) {
  const url = new URL(OPEN_METEO_FORECAST_URL);
  url.searchParams.set("latitude", String(Number(lat)));
  url.searchParams.set("longitude", String(Number(lon)));
  url.searchParams.set("current", "precipitation,rain,showers,weather_code");
  url.searchParams.set("precipitation_unit", "mm");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "1");
  return url.toString();
}

function deriveRainBoostFromPrecipitationMm(precipitationMm) {
  const mmPerHour = Math.max(0, Number(precipitationMm) || 0);
  return clampRainBoost(MAX_RAIN_BOOST * (1 - Math.exp(-mmPerHour / 2.5)));
}

function describeWeatherCode(code) {
  const numericCode = Number(code);
  if (!Number.isFinite(numericCode)) return "conditions unavailable";
  if (numericCode === 0) return "clear";
  if (numericCode >= 1 && numericCode <= 3) return "cloudy";
  if (numericCode >= 51 && numericCode <= 57) return "drizzle";
  if (numericCode >= 61 && numericCode <= 67) return "rain";
  if (numericCode >= 71 && numericCode <= 77) return "snow";
  if (numericCode >= 80 && numericCode <= 82) return "showers";
  if (numericCode >= 85 && numericCode <= 86) return "snow showers";
  if (numericCode >= 95) return "thunderstorm";
  return "mixed precipitation";
}

function deriveWeatherSignal(payload) {
  const current = payload?.current ?? {};
  const precipitationMm = Math.max(0, Number(current.precipitation) || 0);
  const rainMm = Math.max(0, Number(current.rain) || 0);
  const showersMm = Math.max(0, Number(current.showers) || 0);
  const weatherCode = Number.isFinite(Number(current.weather_code))
    ? Number(current.weather_code)
    : null;
  const rainBoost = deriveRainBoostFromPrecipitationMm(precipitationMm);

  return {
    source: "open-meteo",
    latitude: Number(payload?.latitude),
    longitude: Number(payload?.longitude),
    time: typeof current.time === "string" ? current.time : null,
    precipitationMm,
    rainMm,
    showersMm,
    weatherCode,
    weatherLabel: describeWeatherCode(weatherCode),
    rainBoost,
  };
}

function formatWeatherSourceSummary(weatherSignal) {
  if (!weatherSignal) {
    return "Live weather unavailable. Using manual rain lift.";
  }

  const sourceName = weatherSignal.source === "open-meteo"
    ? "Open-Meteo"
    : "Live weather";
  const precipitationText = `${weatherSignal.precipitationMm.toFixed(1)} mm/h`;
  const liftText = `${Math.round(weatherSignal.rainBoost * 100)}% lift`;
  const timeText = weatherSignal.time ? ` at ${weatherSignal.time}` : "";
  return `${sourceName}: ${weatherSignal.weatherLabel}, ${precipitationText}, ${liftText}${timeText}`;
}

async function fetchCurrentWeatherSignal({ lat, lon }, signal) {
  const cacheKey = buildLiveWeatherCacheKey(lat, lon);
  const now = Date.now();
  if (
    liveWeatherCache.key === cacheKey
    && liveWeatherCache.value
    && now - liveWeatherCache.fetchedAt <= LIVE_WEATHER_CACHE_TTL_MS
  ) {
    return liveWeatherCache.value;
  }

  const response = await fetch(buildOpenMeteoWeatherUrl(lat, lon), {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
    signal,
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`Live weather request failed (${response.status}): ${details.slice(0, 200)}`);
  }

  const payload = await response.json();
  if (!payload?.current) {
    throw new Error("Live weather response missing current conditions.");
  }

  const weatherSignal = deriveWeatherSignal(payload);
  liveWeatherCache.key = cacheKey;
  liveWeatherCache.fetchedAt = now;
  liveWeatherCache.value = weatherSignal;
  return weatherSignal;
}

export {
  MAX_RAIN_BOOST,
  buildOpenMeteoWeatherUrl,
  deriveRainBoostFromPrecipitationMm,
  deriveWeatherSignal,
  fetchCurrentWeatherSignal,
  formatWeatherSourceSummary,
};