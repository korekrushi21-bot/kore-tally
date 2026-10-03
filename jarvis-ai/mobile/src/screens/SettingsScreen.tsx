import React, { useEffect, useState } from 'react';
import { Linking, Pressable, Switch, View } from 'react-native';
import { ask, openAppSettings, shareText, isAndroid, isWeb } from '../utils/platform';
import Slider from './Slider';
import { Btn, Glass, Input, Row, Screen, T } from '../components/ui';
import { useAssistant } from '../hooks/AssistantContext';
import { LANGS } from '../config';
import { aiStatus, backendStatus, type AiStatus } from '../services/ai/api';
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
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [code, setCode] = useState('');
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [url, setUrl] = useState(s.backendUrl);

  const check = async () => {
    setTesting(true); setStatus('checking…');
    const b = await backendStatus();
    setStatus(({ online: '🟢 reachable', offline: '🔴 no internet', unconfigured: '⚪ not configured', auth: '🟠 access code rejected', down: '🔴 unavailable' } as const)[b]);
    setAi(b === 'online' ? await aiStatus().catch(() => null) : null);
    setTesting(false);
  };
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
        <T sub size={11}>Auto: replies match the language you use. For voice input a fixed language works best, so pick one for better accuracy.</T>
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
        <Row label="JARVIS always on (hands-free)" sub="While the app is open, listen for the wake phrase and talk without pressing anything. Phones/browsers do not allow listening when the app is closed or hidden.">
          <Switch value={s.alwaysOn} onValueChange={set('alwaysOn')} />
        </Row>
        <Row label="Send automatically when I stop talking"><Switch value={s.voiceAutoSend} onValueChange={set('voiceAutoSend')} /></Row>
        <Row label="Keep listening for a follow-up after JARVIS answers"><Switch value={s.followUp} onValueChange={set('followUp')} /></Row>
        <T sub size={12}>Wake phrase</T>
        <Input value={s.wakeWord} onChangeText={set('wakeWord')} placeholder="Hey JARVIS" />
        <T sub size={11}>Say “Hey JARVIS” (or just “JARVIS” / “जार्विस”), then your question. Voice recognition for the wake phrase works best with the language set to English or मराठी in Settings. Other launchers: open jarvisai://listen from a shortcut or routine. Widget: Requires integration (native).</T>
      </Glass>

      <T bold>AI</T>
      <Glass style={{ gap: 8 }}>
        <T sub size={12}>AI provider</T>
        <Seg value={s.provider === 'ollama' ? 'ollama' : 'cloud'} options={[{ v: 'ollama', l: 'Local AI — Ollama (free)' }, { v: 'cloud', l: 'Cloud AI — Optional' }]}
          onChange={(v) => up({ provider: v === 'ollama' ? 'ollama' : 'openai', model: '' })} />
        {s.provider !== 'ollama' && (
          <>
            <Seg value={s.provider} options={[{ v: 'openai', l: 'OpenAI' }, { v: 'anthropic', l: 'Anthropic' }, { v: 'custom', l: 'Custom (OpenAI-compatible)' }]} onChange={set('provider')} />
            <T sub size={11}>Optional Paid Service: needs an API key configured on the backend (some vendors offer free tiers with limits). Not required.</T>
            <Input value={s.model} onChangeText={set('model')} placeholder="Model id (blank = backend default)" autoCapitalize="none" />
          </>
        )}
        <Row label="Backend">{null}</Row>
        <Input value={url} onChangeText={setUrl} placeholder="http://localhost:8787 or https://your-server" autoCapitalize="none" keyboardType="url" />
        <Input value={code} onChangeText={setCode} placeholder="Access code" secureTextEntry autoCapitalize="none" />
        <Btn kind="ghost" label="Save backend" onPress={async () => { await up({ backendUrl: url }); await setAccessCode(code || null); await setToken(null); await check(); }} />
        <T bold>{ai?.connected ? '● Connected' : '○ Not connected'}{ai?.selected ? `  (${ai.selected.provider}: ${ai.selected.model}${ai.selected.fallback ? ', cloud fallback' : ''})` : ''}</T>
        <T sub size={12}>Backend: {status}</T>
        <Btn label="Test AI connection" busy={testing} onPress={check} />
        {ai && s.provider === 'ollama' && (
          <>
            <T sub size={12} style={{ marginTop: 6 }}>Installed models{ai.ollama.version ? ` (Ollama ${ai.ollama.version})` : ''}</T>
            {ai.ollama.models.length === 0 ? <T sub size={13}>None found.</T> : (
              <Seg value={s.model || ''} options={[{ v: '', l: 'Auto (lightweight)' }, ...ai.ollama.models.map((m) => ({ v: m.name, l: `${m.name} · ${m.sizeGB} GB${m.vision ? ' · vision' : ''}` }))]} onChange={(v) => up({ model: v })} />
            )}
            {ai.ollama.hint && (
              <View style={{ gap: 6, marginTop: 6 }}>
                <T bold>{ai.ollama.hint === 'not_installed' ? 'Local AI is not installed.' : ai.ollama.hint === 'not_running' ? 'Ollama is installed but not running.' : ai.ollama.hint === 'no_model' ? 'No AI model downloaded yet.' : 'Cannot reach Ollama from the backend.'}</T>
                <T sub size={13}>{ai.ollama.hint === 'not_installed' ? '1. Install Ollama from ollama.com/download\n2. In a terminal run: ollama pull qwen2.5:3b\n3. Come back and press “Test AI connection”.'
                  : ai.ollama.hint === 'not_running' ? 'Start the Ollama app from the Start menu (or run: ollama serve), then press “Test AI connection”.'
                  : ai.ollama.hint === 'no_model' ? 'In a terminal run: ollama pull qwen2.5:3b   (about 2 GB, runs on an ordinary PC), then press “Test AI connection”.'
                  : 'Check OLLAMA_BASE_URL in backend/.env and that the backend and Ollama run on the same network.'}</T>
                <Btn kind="ghost" label="Install / setup instructions" onPress={() => Linking.openURL('https://ollama.com/download')} />
              </View>
            )}
            <T sub size={11}>Voice uses free on-device/system speech. Web search uses free sources (news RSS, Wikipedia); real web search needs an optional SearXNG/Tavily setup on the backend.</T>
          </>
        )}
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
