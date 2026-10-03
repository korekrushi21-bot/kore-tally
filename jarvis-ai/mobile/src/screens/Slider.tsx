import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useAssistant } from '../hooks/AssistantContext';

/** Dependency-free stepper slider (− / track / +). */
export default function Slider({ value, min, max, step, onChange }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  const { colors } = useAssistant();
  const clamp = (v: number) => Math.round(Math.min(max, Math.max(min, v)) * 100) / 100;
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 6 }}>
      <Pressable onPress={() => onChange(clamp(value - step))} hitSlop={10}><Text style={{ color: colors.accent, fontSize: 24 }}>−</Text></Pressable>
      <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.panel }}>
        <View style={{ width: `${pct}%`, height: 6, borderRadius: 3, backgroundColor: colors.accent }} />
      </View>
      <Pressable onPress={() => onChange(clamp(value + step))} hitSlop={10}><Text style={{ color: colors.accent, fontSize: 24 }}>+</Text></Pressable>
    </View>
  );
}
