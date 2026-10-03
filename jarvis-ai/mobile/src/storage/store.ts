import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_SETTINGS } from '../config';
import type { Conversation, Memory, Note, Settings, Task } from '../types';

const K = {
  settings: 'settings', conv: 'conversations', mem: 'memories', notes: 'notes', tasks: 'tasks',
};

async function read<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch { return fallback; }
}
const write = (key: string, v: unknown) => AsyncStorage.setItem(key, JSON.stringify(v));

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const loadSettings = async (): Promise<Settings> => ({ ...DEFAULT_SETTINGS, ...(await read<Partial<Settings>>(K.settings, {})) });
export const saveSettings = (s: Settings) => write(K.settings, s);

export const loadConversations = () => read<Conversation[]>(K.conv, []);
export const saveConversations = (c: Conversation[]) => write(K.conv, c.slice(0, 100));

export const loadMemories = () => read<Memory[]>(K.mem, []);
export const saveMemories = (m: Memory[]) => write(K.mem, m);

export const loadNotes = () => read<Note[]>(K.notes, []);
export const saveNotes = (n: Note[]) => write(K.notes, n);

export const loadTasks = () => read<Task[]>(K.tasks, []);
export const saveTasks = (t: Task[]) => write(K.tasks, t);

export async function exportAll() {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    conversations: await loadConversations(),
    memories: await loadMemories(),
    notes: await loadNotes(),
    tasks: await loadTasks(),
  }, null, 2);
}
export async function deleteConversations() { await AsyncStorage.removeItem(K.conv); }
export async function deleteAllData() { await AsyncStorage.clear(); }
