import React from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { shareText } from '../utils/platform';
import * as Clipboard from 'expo-clipboard';
import { useAssistant } from '../hooks/AssistantContext';
import { Btn, T } from './ui';
import type { Message } from '../types';

const TOOL_ICON: Record<string, string> = { searchWeb: '🔎 Searching…', getWeather: '🌦️ Checking weather…', createReminder: '📅 Creating reminder…', makePhoneCall: '📞 Preparing call…', calculate: '🧮 Calculating…', getTime: '🕒 Checking time…', translate: '🌐 Translating…', getNews: '📰 Fetching news…', searchProducts: '🏪 Checking shop catalogue…' };

export function MessageBubble({ m, isLast }: { m: Message; isLast: boolean }) {
  const { colors, confirm, decline, speakText, stopSpeak, regenerate, state } = useAssistant();

  if (m.role === 'system') {
    return <Text style={{ color: colors.sub, textAlign: 'center', fontSize: 12, marginVertical: 4 }}>{m.text}</Text>;
  }
  const mine = m.role === 'user';
  return (
    <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '88%', marginVertical: 5 }}>
      {m.toolEvents?.map((t, i) => (
        <Text key={i} style={{ color: t.status === 'error' ? colors.err : colors.sub, fontSize: 12, marginBottom: 2 }}>
          {(TOOL_ICON[t.tool] ?? '⚙️ ' + t.tool).replace('…', '')} {t.status === 'done' ? '✓' : t.status === 'error' ? '✗' : '…'} {t.summary}
        </Text>
      ))}
      <View style={{ backgroundColor: mine ? colors.accent : colors.panel, borderRadius: 18, padding: 12, borderWidth: mine ? 0 : 1, borderColor: m.error ? colors.err : colors.border }}>
        <Text selectable style={{ color: mine ? '#04121c' : m.error ? colors.err : colors.text, fontSize: 16, lineHeight: 22 }}>{m.text}</Text>
        {m.sources?.length ? (
          <View style={{ marginTop: 8, gap: 4 }}>
            <T sub size={12}>Sources</T>
            {m.sources.map((s, i) => (
              <Pressable key={i} onPress={() => /^https:\/\//.test(s.url) && Linking.openURL(s.url)}>
                <Text numberOfLines={1} style={{ color: colors.accent, fontSize: 13 }}>{i + 1}. {s.title || s.url}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {m.actions?.map((a) => {
          const st = m.actionState?.[a.id] ?? 'pending';
          return (
            <View key={a.id} style={{ marginTop: 10, padding: 10, borderRadius: 12, borderWidth: 1, borderColor: colors.border }}>
              <T bold>{a.summary}</T>
              {st === 'pending' ? (
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                  <Btn label="Send / Confirm" onPress={() => confirm(m.id, a)} style={{ flex: 1 }} />
                  <Btn label="Cancel" kind="ghost" onPress={() => decline(m.id, a)} style={{ flex: 1 }} />
                </View>
              ) : <T sub size={13}>{st === 'done' ? '✅ Done' : st === 'cancelled' ? 'Cancelled' : '⚠️ Could not complete'}</T>}
            </View>
          );
        })}
      </View>
      {!mine && !m.error && (
        <View style={{ flexDirection: 'row', gap: 16, marginTop: 4, paddingLeft: 6 }}>
          <Pressable onPress={() => Clipboard.setStringAsync(m.text)}><T sub size={12}>Copy</T></Pressable>
          <Pressable onPress={() => shareText(m.text)}><T sub size={12}>Share</T></Pressable>
          <Pressable onPress={() => (state === 'speaking' ? stopSpeak() : speakText(m.text))}><T sub size={12}>{state === 'speaking' ? 'Stop' : 'Speak'}</T></Pressable>
          {isLast && <Pressable onPress={regenerate}><T sub size={12}>Regenerate</T></Pressable>}
        </View>
      )}
    </View>
  );
}
