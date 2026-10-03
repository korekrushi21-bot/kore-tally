import { Alert, Linking, Platform, Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';

export const isWeb = Platform.OS === 'web';
export const isAndroid = Platform.OS === 'android';

/** Cross-platform confirm dialog (Alert.alert is a no-op on web). */
export function ask(title: string, message: string | undefined, confirmLabel: string, onConfirm: () => void) {
  if (isWeb) {
    if (typeof window !== 'undefined' && window.confirm([title, message].filter(Boolean).join('\n\n'))) onConfirm();
    return;
  }
  Alert.alert(title, message, [{ text: 'Cancel', style: 'cancel' }, { text: confirmLabel, style: 'destructive', onPress: onConfirm }]);
}

/** Share sheet on phones; Web Share API or clipboard on desktop. */
export async function shareText(text: string) {
  if (isWeb) {
    const nav: any = typeof navigator !== 'undefined' ? navigator : undefined;
    if (nav?.share) { try { await nav.share({ text }); return; } catch { /* fall through */ } }
    await Clipboard.setStringAsync(text);
    return;
  }
  await Share.share({ message: text });
}

export async function openAppSettings() {
  if (isWeb) return; // browser permissions: lock icon in the address bar
  await Linking.openSettings();
}
