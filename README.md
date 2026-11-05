# React + Express starter

A simple full-stack template with a React frontend and a separate Express backend.

## Requirements

- Node.js 20.19 or newer
- npm
- Docker with the Docker Compose plugin (for the containerized setup)

## Run with Docker Compose

From the project root, build and start the frontend, API, and shared Redis
rate-limit and response-cache store:

```sh
docker compose up --build -d
docker compose ps
```

Open the frontend at `http://localhost:5173`; the API is available at
`http://localhost:3001`. The frontend container proxies `/api` requests to the
backend. Verify the API and a weather lookup with:

```sh
curl http://localhost:3001/api/health
curl "http://localhost:3001/api/locations?query=Sydney"
curl "http://localhost:3001/api/weather?latitude=-33.87&longitude=151.21&forecastDays=7"
```

View service logs and stop the stack with:

```sh
docker compose logs -f
docker compose down
```

Redis stores the shared provider quota counters and successful normalized
Open-Meteo responses in a Compose-managed volume.
`docker compose down -v` also removes that volume and resets the stored quota
history and cached responses.

## Run locally

For development without Docker, open two terminals from the project root:

```sh
cd backend
npm install
npm run dev
```

```sh
cd frontend
npm install
npm run dev
```

The frontend is served at `http://localhost:5173` and the API at
`http://localhost:3001`. Vite proxies `/api` requests to the backend during
development.

## Project structure

```text
backend/   Express API
frontend/  React app (Vite)
```

The example frontend calls `GET /api/health` and displays the backend response.

## Weather API

The backend proxies Open-Meteo and returns a provider-independent JSON contract.
Location search requires at least two characters and returns up to ten matches:

```text
GET /api/locations?query=Sydney
```

Each match has `id`, `name`, `region`, `country`, `latitude`, and `longitude`.
Use the selected match's coordinates to request weather. `forecastDays` is an
integer from 1 to 14 and defaults to 7:

```text
GET /api/weather?latitude=-33.87&longitude=151.21&forecastDays=7
```

The response contains the forecast location's IANA `timezone`, current
temperature in °C and a WMO weather code and description, plus the requested
number of daily local-date forecasts with
weather code/description, high/low temperatures in °C, daily maximum UV index,
and hourly local-time entries with condition, temperature, and apparent
("feels like") temperature in °C. Hourly entries are grouped under their local
forecast date. If wind speed or precipitation fields are added, they use km/h
and mm respectively. Both endpoints disable HTTP caching.

The backend caches only successful normalized API responses in Redis:
location suggestions for 24 hours and weather forecasts for 10 minutes.
Location keys use the trimmed, case-insensitive query; weather keys use
normalized numeric latitude/longitude and forecast-day values. Valid cache hits
are served before checking provider quota; misses and Redis cache read failures
continue through the shared provider rate limiter and Open-Meteo. Redis cache
write failures do not fail a successful response.

The backend limits upstream requests to 500 per minute, 4,500 per hour, and
9,000 per rolling 24 hours. Excess requests receive HTTP 429 with a
`Retry-After` header. Docker Compose configures Redis as a shared atomic
rate-limit store and response cache, so backend instances share provider quota
and cached results. For non-containerized local development, set `REDIS_URL` to
a reachable Redis instance to share quotas and caching; without it, limits are
process-local and responses are not cached.

The free Open-Meteo API is suitable only while this educational project remains
non-commercial. Display linked Open-Meteo attribution in the UI and follow its
[terms](https://open-meteo.com/en/terms) and [rate limits](https://open-meteo.com/en/pricing).
If the project becomes commercial, use a suitably licensed paid plan or provider.

Run backend verification with `cd backend && npm test`.
