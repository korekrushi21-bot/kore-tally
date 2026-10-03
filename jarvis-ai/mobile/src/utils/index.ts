import type { Lang } from '../types';

export function detectLang(text: string): Exclude<Lang, 'auto'> {
  if (/[\u0900-\u097F]/.test(text)) {
    // Devanagari: Marathi vs Hindi heuristics on common function words
    if (/(आहे|आहेत|काय|मला|तुम्ही|सांग|कसं|कसे|करून|उद्या|आज्?च्?|नाही|होईल|पाहिजे|माझ्या|दे\b)/.test(text) && !/(है|हैं|क्या|मुझे|कीजिए|बताओ|कैसा|मेरा)/.test(text)) return 'mr';
    if (/(है|हैं|क्या|मुझे|बताओ|कैसा|मेरा|कल|आज)/.test(text)) return 'hi';
    return 'mr';
  }
  return 'en';
}

export const speechLocale = (l: Exclude<Lang, 'auto'>) => (l === 'mr' ? 'mr-IN' : l === 'hi' ? 'hi-IN' : 'en-IN');

/** Never show raw API errors; map to friendly text. */
export class AppError extends Error {
  constructor(public code: 'offline' | 'ai_down' | 'auth' | 'mic' | 'camera' | 'location' | 'cancelled' | 'unconfigured' | 'stt_network' | 'stt_lang' | 'stt_unavailable' | 'ai_unconfigured' | 'vision_unavailable' | 'failed', msg?: string) { super(msg ?? code); }
}
export function friendly(e: unknown): string {
  const code = e instanceof AppError ? e.code : 'failed';
  return ({
    offline: 'Internet connection unavailable.',
    ai_down: 'AI service is temporarily unavailable.',
    auth: 'Backend sign-in failed. Check the access code in Settings → AI.',
    mic: 'Microphone permission is disabled.',
    camera: 'Camera permission is disabled.',
    location: 'Location permission is unavailable.',
    cancelled: 'Cancelled.',
    unconfigured: 'Backend is not configured. Open Settings → AI and enter your backend URL and access code.',
    ai_unconfigured: 'Local AI is not ready. Open Settings → AI for setup steps.',
    vision_unavailable: 'Vision AI requires an external provider or a vision model (e.g. run: ollama pull gemma3:4b). See Settings → AI.',
    stt_network: 'Voice input needs an internet connection to the browser/Google speech service. Check your connection, or type instead.',
    stt_lang: 'This language is not supported for voice input here. Pick another language in Settings, or type instead.',
    stt_unavailable: 'Voice input is not available in this browser. Use Chrome or Edge, or type instead.',
    failed: 'Could not complete the requested action.',
  } as const)[code];
}
