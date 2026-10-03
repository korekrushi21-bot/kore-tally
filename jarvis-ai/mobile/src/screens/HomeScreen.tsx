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
  const { colors, settings, state, level, partial, pending, setPending, startVoice, cancel, send, messages, error, clearError, wakeActive } = useAssistant();
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
          {wakeActive && <T sub size={11}>Wake word active (app open only): “{settings.wakeWord}”</T>}
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
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); if (state === 'idle') void startVoice(); else if (state === 'listening') void startVoice(); else cancel(); }}
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
