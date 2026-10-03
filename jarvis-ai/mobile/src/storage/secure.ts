import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const K = { token: 'jarvis.token', device: 'jarvis.deviceId', code: 'jarvis.accessCode' };

// Phones: iOS Keychain / Android Keystore (expo-secure-store).
// Desktop web: SecureStore is unavailable, so localStorage is used (less secure: readable by anything on this browser profile).
const web = Platform.OS === 'web';
const get = async (k: string) => (web ? globalThis.localStorage?.getItem(k) ?? null : SecureStore.getItemAsync(k));
const set = async (k: string, v: string) => { if (web) globalThis.localStorage?.setItem(k, v); else await SecureStore.setItemAsync(k, v); };
const del = async (k: string) => { if (web) globalThis.localStorage?.removeItem(k); else await SecureStore.deleteItemAsync(k); };

export const getToken = () => get(K.token);
export async function setToken(t: string | null) { if (t) await set(K.token, t); else await del(K.token); }
export const getAccessCode = () => get(K.code);
export async function setAccessCode(c: string | null) { if (c) await set(K.code, c); else await del(K.code); }
export async function getDeviceId(): Promise<string> {
  let id = await get(K.device);
  if (!id) {
    id = 'd_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    await set(K.device, id);
  }
  return id;
}
export async function wipeSecure() { await Promise.all(Object.values(K).map((k) => del(k))); }
