import React, { useEffect, useRef, useState } from 'react';
import { Image, View } from 'react-native';
import { Btn, Glass, Input, Screen, T } from '../components/ui';
import { useAssistant } from '../hooks/AssistantContext';
import { pickImage, scan } from '../services/agriculture';
import { AppError, friendly } from '../utils';
import { AGRI_DISCLAIMER } from '../config';
import type { AgriResult } from '../types';

export default function AgricultureScreen({ navigation, route }: any) {
  const { settings, colors, speakText } = useAssistant();
  const [uri, setUri] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AgriResult | null>(null);
  const [err, setErr] = useState('');
  const ctrl = useRef<AbortController | null>(null);

  const take = async (src: 'camera' | 'library') => {
    setErr(''); setRes(null);
    try { const u = await pickImage(src); if (u) setUri(u); } catch (e) { setErr(friendly(e)); }
  };
  useEffect(() => { if (route?.params?.mode === 'camera') void take('camera'); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    if (!uri) return;
    setBusy(true); setErr(''); setRes(null);
    ctrl.current = new AbortController();
    try { setRes(await scan(uri, settings.language === 'auto' ? 'mr' : settings.language, note || undefined, ctrl.current.signal)); }
    catch (e) { if (!(e instanceof AppError && e.code === 'cancelled')) setErr(friendly(e)); }
    setBusy(false);
  };

  const List = ({ title, items }: { title: string; items: string[] }) => items?.length ? (
    <View style={{ marginTop: 8 }}><T bold>{title}</T>{items.map((x, i) => <T key={i}>• {x}</T>)}</View>
  ) : null;

  return (
    <Screen title="🌾 शेती Assistant" onBack={() => navigation.goBack()}>
      <Glass style={{ gap: 8 }}>
        <T sub size={13}>Needs a vision model (local: ollama pull gemma3:4b). Small local models are less accurate than cloud ones, so treat results as hints.</T>
        <T sub size={13}>Crop · disease · pest · weed · deficiency identification from a photo. Photos are compressed, sent securely to the AI vision model, and not stored by the app.</T>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Btn label="📷 Take photo" onPress={() => take('camera')} style={{ flex: 1 }} />
          <Btn label="🖼 Choose" kind="ghost" onPress={() => take('library')} style={{ flex: 1 }} />
        </View>
      </Glass>
      {uri && <Image source={{ uri }} style={{ width: '100%', height: 260, borderRadius: 16 }} resizeMode="cover" />}
      {uri && <Input value={note} onChangeText={setNote} placeholder="Optional: crop name, growth stage, what you noticed" />}
      {uri && (busy ? <Btn label="Cancel analysis" kind="danger" onPress={() => ctrl.current?.abort()} /> : <Btn label="Analyse" onPress={run} />)}
      {busy && <T sub>Analysing…</T>}
      {!!err && <T style={{ color: colors.err }}>{err}</T>}
      {res && (
        <Glass>
          <T size={18} bold>{res.finding}</T>
          <T sub>{res.kind.toUpperCase()}{res.cropGuess ? ` · ${res.cropGuess}` : ''}</T>
          <T style={{ color: colors.warn }}>Confidence: {res.confidence} (~{res.confidencePercent}% — an estimate, not a guarantee)</T>
          <List title="Symptoms" items={res.symptoms} />
          <List title="Possible causes" items={res.possibleCauses} />
          <List title="Recommended next steps" items={res.nextSteps} />
          {!!res.treatmentNotes && <View style={{ marginTop: 8 }}><T bold>Treatment / spray notes</T><T>{res.treatmentNotes}</T></View>}
          <T sub size={12} style={{ marginTop: 10 }}>{AGRI_DISCLAIMER}</T>
          <Btn kind="ghost" label="🔊 Read aloud" style={{ marginTop: 8 }} onPress={() => speakText(`${res.finding}. ${res.nextSteps.join('. ')}`)} />
        </Glass>
      )}
      <Glass onPress={() => navigation.navigate('Weather')}><T>🌦 Weather-based spray/disease alerts → check forecast first</T></Glass>
      <Glass onPress={() => navigation.navigate('Search')}><T>📈 Market information (mandi prices) → Web Search</T></Glass>
    </Screen>
  );
}
