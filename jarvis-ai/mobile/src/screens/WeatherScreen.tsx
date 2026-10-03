import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Btn, Glass, Input, Screen, T } from '../components/ui';
import { useAssistant } from '../hooks/AssistantContext';
import { currentCoords, describeCode, fetchWeather, geocode, iconFor, type Weather } from '../services/weather';
import { friendly } from '../utils';

export default function WeatherScreen({ navigation }: any) {
  const { settings, updateSettings, colors } = useAssistant();
  const [w, setW] = useState<Weather | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ name: string; lat: number; lon: number }[]>([]);

  const load = useCallback(async (useDevice: boolean) => {
    setBusy(true); setErr('');
    try {
      if (!useDevice && settings.manualLocation) {
        const m = settings.manualLocation; setW(await fetchWeather(m.lat, m.lon, m.name));
      } else {
        const c = await currentCoords(); setW(await fetchWeather(c.lat, c.lon, 'Current location'));
      }
    } catch (e) { setErr(friendly(e) + ' You can pick a city below.'); }
    setBusy(false);
  }, [settings.manualLocation]);

  useEffect(() => { void load(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const search = async () => { try { setResults(await geocode(q)); } catch (e) { setErr(friendly(e)); } };

  return (
    <Screen title="Weather" onBack={() => navigation.goBack()}>
      {busy && <T sub>Loading…</T>}
      {!!err && <T style={{ color: colors.err }}>{err}</T>}
      {w && (
        <>
          <Glass>
            <T sub>{w.place}</T>
            <T size={48} bold>{iconFor(w.current.code)} {Math.round(w.current.temp)}°C</T>
            <T>{describeCode(w.current.code)} · feels {Math.round(w.current.feels)}°</T>
            <T sub>Rain probability {w.current.rainProb}% · Humidity {w.current.humidity}% · Wind {Math.round(w.current.wind)} km/h</T>
          </Glass>
          <T bold>Hourly</T>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {w.hourly.map((h, i) => (
              <Glass key={i} style={{ marginRight: 8, alignItems: 'center', minWidth: 64 }}>
                <T sub size={12}>{h.time}</T><T bold>{Math.round(h.temp)}°</T><T size={12} style={{ color: colors.accent }}>💧{h.rain}%</T>
              </Glass>
            ))}
          </ScrollView>
          <T bold>7-day forecast</T>
          {w.daily.map((d) => (
            <Glass key={d.date} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <T>{new Date(d.date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })} {iconFor(d.code)}</T>
              <T>{Math.round(d.max)}° / {Math.round(d.min)}° · 💧{d.rain}%</T>
            </Glass>
          ))}
          <T sub size={11}>Data: Open-Meteo.</T>
        </>
      )}
      <Glass style={{ gap: 8 }}>
        <T bold>Choose location</T>
        <Btn label="Use my current location" kind="ghost" onPress={() => load(true)} />
        <Input value={q} onChangeText={setQ} placeholder="City (e.g. Solapur)" onSubmitEditing={search} returnKeyType="search" />
        <Btn label="Search city" onPress={search} />
        {results.map((r) => (
          <Pressable key={r.name + r.lat} onPress={async () => { await updateSettings({ manualLocation: r }); setResults([]); setW(await fetchWeather(r.lat, r.lon, r.name).catch(() => null)); }}>
            <T style={{ color: colors.accent }}>{r.name}</T>
          </Pressable>
        ))}
        {settings.manualLocation && <Pressable onPress={() => updateSettings({ manualLocation: undefined })}><T sub size={12}>Clear saved city ({settings.manualLocation.name})</T></Pressable>}
      </Glass>
    </Screen>
  );
}
