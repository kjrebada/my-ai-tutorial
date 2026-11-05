import { useEffect, useId, useRef, useState } from "react";

const FORECAST_LENGTHS = Array.from({ length: 14 }, (_, index) => index + 1);

function getWeatherSymbol(code) {
  if (code === 0) return "☀";
  if (code === 1 || code === 2) return "⛅";
  if (code === 3 || code === 45 || code === 48) return "☁";
  if (code >= 51 && code <= 67) return "☂";
  if (code >= 80 && code <= 82) return "☂";
  if (code >= 71 && code <= 86) return "❄";
  if (code >= 95) return "⚡";
  return "◌";
}

function formatForecastDate(date) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatLongDate(date) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function formatHour(time) {
  const [hours, minutes] = time.slice(11).split(":").map(Number);
  return new Date(2000, 0, 1, hours, minutes).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function getCurrentHourKey(timezone, timestamp) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(timestamp);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:00`;
}

function getAverageHumidity(hourly) {
  const humidityValues = (Array.isArray(hourly) ? hourly : [])
    .map((hour) => hour?.humidityPercent)
    .filter((humidity) => Number.isFinite(humidity));
  if (humidityValues.length === 0) return null;
  return humidityValues.reduce((total, humidity) => total + humidity, 0) / humidityValues.length;
}

async function getErrorMessage(response) {
  try {
    const data = await response.json();
    return data.error?.message ?? `Request failed (${response.status}). Please try again.`;
  } catch {
    return `Request failed (${response.status}). Please try again.`;
  }
}

export default function App() {
  const listboxId = useId();
  const searchId = useId();
  const daysId = useId();
  const searchRef = useRef(null);
  const [query, setQuery] = useState("");
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [forecastDays, setForecastDays] = useState(7);
  const [suggestions, setSuggestions] = useState([]);
  const [suggestionState, setSuggestionState] = useState("idle");
  const [suggestionMessage, setSuggestionMessage] = useState("");
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [forecastRequest, setForecastRequest] = useState(0);
  const [forecast, setForecast] = useState({ state: "idle", data: null, error: "" });

  useEffect(() => {
    const searchTerm = query.trim();
    if (selectedLocation || searchTerm.length < 2) {
      setSuggestions([]);
      setSuggestionState("idle");
      setSuggestionMessage(searchTerm.length === 1 ? "Enter at least 2 characters to search." : "");
      return undefined;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(async () => {
      setSuggestionState("loading");
      setSuggestionMessage("");
      try {
        const response = await fetch(
          `/api/locations?query=${encodeURIComponent(searchTerm)}`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          throw new Error(await getErrorMessage(response));
        }
        const data = await response.json();
        if (controller.signal.aborted) return;
        if (!Array.isArray(data.locations)) {
          throw new Error("The location service returned an unexpected response.");
        }
        setSuggestions(data.locations);
        setSuggestionState(data.locations.length > 0 ? "ready" : "empty");
        setSuggestionMessage(
          data.locations.length > 0
            ? `${data.locations.length} locations available. Use the arrow keys to browse.`
            : "No matching locations. Try another city or place.",
        );
      } catch (error) {
        if (!controller.signal.aborted && error.name !== "AbortError") {
          setSuggestions([]);
          setSuggestionState("error");
          setSuggestionMessage(error.message || "Could not load locations. Please try again.");
        }
      }
    }, 300);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [query, selectedLocation]);

  useEffect(() => {
    if (!selectedLocation) return undefined;

    const controller = new AbortController();
    async function loadForecast() {
      try {
        const parameters = new URLSearchParams({
          latitude: String(selectedLocation.latitude),
          longitude: String(selectedLocation.longitude),
          forecastDays: String(forecastDays),
        });
        const response = await fetch(`/api/weather?${parameters}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(await getErrorMessage(response));
        }
        const data = await response.json();
        if (controller.signal.aborted) return;
        if (!data.current
          || typeof data.timezone !== "string"
          || !Array.isArray(data.daily)
          || data.daily.length !== forecastDays
          || data.daily.some((day) => {
            return !Array.isArray(day.hourly)
              || !(day.uvIndexMax === null || Number.isFinite(day.uvIndexMax));
          })) {
          throw new Error("The weather service returned an incomplete forecast.");
        }
        setForecast({ state: "ready", data, error: "" });
      } catch (error) {
        if (!controller.signal.aborted && error.name !== "AbortError") {
          setForecast({
            state: "error",
            data: null,
            error: error.message || "Could not load weather. Please try again.",
          });
        }
      }
    }

    loadForecast();
    return () => controller.abort();
  }, [selectedLocation, forecastDays, forecastRequest]);

  function chooseLocation(location) {
    setQuery(location.name);
    setSelectedLocation(location);
    setSuggestions([]);
    setSuggestionState("idle");
    setSuggestionMessage("");
    setActiveSuggestion(-1);
    setForecast({ state: "loading", data: null, error: "" });
  }

  function handleSearchChange(event) {
    setQuery(event.target.value);
    setSelectedLocation(null);
    setSuggestions([]);
    setSuggestionState("idle");
    setSuggestionMessage("");
    setActiveSuggestion(-1);
    setForecast({ state: "idle", data: null, error: "" });
  }

  function handleSearchKeyDown(event) {
    if (event.key === "ArrowDown" && suggestions.length > 0) {
      event.preventDefault();
      setActiveSuggestion((activeSuggestion + 1) % suggestions.length);
    } else if (event.key === "ArrowUp" && suggestions.length > 0) {
      event.preventDefault();
      setActiveSuggestion(
        activeSuggestion < 0
          ? suggestions.length - 1
          : (activeSuggestion + suggestions.length - 1) % suggestions.length,
      );
    } else if (event.key === "Enter" && activeSuggestion >= 0) {
      event.preventDefault();
      chooseLocation(suggestions[activeSuggestion]);
    } else if (event.key === "Escape") {
      setSuggestions([]);
      setSuggestionState("idle");
      setActiveSuggestion(-1);
      setSuggestionMessage("");
    }
  }

  function handleForecastDaysChange(event) {
    setForecastDays(Number(event.target.value));
    if (selectedLocation) {
      setForecast({ state: "loading", data: null, error: "" });
    }
  }

  const suggestionsOpen = suggestions.length > 0 && !selectedLocation;

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="Skyward Weather home">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span>skyward<span className="brand-light">weather</span></span>
        </a>
        <div className="header-note">
          <span className="live-dot" aria-hidden="true" />
          Forecasts for wherever you are
        </div>
      </header>

      <main className="main-content">
        <section className="intro-section" aria-labelledby="page-title">
          <p className="eyebrow">YOUR DAILY WEATHER, SIMPLIFIED</p>
          <h1 id="page-title">A little more <span>sunshine</span> in your day.</h1>
          <p className="intro-copy">
            Find a place and get a clear look at the weather ahead.
          </p>
        </section>

        <section className="search-panel" aria-label="Weather search">
          <div className="search-field">
            <label htmlFor={searchId}>Search for a city or place</label>
            <div className="input-wrap">
              <span className="search-icon" aria-hidden="true">⌕</span>
              <input
                ref={searchRef}
                id={searchId}
                type="text"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={suggestionsOpen}
                aria-controls={listboxId}
                aria-activedescendant={
                  activeSuggestion >= 0 ? `${listboxId}-option-${activeSuggestion}` : undefined
                }
                aria-describedby={`${searchId}-hint`}
                autoComplete="off"
                placeholder="Try “Copenhagen”"
                value={query}
                onChange={handleSearchChange}
                onKeyDown={handleSearchKeyDown}
              />
              {query && (
                <button
                  className="clear-search"
                  type="button"
                  aria-label="Clear location search"
                  onClick={() => {
                    setQuery("");
                    setSelectedLocation(null);
                    setSuggestions([]);
                    setSuggestionState("idle");
                    setSuggestionMessage("");
                    setForecast({ state: "idle", data: null, error: "" });
                    searchRef.current?.focus();
                  }}
                >
                  ×
                </button>
              )}
              {suggestionsOpen && (
                <ul className="suggestion-list" id={listboxId} role="listbox" aria-label="Matching locations">
                  {suggestions.map((location, index) => {
                    const detail = [location.region, location.country].filter(Boolean).join(", ");
                    return (
                      <li
                        key={`${location.id ?? location.name}-${location.latitude}-${location.longitude}`}
                        id={`${listboxId}-option-${index}`}
                        className={`suggestion-option${index === activeSuggestion ? " is-active" : ""}`}
                        role="option"
                        aria-selected={index === activeSuggestion}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => chooseLocation(location)}
                      >
                        <span className="location-pin" aria-hidden="true">⌖</span>
                        <span className="suggestion-copy">
                          <span className="suggestion-name">{location.name}</span>
                          {detail && <span className="suggestion-detail">{detail}</span>}
                        </span>
                        <span className="suggestion-arrow" aria-hidden="true">↗</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <span className="field-hint" id={`${searchId}-hint`}>
              {selectedLocation
                ? `Selected: ${[selectedLocation.region, selectedLocation.country].filter(Boolean).join(", ")}`
                : "Choose a suggestion to see local conditions"}
            </span>
            {suggestionState === "empty" && (
              <p className="search-feedback" aria-hidden="true">{suggestionMessage}</p>
            )}
          </div>

          <div className="forecast-control">
            <label htmlFor={daysId}>Forecast length</label>
            <div className="select-wrap">
              <select id={daysId} value={forecastDays} onChange={handleForecastDaysChange}>
                {FORECAST_LENGTHS.map((days) => (
                  <option value={days} key={days}>{days} {days === 1 ? "day" : "days"}</option>
                ))}
              </select>
              <span className="select-chevron" aria-hidden="true">⌄</span>
            </div>
            <span className="field-hint">Up to 14 days ahead</span>
          </div>
        </section>

        <div className="screen-reader-status" role="status" aria-live="polite" aria-atomic="true">
          {suggestionState === "loading" && "Searching for locations."}
          {(suggestionState === "ready" || suggestionState === "empty") && suggestionMessage}
          {forecast.state === "loading" && "Loading weather forecast."}
          {forecast.state === "ready" && `${forecast.data.daily.length}-day forecast loaded for ${selectedLocation?.name}.`}
        </div>

        {suggestionState === "error" && (
          <p className="inline-error" role="alert">{suggestionMessage}</p>
        )}

        {!selectedLocation && (
          <section className="empty-state" aria-labelledby="empty-title">
            <div className="empty-art" aria-hidden="true">
              <span className="sun-disc" />
              <span className="cloud-shape cloud-one" />
              <span className="cloud-shape cloud-two" />
            </div>
            <h2 id="empty-title">Where to next?</h2>
            <p>Your forecast is just one search away. Start with any city or place.</p>
            <div className="empty-meta">
              <span aria-hidden="true">✦</span> Current conditions + up to 14 days
            </div>
          </section>
        )}

        {selectedLocation && forecast.state === "loading" && (
          <section className="loading-panel" aria-label="Loading weather forecast" aria-busy="true">
            <span className="loading-spinner" aria-hidden="true" />
            <p>Gathering the forecast for {selectedLocation.name}…</p>
          </section>
        )}

        {selectedLocation && forecast.state === "error" && (
          <section className="error-panel" role="alert">
            <span className="error-symbol" aria-hidden="true">!</span>
            <div>
              <h2>We couldn’t load this forecast</h2>
              <p>{forecast.error}</p>
              <button
                className="retry-button"
                type="button"
                onClick={() => {
                  setForecast({ state: "loading", data: null, error: "" });
                  setForecastRequest((request) => request + 1);
                }}
              >
                Try again
              </button>
            </div>
          </section>
        )}

        {selectedLocation && forecast.state === "ready" && (
          <WeatherDashboard location={selectedLocation} forecast={forecast.data} />
        )}

        <footer className="site-footer">
          <span>Weather data by <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a></span>
          <span className="footer-divider" aria-hidden="true">·</span>
          <span>Made for clearer days</span>
        </footer>
      </main>
    </div>
  );
}

function WeatherDashboard({ location, forecast }) {
  return (
    <section className="weather-dashboard" aria-label={`Weather in ${location.name}`}>
      <div className="current-weather">
        <div className="current-copy">
          <div className="location-label">
            <span className="location-marker" aria-hidden="true">⌖</span>
            <span>{location.name}</span>
            {location.region && <span className="location-region">{location.region}</span>}
          </div>
          <p className="current-date">{formatLongDate(forecast.daily[0].date)}</p>
          <div className="current-condition">
            <span className="current-symbol" aria-hidden="true">{getWeatherSymbol(forecast.current.weatherCode)}</span>
            <div>
              <p className="current-temperature">
                {forecast.current.temperatureC === null ? "—" : Math.round(forecast.current.temperatureC)}
                <span>°</span>
              </p>
              <p className="current-description">{forecast.current.weatherDescription}</p>
            </div>
          </div>
        </div>
        <aside className="current-aside" aria-label="Current conditions">
          <div className="aside-sun" aria-hidden="true">☼</div>
          <p>Right now</p>
          <span>Take the day as it comes.</span>
        </aside>
      </div>

      <div className="forecast-heading">
        <div>
          <p className="section-kicker">PLAN AHEAD</p>
          <h2>Your {forecast.daily.length}-day forecast</h2>
        </div>
        <span className="unit-note">Temperature <strong>°C</strong></span>
      </div>

      <div className="forecast-grid">
        {forecast.daily.map((day, index) => (
          <ForecastDayCard
            day={day}
            index={index}
            key={day.date}
            timezone={forecast.timezone}
          />
        ))}
      </div>
    </section>
  );
}

function ForecastDayCard({ day, index, timezone }) {
  const cardRef = useRef(null);
  const triggerRef = useRef(null);
  const currentHourRef = useRef(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const popupVisible = (hovered || focused || expanded) && !dismissed;
  const currentHour = getCurrentHourKey(timezone, now);
  const hourly = Array.isArray(day.hourly) ? day.hourly : [];
  const averageHumidity = getAverageHumidity(hourly);
  const headingId = `hourly-heading-${day.date}`;
  const popupId = `hourly-forecast-${day.date}`;

  useEffect(() => {
    if (!popupVisible) return undefined;

    function handleGlobalEscape(event) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setExpanded(false);
      setDismissed(true);
      if (cardRef.current?.contains(document.activeElement)) {
        triggerRef.current?.focus();
      }
    }

    window.addEventListener("keydown", handleGlobalEscape);
    return () => window.removeEventListener("keydown", handleGlobalEscape);
  }, [popupVisible]);

  useEffect(() => {
    if (!popupVisible) return undefined;
    const intervalId = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(intervalId);
  }, [popupVisible]);

  useEffect(() => {
    if (popupVisible) {
      currentHourRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [popupVisible, currentHour]);

  function dismissPopup() {
    setExpanded(false);
    setDismissed(true);
    triggerRef.current?.focus();
  }

  function handleBlur(event) {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setFocused(false);
      setDismissed(false);
    }
  }

  function handleKeyDown(event) {
    if (event.key === "Escape" && popupVisible) {
      event.preventDefault();
      event.stopPropagation();
      dismissPopup();
    }
  }

  return (
    <article
      ref={cardRef}
      className={`forecast-day${index === 0 ? " forecast-day--today" : ""}`}
      aria-label={`${formatForecastDate(day.date)} forecast`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        if (!focused) setDismissed(false);
      }}
      onFocus={() => setFocused(true)}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      <h3>{formatForecastDate(day.date)}</h3>
      <span className="forecast-symbol" aria-hidden="true">{getWeatherSymbol(day.weatherCode)}</span>
      <p className="forecast-description">{day.weatherDescription}</p>
      <dl className="temperature-range">
        <div>
          <dt>High</dt>
          <dd className="high-temp">{day.temperatureMaxC === null ? "—" : `${Math.round(day.temperatureMaxC)}°`}</dd>
        </div>
        <div>
          <dt>Low</dt>
          <dd className="low-temp">{day.temperatureMinC === null ? "—" : `${Math.round(day.temperatureMinC)}°`}</dd>
        </div>
      </dl>
      <button
        ref={triggerRef}
        className="forecast-detail-toggle"
        type="button"
        aria-label={`Hourly forecast details for ${formatForecastDate(day.date)}`}
        aria-expanded={popupVisible}
        aria-controls={popupId}
        onClick={() => {
          if (expanded) {
            dismissPopup();
          } else {
            setExpanded(true);
            setDismissed(false);
          }
        }}
      >
        Hourly details
      </button>
      <section
        id={popupId}
        className="forecast-popover"
        aria-labelledby={headingId}
        hidden={!popupVisible}
        onMouseEnter={() => setHovered(true)}
      >
          <header className="forecast-popover-header">
            <div>
              <p>{formatForecastDate(day.date)}</p>
              <h4 id={headingId}>Hourly forecast</h4>
            </div>
            <button
              className="forecast-popover-close"
              type="button"
              aria-label={`Close hourly forecast for ${formatForecastDate(day.date)}`}
              onClick={dismissPopup}
            >
              ×
            </button>
          </header>
          <p className="uv-index">
            <span aria-hidden="true">☼</span>
            Maximum UV index
            <strong>{day.uvIndexMax === null ? "Unavailable" : day.uvIndexMax.toFixed(1)}</strong>
          </p>
          <p className="humidity-summary">
            <span aria-hidden="true">◉</span>
            Average humidity
            <strong>{averageHumidity === null ? "Unavailable" : `${Math.round(averageHumidity)}%`}</strong>
          </p>
          <ul className="hourly-list">
            {hourly.map((hour) => {
              const isCurrentHour = hour.time === currentHour;
              return (
                <li
                  className={`hourly-row${isCurrentHour ? " hourly-row--current" : ""}`}
                  key={hour.time}
                >
                  <time
                    ref={isCurrentHour ? currentHourRef : undefined}
                    dateTime={hour.time}
                    aria-current={isCurrentHour ? "time" : undefined}
                  >
                    {formatHour(hour.time)}
                    {isCurrentHour && <span className="current-hour-label">Now</span>}
                  </time>
                  <span className="hourly-condition">
                    <span aria-hidden="true">{getWeatherSymbol(hour.weatherCode)}</span>
                    {hour.weatherDescription}
                  </span>
                  <span className="hourly-temperature">
                    {hour.temperatureC === null ? "—" : `${Math.round(hour.temperatureC)}°`}
                    <span>
                      Feels {hour.feelsLikeC === null ? "—" : `${Math.round(hour.feelsLikeC)}°`}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="hourly-units">Times are local · temperature and feels like in °C</p>
      </section>
    </article>
  );
}
