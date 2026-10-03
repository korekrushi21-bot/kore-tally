import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';
import type { AssistantState } from '../types';
import { useAssistant } from '../hooks/AssistantContext';

const STATE_COLOR = { idle: 'accent', listening: 'ok', thinking: 'accent2', speaking: 'accent', processing: 'warn' } as const;

/** Original animated "core": breathing orb, pulse rings, orbiting particles. All transforms use the native driver. */
export function AICore({ state, level, size = 240 }: { state: AssistantState; level: number; size?: number }) {
  const { colors, settings } = useAssistant();
  const speed = settings.animation === 'low' ? 0.5 : settings.animation === 'high' ? 1.4 : 1;
  const breathe = useRef(new Animated.Value(0)).current;
  const spin = useRef(new Animated.Value(0)).current;
  const ring = useRef(new Animated.Value(0)).current;
  const lvl = useRef(new Animated.Value(0)).current;
  const color = colors[STATE_COLOR[state]];

  useEffect(() => {
    const dur = (state === 'speaking' ? 700 : state === 'listening' ? 1100 : 3200) / speed;
    const b = Animated.loop(Animated.sequence([
      Animated.timing(breathe, { toValue: 1, duration: dur, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(breathe, { toValue: 0, duration: dur, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    b.start();
    return () => b.stop();
  }, [state, speed, breathe]);

  useEffect(() => {
    spin.setValue(0);
    if (state !== 'thinking' && state !== 'processing') return;
    const s = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 2600 / speed, easing: Easing.linear, useNativeDriver: true }));
    s.start();
    return () => s.stop();
  }, [state, speed, spin]);

  useEffect(() => {
    ring.setValue(0);
    if (state !== 'listening' && state !== 'speaking') return;
    const r = Animated.loop(Animated.timing(ring, { toValue: 1, duration: 1600 / speed, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    r.start();
    return () => r.stop();
  }, [state, speed, ring]);

  useEffect(() => { Animated.timing(lvl, { toValue: level, duration: 90, useNativeDriver: true }).start(); }, [level, lvl]);

  const scale = Animated.add(breathe.interpolate({ inputRange: [0, 1], outputRange: [1, 1.05] }), state === 'listening' ? Animated.multiply(lvl, 0.25) : new Animated.Value(0));
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const rotateRev = spin.interpolate({ inputRange: [0, 1], outputRange: ['360deg', '0deg'] });
  const ringScale = ring.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1.35] });
  const ringOpacity = ring.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] });
  const ringBox = { width: size, height: size, borderRadius: size / 2 };
  const showSpin = state === 'thinking' || state === 'processing';

  return (
    <View style={{ width: size * 1.4, height: size * 1.4, alignItems: 'center', justifyContent: 'center' }}>
      {(state === 'listening' || state === 'speaking') && (
        <Animated.View style={[styles.abs, ringBox, { borderColor: color, borderWidth: 2, opacity: ringOpacity, transform: [{ scale: ringScale }] }]} />
      )}
      <Animated.View style={{ transform: [{ scale }] }}>
        <Svg width={size} height={size}>
          <Defs>
            <RadialGradient id="g" cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor={color} stopOpacity="0.95" />
              <Stop offset="0.55" stopColor={color} stopOpacity="0.28" />
              <Stop offset="1" stopColor={color} stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Circle cx={size / 2} cy={size / 2} r={size / 2} fill="url(#g)" />
          <Circle cx={size / 2} cy={size / 2} r={size * 0.33} stroke={color} strokeWidth={2} fill="none" opacity={0.9} />
          <Circle cx={size / 2} cy={size / 2} r={size * 0.2} fill={color} opacity={0.85} />
        </Svg>
      </Animated.View>
      {showSpin && (
        <>
          <Animated.View style={[styles.abs, ringBox, { borderColor: color, borderWidth: 2, borderStyle: 'dashed', transform: [{ rotate }] }]} />
          <Animated.View style={[styles.abs, { width: size * 0.78, height: size * 0.78, borderRadius: size, borderColor: colors.accent2, borderWidth: 2, borderStyle: 'dotted', transform: [{ rotate: rotateRev }] }]} />
          <Animated.View style={[styles.abs, { width: size * 1.1, height: size * 1.1, transform: [{ rotate }] }]}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color, alignSelf: 'center' }} />
          </Animated.View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({ abs: { position: 'absolute' } });
