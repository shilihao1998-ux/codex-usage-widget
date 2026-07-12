'use strict';

// WMO weather codes as returned by Open-Meteo.
const CONDITIONS = {
  0: ['Clear', '☀️'],
  1: ['Mostly clear', '🌤'],
  2: ['Partly cloudy', '⛅'],
  3: ['Overcast', '☁️'],
  45: ['Fog', '🌫'],
  48: ['Rime fog', '🌫'],
  51: ['Light drizzle', '🌦'],
  53: ['Drizzle', '🌦'],
  55: ['Heavy drizzle', '🌦'],
  56: ['Freezing drizzle', '🌧'],
  57: ['Freezing drizzle', '🌧'],
  61: ['Light rain', '🌦'],
  63: ['Rain', '🌧'],
  65: ['Heavy rain', '🌧'],
  66: ['Freezing rain', '🌧'],
  67: ['Freezing rain', '🌧'],
  71: ['Light snow', '🌨'],
  73: ['Snow', '🌨'],
  75: ['Heavy snow', '❄️'],
  77: ['Snow grains', '🌨'],
  80: ['Showers', '🌦'],
  81: ['Showers', '🌧'],
  82: ['Violent showers', '⛈'],
  85: ['Snow showers', '🌨'],
  86: ['Snow showers', '❄️'],
  95: ['Thunderstorm', '⛈'],
  96: ['Thunderstorm, hail', '⛈'],
  99: ['Thunderstorm, hail', '⛈'],
};

const geocodeCache = new Map();

async function geocode(ctx, city) {
  if (geocodeCache.has(city)) return geocodeCache.get(city);
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
  const data = await ctx.fetchJson(url);
  const hit = data?.results?.[0];
  if (!hit) throw new Error(`city not found: ${city}`);
  const place = { latitude: hit.latitude, longitude: hit.longitude, name: hit.name };
  geocodeCache.set(city, place);
  return place;
}

exports.fetch = async (ctx) => {
  const { city, latitude, longitude, units } = ctx.config;
  const imperial = String(units).toLowerCase() === 'imperial';

  const place =
    latitude != null && longitude != null
      ? { latitude, longitude, name: city || `${latitude},${longitude}` }
      : await geocode(ctx, city || 'Shanghai');

  const params = new URLSearchParams({
    latitude: place.latitude,
    longitude: place.longitude,
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: '1',
  });
  if (imperial) {
    params.set('temperature_unit', 'fahrenheit');
    params.set('wind_speed_unit', 'mph');
  }

  const data = await ctx.fetchJson(`https://api.open-meteo.com/v1/forecast?${params}`);
  const cur = data.current || {};
  const day = data.daily || {};
  const [text, emoji] = CONDITIONS[cur.weather_code] || ['Unknown', '❓'];
  const deg = imperial ? '°F' : '°C';
  const speed = imperial ? 'mph' : 'km/h';
  const round = (v) => (v == null ? '--' : Math.round(v));

  return {
    title: place.name,
    icon: emoji,
    rows: [
      {
        label: text,
        value: `${round(cur.temperature_2m)}${deg}`,
        sub: `feels ${round(cur.apparent_temperature)}${deg} · H ${round(day.temperature_2m_max?.[0])}° L ${round(day.temperature_2m_min?.[0])}°`,
      },
      {
        label: 'Rain chance',
        value: `${round(day.precipitation_probability_max?.[0])}%`,
        sub: `humidity ${round(cur.relative_humidity_2m)}% · wind ${round(cur.wind_speed_10m)} ${speed}`,
        progress: Number(day.precipitation_probability_max?.[0] ?? 0),
        tone: (day.precipitation_probability_max?.[0] ?? 0) >= 60 ? 'warn' : 'default',
      },
    ],
  };
};
