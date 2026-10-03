import React, { useState } from 'react';
import { View } from 'react-native';
import { Btn, Glass, Input, Screen, T } from '../components/ui';
import { AICore } from '../components/AICore';
import { useAssistant } from '../hooks/AssistantContext';
import { APP_NAME, LANGS } from '../config';
import { abortListening, startListening } from '../services/speech/stt';
import { speak } from '../services/tts/tts';
import { friendly, speechLocale } from '../utils';
import type { Lang } from '../types';

export default function OnboardingScreen({ navigation }: any) {
  const { settings, updateSettings, state } = useAssistant();
  const [step, setStep] = useState(0);
  const [name, setName] = useState(settings.assistantName);
  const [heard, setHeard] = useState('');
  const [msg, setMsg] = useState('');
  const [listening, setListening] = useState(false);

  const finish = async () => { await updateSettings({ onboarded: true, assistantName: name.trim() || 'JARVIS' }); navigation.reset({ index: 0, routes: [{ name: 'Home' }] }); };

  const testMic = async () => {
    setMsg(''); setHeard(''); setListening(true);
    const lang = (settings.language === 'auto' ? 'en' : settings.language) as 'mr' | 'hi' | 'en';
    try {
      await startListening(speechLocale(lang), {
        onPartial: setHeard,
        onFinal: (t) => { setHeard(t); speak('Hello. I am ready.', { locale: 'en-IN', rate: 1, volume: 1, onDone: () => {} }); },
        onEnd: () => setListening(false),
        onError: (e) => { setMsg(friendly(e)); setListening(false); },
      });
    } catch (e) { setMsg(friendly(e)); setListening(false); }
  };

  const steps = [
    <View key="0" style={{ alignItems: 'center', gap: 16 }}>
      <AICore state="idle" level={0} size={200} />
      <T size={26} bold style={{ textAlign: 'center' }}>Welcome to your personal AI assistant.</T>
      <T sub style={{ textAlign: 'center' }}>{APP_NAME} — speak or type in मराठी, हिंदी or English.</T>
    </View>,
    <View key="1" style={{ gap: 12 }}>
      <T size={22} bold>Choose language</T>
      {LANGS.filter((l) => l.code !== 'auto').map((l) => (
        <Btn key={l.code} label={l.label} kind={settings.language === l.code ? 'primary' : 'ghost'} onPress={() => updateSettings({ language: l.code as Lang })} />
      ))}
      <Btn label="Auto-detect" kind={settings.language === 'auto' ? 'primary' : 'ghost'} onPress={() => updateSettings({ language: 'auto' })} />
    </View>,
    <View key="2" style={{ gap: 12 }}>
      <T size={22} bold>Name your assistant</T>
      <Input value={name} onChangeText={setName} placeholder="JARVIS" />
      <T sub size={12}>Default wake phrase: “Hey {name || 'JARVIS'}” (works only while the app is open — change it in Settings).</T>
    </View>,
    <View key="3" style={{ gap: 10 }}>
      <T size={22} bold>Permissions</T>
      <T sub>Nothing is requested now. Each permission is asked only when you first use the feature:</T>
      {[['🎙 Microphone + Speech Recognition', 'only while you tap the mic; never recorded in the background'],
        ['📷 Camera / Photos', 'to analyse crop photos you choose'],
        ['📍 Location', 'for local weather; used once, not stored'],
        ['🔔 Notifications', 'for reminders you create']].map(([a, b]) => (
        <Glass key={a}><T bold>{a}</T><T sub size={12}>{b}</T></Glass>
      ))}
    </View>,
    <View key="4" style={{ gap: 12, alignItems: 'center' }}>
      <T size={22} bold>Test the microphone</T>
      <T sub style={{ textAlign: 'center' }}>Tap, then say “Hello {name || 'JARVIS'}”.</T>
      <AICore state={listening ? 'listening' : 'idle'} level={listening ? 0.4 : 0} size={150} />
      {!!heard && <Glass><T>{heard}</T></Glass>}
      {!!msg && <T style={{ color: '#f87171' }}>{msg}</T>}
      <Btn label={listening ? 'Listening…' : '🎙 Test microphone'} onPress={() => { if (listening) abortListening(); else void testMic(); }} />
      <T sub size={12}>You can skip this and test later.</T>
    </View>,
  ];

  return (
    <Screen>
      <View style={{ minHeight: 480, justifyContent: 'center' }}>{steps[step]}</View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        {step > 0 && <Btn label="Back" kind="ghost" onPress={() => setStep(step - 1)} style={{ flex: 1 }} />}
        <Btn label={step === steps.length - 1 ? 'Start' : 'Next'} onPress={() => (step === steps.length - 1 ? void finish() : setStep(step + 1))} style={{ flex: 1 }} />
      </View>
      <T sub size={11} style={{ textAlign: 'center' }}>Step {step + 1} / {steps.length} · {state === 'idle' ? '' : state}</T>
    </Screen>
  );
}
