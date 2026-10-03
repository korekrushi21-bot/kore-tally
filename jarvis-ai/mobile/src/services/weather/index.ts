import * as Location from 'expo-location';
import { AppError } from '../../utils';
import { isOnline } from '../ai/api';

export interface Weather {
  place: string;
  current: { temp: number; feels: number; humidity: number; wind: number; code: number; rainProb: number };
  hourly: { time: string; temp: number; rain: number }[];
  daily: { date: string; max: number; min: number; rain: number; code: number }[];
}

export const describeCode = (c: number) =>
  c === 0 ? 'Clear' : c <= 3 ? 'Partly cloudy' : c <= 48 ? 'Fog' : c <= 57 ? 'Drizzle' : c <= 67 ? 'Rain' : c <= 77 ? 'Snow' : c <= 82 ? 'Rain showers' : c <= 86 ? 'Snow showers' : 'Thunderstorm';
export const iconFor = (c: number) => (c === 0 ? '☀️' : c <= 3 ? '⛅' : c <= 48 ? '🌫️' : c <= 67 ? '🌧️' : c <= 77 ? '❄️' : c <= 82 ? '🌦️' : '⛈️');

/** Location is used transiently and never stored. */
export async function currentCoords(): Promise<{ lat: number; lon: number }> {
  const p = await Location.requestForegroundPermissionsAsync();
  if (!p.granted) throw new AppError('location');
  const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  return { lat: pos.coords.latitude, lon: pos.coords.longitude };
}

export async function geocode(name: string) {
  if (!(await isOnline())) throw new AppError('offline');
  // Devanagari names only match when the geocoder is told the language (mr / hi).
  const langs = /[\u0900-\u097F]/.test(name) ? ['mr', 'hi', 'en'] : ['en'];
  let j: any = {};
  for (const l of langs) {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=5&language=${l}`);
    if (!r.ok) throw new AppError('failed');
    j = await r.json();
    if (j.results?.length) break;
  }
  return ((j.results ?? []) as any[]).map((x) => ({
    name: [x.name, x.admin1, x.country].filter(Boolean).join(', '), lat: x.latitude as number, lon: x.longitude as number,
  }));
}

/** Open-Meteo: free, no API key. */
export async function fetchWeather(lat: number, lon: number, place: string): Promise<Weather> {
  if (!(await isOnline())) throw new AppError('offline');
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&timezone=auto&forecast_days=7` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code` +
    `&hourly=temperature_2m,precipitation_probability&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code`;
  const r = await fetch(url);
  if (!r.ok) throw new AppError('failed');
  const j = await r.json();
  const nowHour = (j.current.time as string).slice(0, 13);
  const i0 = Math.max(0, (j.hourly.time as string[]).findIndex((t) => t.startsWith(nowHour)));
  return {
    place,
    current: {
      temp: j.current.temperature_2m, feels: j.current.apparent_temperature, humidity: j.current.relative_humidity_2m,
      wind: j.current.wind_speed_10m, code: j.current.weather_code, rainProb: j.hourly.precipitation_probability[i0] ?? 0,
    },
    hourly: (j.hourly.time as string[]).slice(i0, i0 + 24).map((t, i) => ({ time: t.slice(11, 16), temp: j.hourly.temperature_2m[i0 + i], rain: j.hourly.precipitation_probability[i0 + i] })),
    daily: (j.daily.time as string[]).map((d, i) => ({ date: d, max: j.daily.temperature_2m_max[i], min: j.daily.temperature_2m_min[i], rain: j.daily.precipitation_probability_max[i], code: j.daily.weather_code[i] })),
  };
}
