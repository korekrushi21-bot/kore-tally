import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { AppError } from '../../utils';

export interface ListenHandlers {
  onPartial: (t: string) => void;
  onFinal: (t: string) => void;
  onLevel?: (v: number) => void; // 0..1 for the waveform
  onEnd: () => void;
  onError: (e: AppError) => void;
}

/**
 * Speech-to-text via expo-speech-recognition (Android recognizer; Web Speech API on desktop Chrome/Edge).
 * Requires a development build (not Expo Go). locale: mr-IN | hi-IN | en-IN.
 */
let subs: { remove(): void }[] = [];
function clear() { subs.forEach((s) => s.remove()); subs = []; }

export async function ensurePermission() {
  if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) throw new AppError('stt_unavailable');
  const p = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
  if (!p.granted) throw new AppError('mic');
}

export async function startListening(locale: string, h: ListenHandlers, opts: { continuous?: boolean; onDevice?: boolean } = {}) {
  await ensurePermission();
  clear();
  subs = [
    ExpoSpeechRecognitionModule.addListener('result', (e) => {
      const t = e.results?.[0]?.transcript ?? '';
      if (e.isFinal) h.onFinal(t); else h.onPartial(t);
    }),
    ExpoSpeechRecognitionModule.addListener('volumechange', (e) => h.onLevel?.(Math.max(0, Math.min(1, (e.value + 2) / 12)))),
    ExpoSpeechRecognitionModule.addListener('error', (e) => {
      if (e.error === 'aborted' || e.error === 'no-speech') { h.onEnd(); return; }
      if (__DEV__) console.warn('speech error:', e.error, e.message);
      const c = e.error as string;
      h.onError(new AppError(
        c === 'not-allowed' || c === 'service-not-allowed' || c === 'audio-capture' ? 'mic'
          : c === 'network' ? 'stt_network'
          : c === 'language-not-supported' ? 'stt_lang'
          : c === 'service-not-allowed' ? 'stt_unavailable' : 'failed'));
    }),
    ExpoSpeechRecognitionModule.addListener('end', () => h.onEnd()),
  ];
  ExpoSpeechRecognitionModule.start({
    lang: locale,
    interimResults: true,
    continuous: !!opts.continuous,
    requiresOnDeviceRecognition: !!opts.onDevice && ExpoSpeechRecognitionModule.supportsOnDeviceRecognition(),
    volumeChangeEventOptions: { enabled: true, intervalMillis: 80 },
  });
}

export function stopListening() { try { ExpoSpeechRecognitionModule.stop(); } catch { /* ignore */ } }
export function abortListening() { try { ExpoSpeechRecognitionModule.abort(); } catch { /* ignore */ } clear(); }
