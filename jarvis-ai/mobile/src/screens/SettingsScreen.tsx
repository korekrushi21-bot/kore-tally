import React, { useEffect, useState } from 'react';
import { Pressable, Switch, View } from 'react-native';
import { ask, openAppSettings, shareText, isAndroid, isWeb } from '../utils/platform';
import Slider from './Slider';
import { Btn, Glass, Input, Row, Screen, T } from '../components/ui';
import { useAssistant } from '../hooks/AssistantContext';
import { LANGS } from '../config';
import { backendStatus } from '../services/ai/api';
import { listVoices, speak, type VoiceInfo } from '../services/tts/tts';
import { getAccessCode, setAccessCode, setToken, wipeSecure } from '../storage/secure';
import * as store from '../storage/store';
import { speechLocale } from '../utils';
import type { Settings } from '../types';

const Seg = <K extends string>({ value, options, onChange }: { value: K; options: { v: K; l: string }[]; onChange: (v: K) => void }) => {
  const { colors } = useAssistant();
  return (
    <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
      {options.map((o) => (
        <Pressable key={o.v} onPress={() => onChange(o.v)} style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 16, backgroundColor: value === o.v ? colors.accent : colors.panel }}>
          <T style={{ color: value === o.v ? '#04121c' : colors.text }} size={13}>{o.l}</T>
        </Pressable>
      ))}
    </View>
  );
};

export default function SettingsScreen({ navigation }: any) {
  const { settings: s, updateSettings: up, clearHistory, refreshMemories, colors } = useAssistant();
  const [status, setStatus] = useState('checking…');
  const [code, setCode] = useState('');
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [url, setUrl] = useState(s.backendUrl);

  const check = async () => { setStatus('checking…'); setStatus(({ online: '🟢 Connected', offline: '🔴 No internet', unconfigured: '⚪ Not configured', auth: '🟠 Access code rejected', down: '🔴 Backend unavailable' } as const)[await backendStatus()]); };
  useEffect(() => { void check(); void getAccessCode().then((c) => setCode(c ?? '')); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void listVoices(s.language === 'auto' ? undefined : s.language).then(setVoices).catch(() => setVoices([])); }, [s.language]);

  const set = <K extends keyof Settings>(k: K) => (v: Settings[K]) => up({ [k]: v } as Partial<Settings>);

  return (
    <Screen title="Settings" onBack={() => navigation.goBack()}>
      <T bold>Assistant</T>
      <Glass>
        <T sub size={12}>Assistant name</T>
        <Input value={s.assistantName} onChangeText={set('assistantName')} />
        <T sub size={12} style={{ marginTop: 10 }}>Language</T>
        <Seg value={s.language} options={LANGS.map((l) => ({ v: l.code, l: l.label }))} onChange={set('language')} />
        <T sub size={11}>Auto: replies match the language you use. For voice input needs a fixed recognizer language, so pick one for best accuracy.</T>
        <T sub size={12} style={{ marginTop: 10 }}>Voice ({voices.length} available)</T>
        <View style={{ maxHeight: 130 }}>
          <Seg value={s.voiceId ?? ''} options={[{ v: '', l: 'Default' }, ...voices.slice(0, 12).map((v) => ({ v: v.identifier, l: v.name }))]} onChange={(v) => up({ voiceId: v || undefined })} />
        </View>
        <T sub size={12} style={{ marginTop: 10 }}>Speaking speed {s.speechRate.toFixed(1)}×</T>
        <Slider value={s.speechRate} min={0.5} max={1.5} step={0.1} onChange={set('speechRate')} />
        <T sub size={12}>Volume {Math.round(s.volume * 100)}%</T>
        <Slider value={s.volume} min={0} max={1} step={0.1} onChange={set('volume')} />
        <Row label="Speak replies aloud"><Switch value={s.autoSpeak} onValueChange={set('autoSpeak')} /></Row>
        <Btn kind="ghost" label="Test voice" onPress={() => speak(`Hello. I am ${s.assistantName}.`, { locale: speechLocale(s.language === 'auto' ? 'en' : (s.language as 'mr' | 'hi' | 'en')), voice: s.voiceId, rate: s.speechRate, volume: s.volume, onDone: () => {} })} />
        <Row label="Wake word (app open only)" sub="Phones (iOS and Android) do not allow third-party apps to listen continuously in the background. Works only while the app/tab is open.">
          <Switch value={s.wakeWordEnabled} onValueChange={set('wakeWordEnabled')} />
        </Row>
        <Input value={s.wakeWord} onChangeText={set('wakeWord')} placeholder="Hey JARVIS" />
        <T sub size={11}>Hands-free alternatives: Open jarvisai://listen from a launcher/automation shortcut (Android: Tasker/Routines or a home-screen shortcut; desktop: pin the web app). Widget: Requires integration (native).</T>
      </Glass>

      <T bold>AI</T>
      <Glass style={{ gap: 6 }}>
        <Seg value={s.provider} options={[{ v: 'openai', l: 'OpenAI' }, { v: 'anthropic', l: 'Anthropic' }, { v: 'custom', l: 'Custom' }]} onChange={set('provider')} />
        <Input value={s.model} onChangeText={set('model')} placeholder="Model (blank = server default)" autoCapitalize="none" />
        <Input value={url} onChangeText={setUrl} placeholder="https://your-backend" autoCapitalize="none" keyboardType="url" />
        <Input value={code} onChangeText={setCode} placeholder="Access code" secureTextEntry autoCapitalize="none" />
        <Btn label="Save & test connection" onPress={async () => { await up({ backendUrl: url }); await setAccessCode(code || null); await setToken(null); await check(); }} />
        <T>Status: {status}</T>
        <T sub size={11}>API keys live only on your backend. The access code is kept in the Android Keystore (desktop web: browser storage).</T>
      </Glass>

      <T bold>Privacy</T>
      <Glass>
        <Row label="Microphone, Camera, Location, Notifications" sub={isWeb ? 'Asked by the browser when first needed. Change via the lock icon in the address bar.' : 'Asked only when first needed. Change in system Settings.'} onPress={() => openAppSettings()}><T style={{ color: colors.accent }}>Open</T></Row>
        <Row label="Memory controls" onPress={() => navigation.navigate('Memory')}><T sub>›</T></Row>
      </Glass>

      <T bold>Appearance</T>
      <Glass>
        <Seg value={s.theme} options={[{ v: 'dark', l: 'Dark' }, { v: 'light', l: 'Light' }]} onChange={set('theme')} />
        <T sub size={12} style={{ marginTop: 8 }}>Animation intensity</T>
        <Seg value={s.animation} options={[{ v: 'low', l: 'Low (saves battery)' }, { v: 'normal', l: 'Normal' }, { v: 'high', l: 'High' }]} onChange={set('animation')} />
        <T sub size={12} style={{ marginTop: 8 }}>UI scale {s.uiScale.toFixed(1)}×</T>
        <Slider value={s.uiScale} min={0.9} max={1.3} step={0.1} onChange={set('uiScale')} />
      </Glass>

      <T bold>Data</T>
      <Glass style={{ gap: 8 }}>
        <Row label="Conversation history" onPress={() => navigation.navigate('History')}><T sub>›</T></Row>
        <Btn kind="ghost" label="Export my data" onPress={async () => shareText(await store.exportAll())} />
        <Btn kind="danger" label="Delete conversations" onPress={() => ask('Delete all conversations?', undefined, 'Delete', () => void clearHistory())} />
        <Btn kind="danger" label="Delete ALL data" onPress={() => ask('Delete ALL data?', 'Conversations, memories, notes, tasks, settings and saved credentials will be erased from this device.', 'Delete everything', async () => { await store.deleteAllData(); await wipeSecure(); await clearHistory(); await refreshMemories(); await up({ ...(await store.loadSettings()), onboarded: false }); navigation.navigate('Onboarding'); })} />
      </Glass>
    </Screen>
  );
}
