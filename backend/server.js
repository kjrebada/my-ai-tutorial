const express = require("express");
const { randomUUID } = require("node:crypto");
const { createClient } = require("redis");

const PORT = Number(process.env.PORT) || 3001;
const OPEN_METEO_GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const UPSTREAM_TIMEOUT_MS = 8000;
const CACHE_TTL_SECONDS = Object.freeze({
  locations: 24 * 60 * 60,
  weather: 10 * 60,
});
const PROVIDER_RATE_LIMITS = [
  { windowMs: 60 * 1000, maxRequests: 500 },
  { windowMs: 60 * 60 * 1000, maxRequests: 4500 },
  { windowMs: 24 * 60 * 60 * 1000, maxRequests: 9000 },
];

const WEATHER_DESCRIPTIONS = new Map([
  [0, "Clear sky"],
  [1, "Mainly clear"],
  [2, "Partly cloudy"],
  [3, "Overcast"],
  [45, "Fog"],
  [48, "Depositing rime fog"],
  [51, "Light drizzle"],
  [53, "Moderate drizzle"],
  [55, "Dense drizzle"],
  [56, "Light freezing drizzle"],
  [57, "Dense freezing drizzle"],
  [61, "Slight rain"],
  [63, "Moderate rain"],
  [65, "Heavy rain"],
  [66, "Light freezing rain"],
  [67, "Heavy freezing rain"],
  [71, "Slight snow fall"],
  [73, "Moderate snow fall"],
  [75, "Heavy snow fall"],
  [77, "Snow grains"],
  [80, "Slight rain showers"],
  [81, "Moderate rain showers"],
  [82, "Violent rain showers"],
  [85, "Slight snow showers"],
  [86, "Heavy snow showers"],
  [95, "Thunderstorm"],
  [96, "Thunderstorm with slight hail"],
  [99, "Thunderstorm with heavy hail"],
]);

function sendError(response, status, code, message) {
  response.status(status).json({ error: { code, message } });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function isValidHourlyTime(value) {
  const match = typeof value === "string"
    ? /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value)
    : null;
  return match !== null
    && isValidDate(match[1])
    && Number(match[2]) <= 23
    && Number(match[3]) <= 59;
}

function isValidTimezone(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch (error) {
    if (error instanceof RangeError) {
      return false;
    }
    throw error;
  }
}

function getWeatherDescription(code) {
  return WEATHER_DESCRIPTIONS.get(code);
}

function isWeatherCode(code) {
  return Number.isInteger(code) && WEATHER_DESCRIPTIONS.has(code);
}

function createProviderRateLimiter({
  limits = PROVIDER_RATE_LIMITS,
  now = Date.now,
} = {}) {
  const windows = limits.map(({ windowMs, maxRequests }) => ({
    windowMs,
    maxRequests,
    timestamps: [],
    start: 0,
  }));

  return function getRetryAfterSeconds() {
    const currentTime = now();
    let retryAfterMs = 0;

    for (const window of windows) {
      while (
        window.start < window.timestamps.length
        && window.timestamps[window.start] <= currentTime - window.windowMs
      ) {
        window.start += 1;
      }

      if (window.timestamps.length - window.start >= window.maxRequests) {
        const windowRetryAfterMs =
          window.timestamps[window.start] + window.windowMs - currentTime;
        retryAfterMs = Math.max(retryAfterMs, windowRetryAfterMs);
      }
    }

    if (retryAfterMs > 0) {
      return Math.ceil(retryAfterMs / 1000);
    }

    for (const window of windows) {
      window.timestamps.push(currentTime);
      if (window.start > 1000) {
        window.timestamps = window.timestamps.slice(window.start);
        window.start = 0;
      }
    }
    return 0;
  };
}

const REDIS_RATE_LIMIT_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local retryAfterMs = 0

for index, key in ipairs(KEYS) do
  local argumentIndex = (index - 1) * 2 + 1
  local windowMs = tonumber(ARGV[argumentIndex])
  local maxRequests = tonumber(ARGV[argumentIndex + 1])
  redis.call('ZREMRANGEBYSCORE', key, '-inf', now - windowMs)
  if redis.call('ZCARD', key) >= maxRequests then
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local waitMs = tonumber(oldest[2]) + windowMs - now
    if waitMs > retryAfterMs then
      retryAfterMs = waitMs
    end
  end
end

if retryAfterMs > 0 then
  return { 0, math.ceil(retryAfterMs / 1000) }
end

local requestId = ARGV[#ARGV]
for index, key in ipairs(KEYS) do
  local windowMs = tonumber(ARGV[(index - 1) * 2 + 1])
  redis.call('ZADD', key, now, requestId)
  redis.call('PEXPIRE', key, windowMs)
end
return { 1, 0 }
`;

function createRedisProviderRateLimiter(redisClient, {
  limits = PROVIDER_RATE_LIMITS,
  keyPrefix = "weather:provider-requests",
} = {}) {
  const keys = limits.map(({ windowMs }) => `${keyPrefix}:${windowMs}`);
  const argumentsForLimits = limits.flatMap(({ windowMs, maxRequests }) => [
    String(windowMs),
    String(maxRequests),
  ]);

  return async function getRetryAfterSeconds() {
    const result = await redisClient.eval(REDIS_RATE_LIMIT_SCRIPT, {
      keys,
      arguments: [...argumentsForLimits, randomUUID()],
    });
    if (!Array.isArray(result) || result.length !== 2
      || !Number.isInteger(result[0]) || !Number.isInteger(result[1])) {
      throw new TypeError("Redis returned an invalid provider rate-limit result.");
    }
    return result[0] === 1 ? 0 : result[1];
  };
}

function createLocationCacheKey(query) {
  return `weather:locations:${query.trim().toLowerCase()}`;
}

function createWeatherCacheKey(latitude, longitude, forecastDays) {
  return `weather:forecast:${String(latitude)}:${String(longitude)}:${forecastDays}`;
}

function isNormalizedLocationResponse(value) {
  return isRecord(value)
    && Array.isArray(value.locations)
    && value.locations.every((location) => isRecord(location)
      && (location.id === null || Number.isInteger(location.id))
      && typeof location.name === "string"
      && (location.region === null || typeof location.region === "string")
      && (location.country === null || typeof location.country === "string")
      && isFiniteNumber(location.latitude)
      && location.latitude >= -90
      && location.latitude <= 90
      && isFiniteNumber(location.longitude)
      && location.longitude >= -180
      && location.longitude <= 180);
}

function isNullableFiniteNumber(value) {
  return value === null || isFiniteNumber(value);
}

function isNormalizedWeatherResponse(value, forecastDays) {
  if (!isRecord(value) || !isValidTimezone(value.timezone)
    || !isRecord(value.current) || !Array.isArray(value.daily)
    || value.daily.length !== forecastDays) {
    return false;
  }

  const { current } = value;
  if (!isNullableFiniteNumber(current.temperatureC)
    || !isWeatherCode(current.weatherCode)
    || current.weatherDescription !== getWeatherDescription(current.weatherCode)) {
    return false;
  }

  return value.daily.every((day) => {
    if (!isRecord(day) || !isValidDate(day.date)
      || !isWeatherCode(day.weatherCode)
      || day.weatherDescription !== getWeatherDescription(day.weatherCode)
      || !isNullableFiniteNumber(day.temperatureMaxC)
      || !isNullableFiniteNumber(day.temperatureMinC)
      || !isNullableFiniteNumber(day.uvIndexMax)
      || !Array.isArray(day.hourly)
      || day.hourly.length < 23
      || day.hourly.length > 25) {
      return false;
    }

    return day.hourly.every((hour) => isRecord(hour)
      && isValidHourlyTime(hour.time)
      && hour.time.slice(0, 10) === day.date
      && isNullableFiniteNumber(hour.temperatureC)
      && isNullableFiniteNumber(hour.feelsLikeC)
      && (hour.humidityPercent === null
        || (isFiniteNumber(hour.humidityPercent)
          && hour.humidityPercent >= 0 && hour.humidityPercent <= 100))
      && isWeatherCode(hour.weatherCode)
      && hour.weatherDescription === getWeatherDescription(hour.weatherCode));
  });
}

async function readCachedResponse(cacheClient, key, isValid) {
  if (!cacheClient) {
    return null;
  }

  let serialized;
  try {
    serialized = await cacheClient.get(key);
  } catch (error) {
    console.error("Redis cache read failed:", error);
    return null;
  }

  if (typeof serialized !== "string") {
    return null;
  }

  try {
    const value = JSON.parse(serialized);
    return isValid(value) ? value : null;
  } catch {
    return null;
  }
}

async function writeCachedResponse(cacheClient, key, value, ttlSeconds) {
  if (!cacheClient) {
    return;
  }

  try {
    await cacheClient.set(key, JSON.stringify(value), { EX: ttlSeconds });
  } catch (error) {
    console.error("Redis cache write failed:", error);
  }
}

async function enforceProviderRateLimit(response, getRetryAfterSeconds) {
  let retryAfterSeconds;
  try {
    retryAfterSeconds = await getRetryAfterSeconds();
  } catch (error) {
    console.error("Provider rate-limit store request failed:", error);
    sendError(
      response,
      503,
      "RATE_LIMIT_STORE_UNAVAILABLE",
      "Weather lookup is temporarily unavailable. Please try again later.",
    );
    return false;
  }

  if (retryAfterSeconds === 0) {
    return true;
  }

  response.set("Retry-After", String(retryAfterSeconds));
  sendError(
    response,
    429,
    "RATE_LIMITED",
    "The weather lookup limit has been reached. Please try again later.",
  );
  return false;
}

async function fetchJson(fetchImpl, url) {
  let upstreamResponse;
  try {
    upstreamResponse = await fetchImpl(url, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      return {
        error: {
          status: 504,
          code: "UPSTREAM_TIMEOUT",
          message: "The weather service took too long to respond.",
        },
      };
    }

    return {
      error: {
        status: 502,
        code: "UPSTREAM_UNAVAILABLE",
        message: "The weather service is temporarily unavailable.",
      },
    };
  }

  if (!isRecord(upstreamResponse)
    || !Number.isInteger(upstreamResponse.status)
    || typeof upstreamResponse.ok !== "boolean"
    || typeof upstreamResponse.json !== "function") {
    return {
      error: {
        status: 502,
        code: "UPSTREAM_INVALID_RESPONSE",
        message: "The weather service returned an invalid response.",
      },
    };
  }

  if (upstreamResponse.status === 429) {
    return {
      error: {
        status: 503,
        code: "UPSTREAM_RATE_LIMIT",
        message: "The weather service is temporarily rate-limited. Please try again later.",
      },
    };
  }
  if (!upstreamResponse.ok) {
    return {
      error: {
        status: 502,
        code: "UPSTREAM_ERROR",
        message: "The weather service could not complete the request.",
      },
    };
  }

  let data;
  try {
    data = await upstreamResponse.json();
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return {
      error: {
        status: timedOut ? 504 : 502,
        code: timedOut ? "UPSTREAM_TIMEOUT" : "UPSTREAM_INVALID_RESPONSE",
        message: timedOut
          ? "The weather service took too long to respond."
          : "The weather service returned an invalid response.",
      },
    };
  }

  if (!isRecord(data) || data.error === true) {
    return {
      error: {
        status: 502,
        code: "UPSTREAM_INVALID_RESPONSE",
        message: "The weather service returned an invalid response.",
      },
    };
  }

  return { data };
}

function createApp({
  fetchImpl = globalThis.fetch,
  rateLimitOptions,
  providerRateLimiter,
  cacheClient,
  isRateLimitStoreReady = () => true,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("A fetch implementation is required.");
  }

  const app = express();
  const getRetryAfterSeconds = providerRateLimiter
    ?? createProviderRateLimiter(rateLimitOptions);

  app.get("/api/health", (_request, response) => {
    if (!isRateLimitStoreReady()) {
      return sendError(
        response,
        503,
        "RATE_LIMIT_STORE_UNAVAILABLE",
        "The provider rate-limit store is unavailable.",
      );
    }
    response.json({ status: "ok", message: "Ready for your next feature." });
  });

  app.get("/api/locations", async (request, response) => {
    response.set("Cache-Control", "no-store");
    const query = request.query.query;
    if (typeof query !== "string" || query.trim().length < 2 || query.trim().length > 100) {
      return sendError(response, 400, "INVALID_LOCATION_QUERY", "Enter a location between 2 and 100 characters.");
    }

    const cacheKey = createLocationCacheKey(query);
    const cachedResponse = await readCachedResponse(
      cacheClient,
      cacheKey,
      isNormalizedLocationResponse,
    );
    if (cachedResponse) {
      return response.json(cachedResponse);
    }

    if (!await enforceProviderRateLimit(response, getRetryAfterSeconds)) {
      return;
    }

    const url = new URL(OPEN_METEO_GEOCODING_URL);
    url.search = new URLSearchParams({
      name: query.trim(),
      count: "10",
      language: "en",
      format: "json",
    });
    const result = await fetchJson(fetchImpl, url);
    if (result.error) {
      return sendError(response, result.error.status, result.error.code, result.error.message);
    }

    const hasResults = isRecord(result.data)
      && Object.prototype.hasOwnProperty.call(result.data, "results");
    const results = hasResults
      ? result.data.results
      : isRecord(result.data) ? [] : undefined;
    if (!Array.isArray(results) || results.some((location) => {
      return !isRecord(location)
        || typeof location.name !== "string"
        || !isFiniteNumber(location.latitude)
        || location.latitude < -90
        || location.latitude > 90
        || !isFiniteNumber(location.longitude)
        || location.longitude < -180
        || location.longitude > 180;
    })) {
      return sendError(response, 502, "UPSTREAM_INVALID_RESPONSE", "The weather service returned invalid location data.");
    }

    const normalizedResponse = {
      locations: results.map((location) => ({
        id: Number.isInteger(location.id) ? location.id : null,
        name: location.name,
        region: typeof location.admin1 === "string" ? location.admin1 : null,
        country: typeof location.country === "string" ? location.country : null,
        latitude: location.latitude,
        longitude: location.longitude,
      })),
    };
    await writeCachedResponse(
      cacheClient,
      cacheKey,
      normalizedResponse,
      CACHE_TTL_SECONDS.locations,
    );
    return response.json(normalizedResponse);
  });

  app.get("/api/weather", async (request, response) => {
    response.set("Cache-Control", "no-store");
    const { latitude, longitude } = request.query;
    if (typeof latitude !== "string" || typeof longitude !== "string"
      || latitude.trim() === "" || longitude.trim() === "") {
      return sendError(response, 400, "INVALID_COORDINATES", "Valid latitude and longitude are required.");
    }

    const latitudeValue = Number(latitude);
    const longitudeValue = Number(longitude);
    if (!Number.isFinite(latitudeValue) || latitudeValue < -90 || latitudeValue > 90
      || !Number.isFinite(longitudeValue) || longitudeValue < -180 || longitudeValue > 180) {
      return sendError(response, 400, "INVALID_COORDINATES", "Latitude must be between -90 and 90 and longitude between -180 and 180.");
    }

    const daysValue = request.query.forecastDays;
    let forecastDays = 7;
    if (daysValue !== undefined) {
      if (typeof daysValue !== "string" || !/^(?:[1-9]|1[0-4])$/.test(daysValue)) {
        return sendError(response, 400, "INVALID_FORECAST_DAYS", "Forecast days must be a whole number from 1 to 14.");
      }
      forecastDays = Number(daysValue);
    }

    const cacheKey = createWeatherCacheKey(
      latitudeValue,
      longitudeValue,
      forecastDays,
    );
    const cachedResponse = await readCachedResponse(
      cacheClient,
      cacheKey,
      (value) => isNormalizedWeatherResponse(value, forecastDays),
    );
    if (cachedResponse) {
      return response.json(cachedResponse);
    }

    if (!await enforceProviderRateLimit(response, getRetryAfterSeconds)) {
      return;
    }

    const url = new URL(OPEN_METEO_FORECAST_URL);
    url.search = new URLSearchParams({
      latitude: String(latitudeValue),
      longitude: String(longitudeValue),
      current: "temperature_2m,weather_code",
      hourly: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,uv_index_max",
      forecast_days: String(forecastDays),
      temperature_unit: "celsius",
      wind_speed_unit: "kmh",
      precipitation_unit: "mm",
      timezone: "auto",
    });
    const result = await fetchJson(fetchImpl, url);
    if (result.error) {
      return sendError(response, result.error.status, result.error.code, result.error.message);
    }

    const { current, hourly, daily, timezone } = result.data;
    if (!isRecord(current) || !isRecord(hourly) || !isRecord(daily)
      || !isValidTimezone(timezone)
      || !isWeatherCode(current.weather_code)
      || !(current.temperature_2m === null || isFiniteNumber(current.temperature_2m))
      || !Array.isArray(hourly.time)
      || !Array.isArray(hourly.temperature_2m)
      || !Array.isArray(hourly.apparent_temperature)
      || !Array.isArray(hourly.relative_humidity_2m)
      || !Array.isArray(hourly.weather_code)
      || hourly.time.length === 0
      || hourly.temperature_2m.length !== hourly.time.length
      || hourly.apparent_temperature.length !== hourly.time.length
      || hourly.relative_humidity_2m.length !== hourly.time.length
      || hourly.weather_code.length !== hourly.time.length
      || !Array.isArray(daily.time)
      || !Array.isArray(daily.weather_code)
      || !Array.isArray(daily.temperature_2m_max)
      || !Array.isArray(daily.temperature_2m_min)
      || !Array.isArray(daily.uv_index_max)
      || daily.time.length !== forecastDays
      || daily.weather_code.length !== forecastDays
      || daily.temperature_2m_max.length !== forecastDays
      || daily.temperature_2m_min.length !== forecastDays
      || daily.uv_index_max.length !== forecastDays) {
      return sendError(response, 502, "UPSTREAM_INVALID_RESPONSE", "The weather service returned incomplete forecast data.");
    }

    const hourlyByDate = new Map();
    for (let index = 0; index < hourly.time.length; index += 1) {
      const time = hourly.time[index];
      const temperatureC = hourly.temperature_2m[index];
      const feelsLikeC = hourly.apparent_temperature[index];
      const humidityPercent = hourly.relative_humidity_2m[index];
      const weatherCode = hourly.weather_code[index];
      if (!isValidHourlyTime(time)
        || !(temperatureC === null || isFiniteNumber(temperatureC))
        || !(feelsLikeC === null || isFiniteNumber(feelsLikeC))
        || !(humidityPercent === null
          || (isFiniteNumber(humidityPercent) && humidityPercent >= 0 && humidityPercent <= 100))
        || !isWeatherCode(weatherCode)) {
        return sendError(response, 502, "UPSTREAM_INVALID_RESPONSE", "The weather service returned invalid hourly data.");
      }

      const date = time.slice(0, 10);
      const dayHours = hourlyByDate.get(date) ?? [];
      dayHours.push({
        time,
        temperatureC,
        feelsLikeC,
        humidityPercent,
        weatherCode,
        weatherDescription: getWeatherDescription(weatherCode),
      });
      hourlyByDate.set(date, dayHours);
    }

    const dailyForecast = [];
    for (let index = 0; index < forecastDays; index += 1) {
      const date = daily.time[index];
      const weatherCode = daily.weather_code[index];
      const temperatureMaxC = daily.temperature_2m_max[index];
      const temperatureMinC = daily.temperature_2m_min[index];
      const uvIndexMax = daily.uv_index_max[index];
      const hourlyForecast = hourlyByDate.get(date);
      if (!isValidDate(date)
        || !isWeatherCode(weatherCode)
        || !(temperatureMaxC === null || isFiniteNumber(temperatureMaxC))
        || !(temperatureMinC === null || isFiniteNumber(temperatureMinC))
        || !(uvIndexMax === null || isFiniteNumber(uvIndexMax))
        || !hourlyForecast
        || hourlyForecast.length < 23
        || hourlyForecast.length > 25) {
        return sendError(response, 502, "UPSTREAM_INVALID_RESPONSE", "The weather service returned invalid forecast data.");
      }

      dailyForecast.push({
        date,
        weatherCode,
        weatherDescription: getWeatherDescription(weatherCode),
        temperatureMaxC,
        temperatureMinC,
        uvIndexMax,
        hourly: hourlyForecast,
      });
    }

    const normalizedResponse = {
      timezone,
      current: {
        temperatureC: current.temperature_2m,
        weatherCode: current.weather_code,
        weatherDescription: getWeatherDescription(current.weather_code),
      },
      daily: dailyForecast,
    };
    await writeCachedResponse(
      cacheClient,
      cacheKey,
      normalizedResponse,
      CACHE_TTL_SECONDS.weather,
    );
    return response.json(normalizedResponse);
  });

  return app;
}

if (require.main === module) {
  async function startServer() {
    let redisClient;
    let providerRateLimiter;
    let isRateLimitStoreReady = () => true;
    if (process.env.REDIS_URL) {
      redisClient = createClient({ url: process.env.REDIS_URL });
      redisClient.on("error", (error) => {
        console.error("Redis client error:", error);
      });
      await redisClient.connect();
      providerRateLimiter = createRedisProviderRateLimiter(redisClient);
      isRateLimitStoreReady = () => redisClient.isReady;
    } else {
      console.warn("REDIS_URL is not configured; provider limits are process-local.");
    }

    const app = createApp({
      providerRateLimiter,
      cacheClient: redisClient,
      isRateLimitStoreReady,
    });
    app.listen(PORT, () => {
      console.log(`API server listening on http://localhost:${PORT}`);
    });
  }

  startServer().catch((error) => {
    console.error("API server failed to start:", error);
    process.exitCode = 1;
  });
}

module.exports = {
  CACHE_TTL_SECONDS,
  createApp,
  createRedisProviderRateLimiter,
};
