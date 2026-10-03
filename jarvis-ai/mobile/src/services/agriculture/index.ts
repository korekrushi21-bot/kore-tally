import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { AppError } from '../../utils';
import { analyzeCrop } from '../ai/api';
import type { AgriResult } from '../../types';

export async function pickImage(source: 'camera' | 'library'): Promise<string | null> {
  if (source === 'camera' && Platform.OS !== 'web') { // desktop browsers use the file chooser instead
    const p = await ImagePicker.requestCameraPermissionsAsync();
    if (!p.granted) throw new AppError('camera');
    const r = await ImagePicker.launchCameraAsync({ quality: 1, mediaTypes: ['images'] });
    return r.canceled ? null : r.assets[0].uri;
  }
  const r = await ImagePicker.launchImageLibraryAsync({ quality: 1, mediaTypes: ['images'] });
  return r.canceled ? null : r.assets[0].uri;
}

/** Compress before upload: max 1280px wide, JPEG 0.6, base64 (no EXIF/location kept). */
export async function compress(uri: string) {
  const out = await ImageManipulator.manipulateAsync(uri, [{ resize: { width: 1280 } }], {
    compress: 0.6, format: ImageManipulator.SaveFormat.JPEG, base64: true,
  });
  if (!out.base64) throw new AppError('failed');
  return { uri: out.uri, base64: out.base64 };
}

export async function scan(uri: string, language: string, note: string | undefined, signal?: AbortSignal): Promise<AgriResult> {
  const img = await compress(uri);
  return analyzeCrop({ imageBase64: img.base64, mimeType: 'image/jpeg', language, note }, signal);
}
