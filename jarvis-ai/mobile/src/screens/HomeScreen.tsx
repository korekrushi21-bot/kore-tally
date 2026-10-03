import React, { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { AICore } from '../components/AICore';
import { Waveform } from '../components/Waveform';
import { Btn, Glass, Input, Screen, T } from '../components/ui';
import { useAssistant } from '../hooks/AssistantContext';
import { MessageBubble } from '../components/MessageBubble';

const STATUS = { idle: 'Ready', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…', processing: 'Processing…' } as const;

export default function HomeScreen({ navigation }: any) {
  const { colors, settings, updateSettings, state, level, partial, pending, setPending, startVoice, cancel, send, messages, error, clearError, wakeActive, wakeHeard, wakeListening, retryWake } = useAssistant();
  const [text, setText] = useState('');
  const [typing, setTyping] = useState(false);
  const [editing, setEditing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Show the recognized text first; auto-send after 3s unless the user edits or cancels.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (pending && !editing) timer.current = setTimeout(() => void send(pending), 3000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [pending, editing, send]);

  const last = messages.filter((m) => m.role === 'assistant').slice(-1)[0];
  const lastUser = messages.filter((m) => m.role === 'user').slice(-1)[0];
  const submit = () => { if (text.trim()) { void send(text); setText(''); setTyping(false); } };

  return (
    <Screen
      scroll={false}
      title={settings.assistantName}
      right={
        <View style={{ flexDirection: 'row', gap: 18 }}>
          <Pressable onPress={() => navigation.navigate('History')}><Text style={{ fontSize: 22 }}>🕘</Text></Pressable>
          <Pressable onPress={() => navigation.navigate('Command')}><Text style={{ fontSize: 22 }}>🧭</Text></Pressable>
          <Pressable onPress={() => navigation.navigate('Settings')}><Text style={{ fontSize: 22 }}>⚙️</Text></Pressable>
        </View>
      }
    >
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'space-between', paddingBottom: 12 }}>
        <View style={{ alignItems: 'center', marginTop: 4 }}>
          <AICore state={state} level={level} size={220} />
          <Text style={{ color: colors.accent, fontSize: 18, letterSpacing: 2, marginTop: -30 }}>{STATUS[state]}</Text>
          <Pressable onPress={() => { if (settings.alwaysOn && (!wakeActive || !wakeListening)) retryWake(); else updateSettings({ alwaysOn: !settings.alwaysOn }); }} accessibilityLabel="Toggle always on">
            <T size={12} style={{ color: wakeActive ? colors.ok : colors.sub }}>{wakeActive && wakeListening ? `● ${settings.assistantName} ON — say “${settings.wakeWord}”` : settings.alwaysOn ? '🎙 Tap here to start the microphone (allow it when asked)' : '○ Always-on is off (tap to turn on)'}</T>
          </Pressable>
          {wakeActive && state === 'idle' && <T sub size={10}>{wakeListening ? '👂 listening' : '… microphone not started yet'}{wakeHeard ? ` · heard: “${wakeHeard.slice(-60)}”` : ''}</T>}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
            {([['auto', 'Auto'], ['mr', 'मराठी'], ['hi', 'हिंदी'], ['en', 'English']] as const).map(([code, label]) => (
              <Pressable key={code} onPress={() => updateSettings({ language: code })} accessibilityLabel={`Language ${label}`}
                style={{ paddingVertical: 4, paddingHorizontal: 12, borderRadius: 14, backgroundColor: settings.language === code ? colors.accent : colors.panel }}>
                <T size={12} style={{ color: settings.language === code ? '#04121c' : colors.text }}>{label}</T>
              </Pressable>
            ))}
          </View>
          {settings.language === 'auto' && <T sub size={10}>Auto listens in English. For मराठी/हिंदी speech choose that language.</T>}
          {(settings.language === 'mr' || settings.language === 'hi') && <T sub size={10}>Say “Hey JARVIS” (English), pause, then ask in {settings.language === 'mr' ? 'मराठी' : 'हिंदी'}.</T>}
          <Waveform state={state} level={level} />
        </View>

        <View style={{ width: '100%', paddingHorizontal: 16, gap: 10 }}>
          {state === 'listening' && !!partial && <Glass><T>{partial}</T></Glass>}
          {pending && (
            <Glass>
              <T sub size={12}>Recognized — sending in 3 s</T>
              {editing
                ? <Input value={pending} onChangeText={setPending} multiline autoFocus />
                : <T size={17}>{pending}</T>}
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                <Btn label="Send" onPress={() => { setEditing(false); void send(pending); }} style={{ flex: 1 }} />
                <Btn label={editing ? 'Done' : 'Edit'} kind="ghost" onPress={() => setEditing((e) => !e)} style={{ flex: 1 }} />
                <Btn label="Cancel" kind="ghost" onPress={() => { setEditing(false); setPending(null); }} style={{ flex: 1 }} />
              </View>
            </Glass>
          )}
          {error && !last?.error && <Pressable onPress={clearError}><Glass style={{ borderColor: colors.err }}><T style={{ color: colors.err }}>{error}</T></Glass></Pressable>}
          {!pending && lastUser && state !== 'listening' && <T sub size={12} style={{ textAlign: 'center' }}>🎙 {lastUser.text}</T>}
          {!pending && last && state !== 'listening' && (
            <Pressable onPress={() => navigation.navigate('Chat')} style={{ maxHeight: 220 }}>
              <MessageBubble m={last} isLast={false} />
            </Pressable>
          )}

          {typing ? (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Input value={text} onChangeText={setText} placeholder="Type a message" style={{ flex: 1 }} autoFocus onSubmitEditing={submit} returnKeyType="send" />
              <Btn label="Send" onPress={submit} />
            </View>
          ) : null}

          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' }}>
            <Pressable onPress={() => setTyping((t) => !t)} accessibilityLabel="Type"><Text style={{ fontSize: 28 }}>⌨️</Text></Pressable>
            <Pressable
              accessibilityLabel="Microphone"
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); if (state === 'idle' || state === 'listening') void startVoice(); else cancel(); }}
              style={{ width: 78, height: 78, borderRadius: 39, backgroundColor: state === 'listening' ? colors.ok : colors.accent, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={{ fontSize: 32 }}>{state === 'idle' || state === 'listening' ? '🎙' : '■'}</Text>
            </Pressable>
            <Pressable onPress={() => navigation.navigate('Chat')} accessibilityLabel="Chat"><Text style={{ fontSize: 28 }}>💬</Text></Pressable>
          </View>
        </View>
      </View>
    </Screen>
  );
}
