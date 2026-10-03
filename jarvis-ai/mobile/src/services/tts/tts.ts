import * as Speech from 'expo-speech';

export interface VoiceInfo { identifier: string; name: string; language: string }

export async function listVoices(langPrefix?: string): Promise<VoiceInfo[]> {
  const v = await Speech.getAvailableVoicesAsync();
  return v
    .filter((x) => !langPrefix || x.language.toLowerCase().startsWith(langPrefix))
    .map((x) => ({ identifier: x.identifier, name: x.name, language: x.language }));
}

export function speak(text: string, o: { locale: string; voice?: string; rate: number; volume: number; onStart?: () => void; onDone: () => void }) {
  Speech.stop();
  // strip markdown & urls so they are not read aloud
  const clean = text.replace(/https?:\/\/\S+/g, '').replace(/[*_`#>]/g, '').trim();
  if (!clean) { o.onDone(); return; }
  Speech.speak(clean, {
    language: o.locale, voice: o.voice, rate: o.rate, volume: o.volume,
    onStart: o.onStart, onDone: o.onDone, onStopped: o.onDone, onError: o.onDone,
  });
}
export const stopSpeaking = () => Speech.stop();
