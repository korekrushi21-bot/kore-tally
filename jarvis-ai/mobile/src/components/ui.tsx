import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAssistant } from '../hooks/AssistantContext';
import { useOnline } from '../hooks/useNetwork';

export function Screen({ title, children, scroll = true, right, onBack }: { title?: string; children: React.ReactNode; scroll?: boolean; right?: React.ReactNode; onBack?: () => void }) {
  const { colors, settings } = useAssistant();
  const online = useOnline();
  const body = scroll
    ? <ScrollView contentContainerStyle={{ padding: 16 * settings.uiScale, gap: 12, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">{children}</ScrollView>
    : <View style={{ flex: 1 }}>{children}</View>;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top', 'left', 'right']}>
      {!online && <View style={{ backgroundColor: colors.err, padding: 6 }}><Text style={{ color: '#fff', textAlign: 'center', fontSize: 12 }}>Internet connection unavailable.</Text></View>}
      {title !== undefined && (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10 }}>
          {onBack && <Pressable onPress={onBack} hitSlop={12} style={{ marginRight: 12 }}><Text style={{ color: colors.accent, fontSize: 22 }}>‹</Text></Pressable>}
          <Text style={{ color: colors.text, fontSize: 22 * settings.uiScale, fontWeight: '700', flex: 1 }}>{title}</Text>
          {right}
        </View>
      )}
      {body}
    </SafeAreaView>
  );
}

/** Glassmorphism panel. */
export function Glass({ children, style, onPress }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void }) {
  const { colors, settings } = useAssistant();
  const inner = (
    <BlurView intensity={30} tint={settings.theme} style={[{ padding: 14, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.panel, overflow: 'hidden' }, style]}>
      {children}
    </BlurView>
  );
  return onPress ? <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>{inner}</Pressable> : inner;
}

export function T({ children, sub, bold, size = 15, style }: { children: React.ReactNode; sub?: boolean; bold?: boolean; size?: number; style?: StyleProp<any> }) {
  const { colors, settings } = useAssistant();
  return <Text style={[{ color: sub ? colors.sub : colors.text, fontSize: size * settings.uiScale, fontWeight: bold ? '700' : '400' }, style]}>{children}</Text>;
}

export function Btn({ label, onPress, kind = 'primary', busy, disabled, style }: { label: string; onPress: () => void; kind?: 'primary' | 'ghost' | 'danger'; busy?: boolean; disabled?: boolean; style?: StyleProp<ViewStyle> }) {
  const { colors } = useAssistant();
  const bg = kind === 'primary' ? colors.accent : kind === 'danger' ? colors.err : 'transparent';
  return (
    <Pressable onPress={onPress} disabled={disabled || busy} style={({ pressed }) => [{ paddingVertical: 12, paddingHorizontal: 18, borderRadius: 14, backgroundColor: bg, borderWidth: kind === 'ghost' ? 1 : 0, borderColor: colors.border, opacity: disabled ? 0.4 : pressed ? 0.75 : 1, alignItems: 'center' }, style]}>
      {busy ? <ActivityIndicator color="#fff" /> : <Text style={{ color: kind === 'ghost' ? colors.text : '#04121c', fontWeight: '700' }}>{label}</Text>}
    </Pressable>
  );
}

export function Input(p: TextInputProps) {
  const { colors } = useAssistant();
  return <TextInput placeholderTextColor={colors.sub} {...p} style={[{ color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, fontSize: 16, backgroundColor: colors.panel }, p.style]} />;
}

export function Row({ label, children, onPress, sub }: { label: string; children?: React.ReactNode; onPress?: () => void; sub?: string }) {
  const { colors } = useAssistant();
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}>
      <View style={{ flex: 1 }}><T>{label}</T>{sub ? <T sub size={12}>{sub}</T> : null}</View>
      {children}
    </Pressable>
  );
}
