import Constants from 'expo-constants';
import type { Settings, Lang } from '../types';

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string>;

/** Change the app's default name in app.json -> expo.extra.appName (users can also rename it in Settings). */
export const APP_NAME = extra.appName || 'JARVIS AI';
export const DEFAULT_BACKEND_URL = extra.backendUrl || '';
export const SHOP_NAME = 'Kore Krushi Seva Kendra';

export const DEFAULT_SETTINGS: Settings = {
  assistantName: 'JARVIS',
  language: 'auto',
  speechRate: 1,
  volume: 1,
  autoSpeak: true,
  wakeWordEnabled: false,
  wakeWord: 'Hey JARVIS',
  provider: 'openai',
  model: '',
  theme: 'dark',
  animation: 'normal',
  uiScale: 1,
  backendUrl: DEFAULT_BACKEND_URL,
  onboarded: false,
};

export const LANGS: { code: Lang; label: string; speech: string }[] = [
  { code: 'auto', label: 'Auto', speech: 'en-IN' },
  { code: 'mr', label: 'मराठी', speech: 'mr-IN' },
  { code: 'hi', label: 'हिंदी', speech: 'hi-IN' },
  { code: 'en', label: 'English', speech: 'en-IN' },
];

export const AGRI_DISCLAIMER =
  'ही प्राथमिक AI ओळख आहे. प्रत्यक्ष शेतातील परिस्थिती आणि तज्ज्ञ सल्ल्याने निर्णय घ्या.';

export const palette = {
  dark: { bg: '#05070d', panel: 'rgba(255,255,255,0.06)', border: 'rgba(120,200,255,0.18)', text: '#e8f1ff', sub: '#8aa0bd', accent: '#38bdf8', accent2: '#a78bfa', ok: '#34d399', warn: '#fbbf24', err: '#f87171' },
  light: { bg: '#eef3fb', panel: 'rgba(255,255,255,0.75)', border: 'rgba(30,80,160,0.16)', text: '#0b1424', sub: '#566a87', accent: '#0284c7', accent2: '#7c3aed', ok: '#059669', warn: '#d97706', err: '#dc2626' },
};
export type Palette = typeof palette.dark;
