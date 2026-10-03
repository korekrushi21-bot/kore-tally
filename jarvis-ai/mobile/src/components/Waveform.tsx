import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';
import type { AssistantState } from '../types';
import { useAssistant } from '../hooks/AssistantContext';

const N = 21;

/** Mic-reactive while listening; synthetic motion while speaking (TTS exposes no audio levels). */
export function Waveform({ state, level }: { state: AssistantState; level: number }) {
  const { colors, settings } = useAssistant();
  const bars = useRef([...Array(N)].map(() => new Animated.Value(0.15))).current;

  useEffect(() => {
    if (state === 'listening') {
      bars.forEach((b, i) => {
        const shape = 1 - Math.abs(i - N / 2) / (N / 2);
        Animated.timing(b, { toValue: 0.12 + level * shape * (0.6 + Math.random() * 0.4), duration: 90, useNativeDriver: true }).start();
      });
      return;
    }
    if (state === 'speaking' && settings.animation !== 'low') {
      const loops = bars.map((b, i) => {
        const l = Animated.loop(Animated.sequence([
          Animated.timing(b, { toValue: 0.25 + Math.random() * 0.75, duration: 220 + (i % 5) * 60, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(b, { toValue: 0.12, duration: 220 + (i % 4) * 70, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ]));
        l.start();
        return l;
      });
      return () => loops.forEach((l) => l.stop());
    }
    bars.forEach((b) => Animated.timing(b, { toValue: 0.1, duration: 300, useNativeDriver: true }).start());
  }, [state, level, bars, settings.animation]);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 56, gap: 4 }}>
      {bars.map((b, i) => (
        <Animated.View key={i} style={{ width: 4, height: 56, borderRadius: 2, backgroundColor: i % 2 ? colors.accent : colors.accent2, transform: [{ scaleY: b }] }} />
      ))}
    </View>
  );
}
