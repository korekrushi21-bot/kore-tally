import { Linking, Platform } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Contacts from 'expo-contacts';
import { AppError } from '../../utils';

type AppDef = { url: string | null; label: string };
const ios = Platform.OS === 'ios';
/** App name -> URL scheme. Only public schemes. null = not available on this platform. */
const APPS: Record<string, AppDef> = {
  phone: { url: 'tel:', label: 'Phone' },
  whatsapp: { url: 'whatsapp://', label: 'WhatsApp' },
  safari: { url: 'https://www.google.com', label: 'Browser' },
  maps: { url: ios ? 'maps://' : 'geo:0,0?q=', label: 'Maps' },
  settings: { url: 'app-settings:', label: 'Settings' },
  photos: { url: ios ? 'photos-redirect://' : null, label: 'Photos' },
  calendar: { url: ios ? 'calshow://' : 'content://com.android.calendar/time/', label: 'Calendar' },
  clock: { url: ios ? 'clock-alarm://' : null, label: 'Clock' }, // Android: via intent, see openApp
  shortcuts: { url: ios ? 'shortcuts://' : null, label: 'Shortcuts' },
  messages: { url: 'sms:', label: 'Messages' },
  reminders: { url: ios ? 'x-apple-reminderkit://' : null, label: 'Reminders' },
};
export const APP_LIST = Object.entries(APPS)
  .filter(([k, v]) => v.url || (k === 'clock' && Platform.OS === 'android'))
  .map(([key, v]) => ({ key, ...v }));

const ALIASES: Record<string, string> = {
  'फोन': 'phone', 'व्हॉट्सअ': 'whatsapp', 'whatsapp': 'whatsapp', 'व्हाट्सएप': 'whatsapp', 'नकाशा': 'maps', 'maps': 'maps',
  'camera': 'camera', 'कॅमेरा': 'camera', 'सेटिंग': 'settings', 'settings': 'settings', 'फोटो': 'photos', 'photos': 'photos',
  'कॅलेंडर': 'calendar', 'calendar': 'calendar', 'घड्याळ': 'clock', 'clock': 'clock', 'shortcuts': 'shortcuts', 'safari': 'safari',
};
export function resolveApp(name: string): string | null {
  const n = name.toLowerCase().trim();
  if (APPS[n]) return n;
  for (const k of Object.keys(ALIASES)) if (n.includes(k.toLowerCase())) return ALIASES[k];
  return null;
}

export async function openApp(name: string): Promise<string> {
  const key = resolveApp(name);
  if (!key) throw new AppError('failed', 'unknown app');
  if (key === 'camera') {
    // No public URL scheme for the Camera app; the in-app camera (Camera AI) is the safe alternative.
    throw new AppError('failed', 'camera has no public URL scheme');
  }
  const app = APPS[key];
  try {
    if (key === 'settings') await Linking.openSettings();
    else if (key === 'clock' && Platform.OS === 'android') await IntentLauncher.startActivityAsync('android.intent.action.SHOW_ALARMS');
    else if (app.url) await Linking.openURL(app.url);
    else throw new Error('unsupported');
  } catch { throw new AppError('failed', `${app.label} unavailable`); }
  return app.label;
}

const digits = (s: string) => s.replace(/[^\d+]/g, '');

/** Resolve a spoken name ("Rahul") to a phone number via Contacts (permission asked on demand). */
export async function findContactNumber(name: string): Promise<{ name: string; number: string } | null> {
  if (/^[+\d\s-]{6,}$/.test(name)) return { name, number: digits(name) };
  if (Platform.OS === 'web') return null; // no contacts API in browsers: say a phone number instead
  const p = await Contacts.requestPermissionsAsync();
  if (!p.granted) return null;
  const { data } = await Contacts.getContactsAsync({ name, fields: [Contacts.Fields.PhoneNumbers], pageSize: 5 });
  const c = data.find((x) => x.phoneNumbers?.length);
  return c ? { name: c.name ?? name, number: digits(c.phoneNumbers![0].number ?? '') } : null;
}

export async function makeCall(number: string) {
  // Opens the dialer with the number filled in (tel:), so the user still presses Call. We never auto-dial.
  try { await Linking.openURL(`tel:${digits(number)}`); } catch { throw new AppError('failed'); }
}

export async function sendMessage(channel: 'whatsapp' | 'sms', number: string, text: string) {
  const n = digits(number).replace(/^\+/, '');
  const url = channel === 'whatsapp'
    ? (Platform.OS === 'web' ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : `whatsapp://send?phone=${n}&text=${encodeURIComponent(text)}`)
    : `sms:${digits(number)}&body=${encodeURIComponent(text)}`;
  try { await Linking.openURL(url); } catch { throw new AppError('failed'); }
  // The message is pre-filled; the user presses Send inside the target app. We never send silently.
}

export const openMaps = (q: string) => Linking.openURL(ios ? `maps://?q=${encodeURIComponent(q)}` : `geo:0,0?q=${encodeURIComponent(q)}`);
export const openSearch = (q: string) => Linking.openURL(`https://www.google.com/search?q=${encodeURIComponent(q)}`);
