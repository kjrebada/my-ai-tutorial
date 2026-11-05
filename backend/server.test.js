const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { createServer } = require("node:http");
const {
  CACHE_TTL_SECONDS,
  createApp,
  createRedisProviderRateLimiter,
} = require("./server");

let server;
let baseUrl;
let providerFetch;
let providerCalls;

before(async () => {
  const app = createApp({
    fetchImpl: (...args) => {
      providerCalls += 1;
      return providerFetch(...args);
    },
  });
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function startApp(options) {
  const testServer = createServer(createApp(options));
  await new Promise((resolve) => testServer.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${testServer.address().port}`,
    close: () => new Promise((resolve, reject) => {
      testServer.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function createMemoryCache(initialEntries = []) {
  const values = new Map(initialEntries);
  const writes = [];
  return {
    values,
    writes,
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value, options) {
      values.set(key, value);
      writes.push({ key, value, options });
    },
  };
}

function forecastResponse(days) {
  const dates = Array.from({ length: days }, (_, index) => {
    return `2026-01-${String(index + 1).padStart(2, "0")}`;
  });
  const hourly = dates.flatMap((date) => {
    return Array.from({ length: 24 }, (_, hour) => ({
      time: `${date}T${String(hour).padStart(2, "0")}:00`,
      temperature_2m: 18.5 + hour / 10,
      apparent_temperature: 17.5 + hour / 10,
      relative_humidity_2m: 65,
      weather_code: 2,
    }));
  });
  return {
    timezone: "Australia/Sydney",
    current: { temperature_2m: 18.5, weather_code: 2 },
    hourly: {
      time: hourly.map((entry) => entry.time),
      temperature_2m: hourly.map((entry) => entry.temperature_2m),
      apparent_temperature: hourly.map((entry) => entry.apparent_temperature),
      relative_humidity_2m: hourly.map((entry) => entry.relative_humidity_2m),
      weather_code: hourly.map((entry) => entry.weather_code),
    },
    daily: {
      time: dates,
      weather_code: Array.from({ length: days }, () => 2),
      temperature_2m_max: Array.from({ length: days }, () => 21),
      temperature_2m_min: Array.from({ length: days }, () => 12),
      uv_index_max: Array.from({ length: days }, () => 4.5),
    },
  };
}

test("health endpoint remains available", async () => {
  providerCalls = 0;
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    message: "Ready for your next feature.",
  });
  assert.equal(providerCalls, 0);
});

test("location suggestions validate input and normalize Open-Meteo results", async () => {
  providerCalls = 0;
  const invalidResponse = await fetch(`${baseUrl}/api/locations?query=A`);
  assert.equal(invalidResponse.status, 400);
  assert.equal(providerCalls, 0);

  providerFetch = async (url) => {
    const requestUrl = new URL(url);
    assert.equal(requestUrl.hostname, "geocoding-api.open-meteo.com");
    assert.equal(requestUrl.searchParams.get("name"), "Sydney");
    assert.equal(requestUrl.searchParams.get("count"), "10");
    return jsonResponse({
      results: [{
        id: 123,
        name: "Sydney",
        admin1: "New South Wales",
        country: "Australia",
        latitude: -33.87,
        longitude: 151.21,
      }],
    });
  };

  const response = await fetch(`${baseUrl}/api/locations?query=%20Sydney%20`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    locations: [{
      id: 123,
      name: "Sydney",
      region: "New South Wales",
      country: "Australia",
      latitude: -33.87,
      longitude: 151.21,
    }],
  });

  providerFetch = async () => jsonResponse({ results: [] });
  const noMatchesResponse = await fetch(`${baseUrl}/api/locations?query=No%20such%20place`);
  assert.equal(noMatchesResponse.status, 200);
  assert.deepEqual(await noMatchesResponse.json(), { locations: [] });

  providerFetch = async () => jsonResponse({});
  const omittedResultsResponse = await fetch(`${baseUrl}/api/locations?query=Omitted%20results`);
  assert.equal(omittedResultsResponse.status, 200);
  assert.deepEqual(await omittedResultsResponse.json(), { locations: [] });

  providerFetch = async () => jsonResponse({ results: null });
  const malformedResponse = await fetch(`${baseUrl}/api/locations?query=Malformed`);
  assert.equal(malformedResponse.status, 502);
  assert.equal((await malformedResponse.json()).error.code, "UPSTREAM_INVALID_RESPONSE");
});

test("weather endpoint defaults to seven metric days and normalizes data", async () => {
  providerCalls = 0;
  providerFetch = async (url) => {
    const requestUrl = new URL(url);
    assert.equal(requestUrl.hostname, "api.open-meteo.com");
    assert.equal(requestUrl.searchParams.get("forecast_days"), "7");
    assert.equal(requestUrl.searchParams.get("temperature_unit"), "celsius");
    assert.equal(requestUrl.searchParams.get("wind_speed_unit"), "kmh");
    assert.equal(requestUrl.searchParams.get("precipitation_unit"), "mm");
    assert.equal(
      requestUrl.searchParams.get("hourly"),
      "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code",
    );
    assert.equal(
      requestUrl.searchParams.get("daily"),
      "weather_code,temperature_2m_max,temperature_2m_min,uv_index_max",
    );
    return jsonResponse(forecastResponse(7));
  };

  const response = await fetch(`${baseUrl}/api/weather?latitude=-33.87&longitude=151.21`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.timezone, "Australia/Sydney");
  assert.deepEqual(body.current, {
    temperatureC: 18.5,
    weatherCode: 2,
    weatherDescription: "Partly cloudy",
  });
  assert.equal(body.daily.length, 7);
  assert.deepEqual(body.daily[0], {
    date: "2026-01-01",
    weatherCode: 2,
    weatherDescription: "Partly cloudy",
    temperatureMaxC: 21,
    temperatureMinC: 12,
    uvIndexMax: 4.5,
    hourly: Array.from({ length: 24 }, (_, hour) => ({
      time: `2026-01-01T${String(hour).padStart(2, "0")}:00`,
      temperatureC: 18.5 + hour / 10,
      feelsLikeC: 17.5 + hour / 10,
      humidityPercent: 65,
      weatherCode: 2,
      weatherDescription: "Partly cloudy",
    })),
  });
});

test("weather endpoint accepts one and fourteen days and rejects invalid input", async () => {
  providerCalls = 0;
  providerFetch = async (url) => {
    const days = Number(new URL(url).searchParams.get("forecast_days"));
    return jsonResponse(forecastResponse(days));
  };

  for (const days of [1, 14]) {
    const response = await fetch(`${baseUrl}/api/weather?latitude=0&longitude=0&forecastDays=${days}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).daily.length, days);
  }

  const callsBeforeInvalidRequests = providerCalls;
  for (const url of [
    "/api/weather?latitude=91&longitude=0",
    "/api/weather?latitude=0&longitude=0&forecastDays=15",
    "/api/weather?latitude=0&longitude=0&forecastDays=1.5",
  ]) {
    const response = await fetch(`${baseUrl}${url}`);
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error.code);
  }
  assert.equal(providerCalls, callsBeforeInvalidRequests);
});

test("weather endpoint preserves null humidity values", async () => {
  const forecast = forecastResponse(7);
  forecast.hourly.relative_humidity_2m[0] = null;
  providerFetch = async () => jsonResponse(forecast);

  const response = await fetch(`${baseUrl}/api/weather?latitude=0&longitude=0`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.daily[0].hourly[0].humidityPercent, null);
});

test("weather endpoint rejects missing, misaligned, and invalid humidity data", async () => {
  const missingHumidity = forecastResponse(7);
  delete missingHumidity.hourly.relative_humidity_2m;
  providerFetch = async () => jsonResponse(missingHumidity);
  let response = await fetch(`${baseUrl}/api/weather?latitude=0&longitude=0`);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "UPSTREAM_INVALID_RESPONSE");

  const misalignedHumidity = forecastResponse(7);
  misalignedHumidity.hourly.relative_humidity_2m.pop();
  providerFetch = async () => jsonResponse(misalignedHumidity);
  response = await fetch(`${baseUrl}/api/weather?latitude=0&longitude=0`);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "UPSTREAM_INVALID_RESPONSE");

  for (const humidity of ["65", -1, 101]) {
    const invalidHumidity = forecastResponse(7);
    invalidHumidity.hourly.relative_humidity_2m[0] = humidity;
    providerFetch = async () => jsonResponse(invalidHumidity);
    response = await fetch(`${baseUrl}/api/weather?latitude=0&longitude=0`);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "UPSTREAM_INVALID_RESPONSE");
  }
});

test("upstream rate limits, timeouts, and malformed payloads produce safe errors", async () => {
  providerFetch = async () => jsonResponse({}, 429);
  let response = await fetch(`${baseUrl}/api/weather?latitude=0&longitude=0`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "UPSTREAM_RATE_LIMIT");

  providerFetch = async () => {
    const error = new Error("request timed out");
    error.name = "TimeoutError";
    throw error;
  };
  response = await fetch(`${baseUrl}/api/weather?latitude=0&longitude=0`);
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, "UPSTREAM_TIMEOUT");

  providerFetch = async () => jsonResponse(forecastResponse(7));
  response = await fetch(`${baseUrl}/api/weather?latitude=0&longitude=0&forecastDays=1`);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "UPSTREAM_INVALID_RESPONSE");

  providerFetch = async () => ({
    status: 200,
    ok: true,
    json: async () => {
      const error = new Error("request timed out while reading body");
      error.name = "AbortError";
      throw error;
    },
  });
  response = await fetch(`${baseUrl}/api/weather?latitude=0&longitude=0`);
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, "UPSTREAM_TIMEOUT");

  providerFetch = async () => ({
    status: 200,
    ok: true,
    json: async () => {
      throw new SyntaxError("invalid JSON");
    },
  });
  response = await fetch(`${baseUrl}/api/weather?latitude=0&longitude=0`);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "UPSTREAM_INVALID_RESPONSE");

  providerFetch = async () => {
    const data = forecastResponse(7);
    delete data.hourly.apparent_temperature;
    return jsonResponse(data);
  };
  response = await fetch(`${baseUrl}/api/weather?latitude=0&longitude=0`);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "UPSTREAM_INVALID_RESPONSE");
});

test("weather endpoint rejects impossible local dates and hourly times", async () => {
  const invalidDate = forecastResponse(7);
  invalidDate.daily.time[0] = "2026-02-30";
  providerFetch = async () => jsonResponse(invalidDate);
  let response = await fetch(`${baseUrl}/api/weather?latitude=0&longitude=0`);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "UPSTREAM_INVALID_RESPONSE");

  const invalidHour = forecastResponse(7);
  invalidHour.hourly.time[0] = "2026-01-01T24:00";
  providerFetch = async () => jsonResponse(invalidHour);
  response = await fetch(`${baseUrl}/api/weather?latitude=0&longitude=0`);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "UPSTREAM_INVALID_RESPONSE");
});

test("weather endpoint rejects incomplete hourly days", async () => {
  const missingHours = forecastResponse(7);
  for (const field of [
    "time",
    "temperature_2m",
    "apparent_temperature",
    "relative_humidity_2m",
    "weather_code",
  ]) {
    missingHours.hourly[field].splice(0, 2);
  }
  providerFetch = async () => jsonResponse(missingHours);
  const response = await fetch(`${baseUrl}/api/weather?latitude=0&longitude=0`);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "UPSTREAM_INVALID_RESPONSE");
});

test("weather endpoint rejects invalid timezone data", async () => {
  const invalidTimezone = forecastResponse(7);
  invalidTimezone.timezone = "Not/A_Timezone";
  providerFetch = async () => jsonResponse(invalidTimezone);
  const response = await fetch(`${baseUrl}/api/weather?latitude=0&longitude=0`);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "UPSTREAM_INVALID_RESPONSE");
});

test("provider requests are limited across rolling time windows", async () => {
  let currentTime = 1000;
  let requestCount = 0;
  const limitedApp = createApp({
    fetchImpl: async () => {
      requestCount += 1;
      return jsonResponse({ results: [] });
    },
    rateLimitOptions: {
      now: () => currentTime,
      limits: [
        { windowMs: 60_000, maxRequests: 2 },
        { windowMs: 60 * 60_000, maxRequests: 3 },
      ],
    },
  });
  const limitedServer = createServer(limitedApp);
  await new Promise((resolve) => limitedServer.listen(0, "127.0.0.1", resolve));
  const limitedBaseUrl = `http://127.0.0.1:${limitedServer.address().port}`;

  try {
    const first = await fetch(`${limitedBaseUrl}/api/locations?query=Oslo`);
    const second = await fetch(`${limitedBaseUrl}/api/locations?query=Oslo`);
    const minuteLimited = await fetch(`${limitedBaseUrl}/api/locations?query=Oslo`);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(minuteLimited.status, 429);
    assert.equal(minuteLimited.headers.get("retry-after"), "60");
    assert.equal((await minuteLimited.json()).error.code, "RATE_LIMITED");
    assert.equal(requestCount, 2);

    currentTime += 60_000;
    const afterMinute = await fetch(`${limitedBaseUrl}/api/locations?query=Oslo`);
    assert.equal(afterMinute.status, 200);
    assert.equal(requestCount, 3);

    const hourLimited = await fetch(`${limitedBaseUrl}/api/locations?query=Oslo`);
    assert.equal(hourLimited.status, 429);
    assert.equal(hourLimited.headers.get("retry-after"), "3540");
    assert.equal(requestCount, 3);
  } finally {
    await new Promise((resolve, reject) => {
      limitedServer.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("Redis provider limiter atomically checks and records every configured window", async () => {
  const limits = [
    { windowMs: 60_000, maxRequests: 2 },
    { windowMs: 3_600_000, maxRequests: 3 },
  ];
  const results = [[1, 0], [0, 27]];
  const calls = [];
  const getRetryAfterSeconds = createRedisProviderRateLimiter({
    eval: async (script, options) => {
      calls.push({ script, options });
      return results.shift();
    },
  }, { limits, keyPrefix: "test:weather" });

  assert.equal(await getRetryAfterSeconds(), 0);
  assert.equal(await getRetryAfterSeconds(), 27);
  assert.equal(calls.length, 2);
  for (const { script, options } of calls) {
    assert.match(script, /redis\.call\('TIME'\)/);
    assert.deepEqual(options.keys, [
      "test:weather:60000",
      "test:weather:3600000",
    ]);
    assert.deepEqual(options.arguments.slice(0, 4), ["60000", "2", "3600000", "3"]);
    assert.match(options.arguments[4], /^[\da-f-]{36}$/);
  }
});

test("unavailable provider rate-limit store fails closed", async () => {
  let upstreamCalls = 0;
  const unavailableApp = createApp({
    fetchImpl: async () => {
      upstreamCalls += 1;
      return jsonResponse({ results: [] });
    },
    providerRateLimiter: async () => {
      throw new Error("Redis unavailable");
    },
    isRateLimitStoreReady: () => false,
  });
  const unavailableServer = createServer(unavailableApp);
  await new Promise((resolve) => unavailableServer.listen(0, "127.0.0.1", resolve));
  const unavailableBaseUrl = `http://127.0.0.1:${unavailableServer.address().port}`;

  try {
    const health = await fetch(`${unavailableBaseUrl}/api/health`);
    assert.equal(health.status, 503);
    assert.equal((await health.json()).error.code, "RATE_LIMIT_STORE_UNAVAILABLE");

    const locations = await fetch(`${unavailableBaseUrl}/api/locations?query=Oslo`);
    assert.equal(locations.status, 503);
    assert.equal((await locations.json()).error.code, "RATE_LIMIT_STORE_UNAVAILABLE");
    assert.equal(upstreamCalls, 0);
  } finally {
    await new Promise((resolve, reject) => {
      unavailableServer.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("location cache canonicalizes case and whitespace and hits bypass quota", async () => {
  const cache = createMemoryCache();
  let upstreamCalls = 0;
  let quotaChecks = 0;
  const app = await startApp({
    cacheClient: cache,
    providerRateLimiter: async () => {
      quotaChecks += 1;
      return 0;
    },
    fetchImpl: async () => {
      upstreamCalls += 1;
      return jsonResponse({
        results: [{
          id: 123,
          name: "Sydney",
          admin1: "New South Wales",
          country: "Australia",
          latitude: -33.87,
          longitude: 151.21,
        }],
      });
    },
  });

  try {
    const first = await fetch(`${app.baseUrl}/api/locations?query=%20Sydney%20`);
    const second = await fetch(`${app.baseUrl}/api/locations?query=%20sYDNEY%20`);
    assert.equal(first.status, 200);
    assert.deepEqual(await second.json(), await first.json());
    assert.equal(upstreamCalls, 1);
    assert.equal(quotaChecks, 1);
    assert.equal(cache.writes.length, 1);
    assert.equal(cache.writes[0].key, "weather:locations:sydney");
    assert.deepEqual(JSON.parse(cache.writes[0].value), {
      locations: [{
        id: 123,
        name: "Sydney",
        region: "New South Wales",
        country: "Australia",
        latitude: -33.87,
        longitude: 151.21,
      }],
    });
    assert.deepEqual(cache.writes[0].options, {
      EX: CACHE_TTL_SECONDS.locations,
    });
    assert.equal(CACHE_TTL_SECONDS.locations, 24 * 60 * 60);
  } finally {
    await app.close();
  }
});

test("weather cache canonicalizes numeric inputs, uses forecast TTL, and bypasses quota on hit", async () => {
  const cache = createMemoryCache();
  let upstreamCalls = 0;
  let quotaChecks = 0;
  const app = await startApp({
    cacheClient: cache,
    providerRateLimiter: async () => {
      quotaChecks += 1;
      return 0;
    },
    fetchImpl: async (url) => {
      upstreamCalls += 1;
      const days = Number(new URL(url).searchParams.get("forecast_days"));
      return jsonResponse(forecastResponse(days));
    },
  });

  try {
    const first = await fetch(
      `${app.baseUrl}/api/weather?latitude=1.500&longitude=-0&forecastDays=7`,
    );
    const firstBody = await first.json();
    const second = await fetch(
      `${app.baseUrl}/api/weather?latitude=1.5&longitude=0`,
    );
    assert.equal(first.status, 200);
    assert.deepEqual(await second.json(), firstBody);
    assert.equal(upstreamCalls, 1);
    assert.equal(quotaChecks, 1);
    assert.equal(cache.writes.length, 1);
    assert.equal(cache.writes[0].key, "weather:forecast:1.5:0:7");
    assert.deepEqual(cache.writes[0].options, {
      EX: CACHE_TTL_SECONDS.weather,
    });
    assert.equal(CACHE_TTL_SECONDS.weather, 10 * 60);
    assert.equal(JSON.parse(cache.writes[0].value).daily.length, 7);
  } finally {
    await app.close();
  }
});

test("invalid cache entries are misses and Redis cache failures fail open", async () => {
  const cache = {
    async get() {
      return "{}";
    },
    async set() {
      throw new Error("write unavailable");
    },
  };
  let upstreamCalls = 0;
  let quotaChecks = 0;
  const app = await startApp({
    cacheClient: cache,
    providerRateLimiter: async () => {
      quotaChecks += 1;
      return 0;
    },
    fetchImpl: async () => {
      upstreamCalls += 1;
      return jsonResponse({ results: [] });
    },
  });
  const loggedErrors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => loggedErrors.push(args);

  try {
    const response = await fetch(`${app.baseUrl}/api/locations?query=Private%20Place`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { locations: [] });
    assert.equal(upstreamCalls, 1);
    assert.equal(quotaChecks, 1);
    assert.equal(loggedErrors.length, 1);
    assert.equal(loggedErrors[0][0], "Redis cache write failed:");
    assert.equal(String(loggedErrors[0][1]), "Error: write unavailable");
    assert.equal(loggedErrors.flat().join(" ").includes("Private Place"), false);
  } finally {
    console.error = originalConsoleError;
    await app.close();
  }
});

test("Redis cache read failures log safely and continue through quota and upstream", async () => {
  const cache = {
    async get() {
      throw new Error("read unavailable");
    },
    async set() {},
  };
  let upstreamCalls = 0;
  let quotaChecks = 0;
  const app = await startApp({
    cacheClient: cache,
    providerRateLimiter: async () => {
      quotaChecks += 1;
      return 0;
    },
    fetchImpl: async () => {
      upstreamCalls += 1;
      return jsonResponse({ results: [] });
    },
  });
  const loggedErrors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => loggedErrors.push(args);

  try {
    const response = await fetch(`${app.baseUrl}/api/locations?query=Private%20Place`);
    assert.equal(response.status, 200);
    assert.equal(upstreamCalls, 1);
    assert.equal(quotaChecks, 1);
    assert.equal(loggedErrors.length, 1);
    assert.equal(loggedErrors[0][0], "Redis cache read failed:");
    assert.equal(String(loggedErrors[0][1]), "Error: read unavailable");
    assert.equal(loggedErrors.flat().join(" ").includes("Private Place"), false);
  } finally {
    console.error = originalConsoleError;
    await app.close();
  }
});
