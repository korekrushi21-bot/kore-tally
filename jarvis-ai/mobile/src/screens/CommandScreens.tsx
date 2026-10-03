import React, { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { Btn, Glass, Input, Row, Screen, T } from '../components/ui';
import { useAssistant } from '../hooks/AssistantContext';
import * as store from '../storage/store';
import { friendly } from '../utils';
import { ask } from '../utils/platform';
import { webSearch } from '../services/ai/api';
import { APP_LIST, openApp } from '../services/phone/actions';
import { cancelReminder, createCalendarEvent, createReminder, upcomingEvents } from '../services/calendar';
import type { Memory, Note, Task, Source } from '../types';

export function HistoryScreen({ navigation }: any) {
  const { conversations, openConversation, clearHistory } = useAssistant();
  return (
    <Screen title="History" onBack={() => navigation.goBack()}>
      {conversations.length === 0 && <T sub>No conversations yet.</T>}
      {conversations.map((c) => (
        <Glass key={c.id} onPress={() => { openConversation(c.id); navigation.navigate('Chat'); }}>
          <T bold>{c.title}</T>
          <T sub size={12}>{new Date(c.updated).toLocaleString()} · {c.messages.length} messages</T>
        </Glass>
      ))}
      {conversations.length > 0 && <Btn kind="danger" label="Delete all conversations" onPress={() =>
        ask('Delete all conversations?', 'This cannot be undone.', 'Delete', () => void clearHistory())} />}
    </Screen>
  );
}

const CARDS: { icon: string; label: string; screen: string }[] = [
  { icon: '🎙', label: 'Voice', screen: 'Home' },
  { icon: '🌐', label: 'Web Search', screen: 'Search' },
  { icon: '🌦', label: 'Weather', screen: 'Weather' },
  { icon: '📅', label: 'Calendar', screen: 'Calendar' },
  { icon: '⏰', label: 'Reminders', screen: 'Reminders' },
  { icon: '📱', label: 'Phone', screen: 'PhoneApps' },
  { icon: '🌾', label: 'Agriculture', screen: 'Agriculture' },
  { icon: '🏪', label: 'Kore Krushi', screen: 'Shop' },
  { icon: '📷', label: 'Camera AI', screen: 'Agriculture' },
  { icon: '🧠', label: 'Memory', screen: 'Memory' },
  { icon: '⚙', label: 'Settings', screen: 'Settings' },
];

export function CommandScreen({ navigation }: any) {
  return (
    <Screen title="Command Center" onBack={() => navigation.goBack()}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {CARDS.map((c) => (
          <Glass key={c.label} onPress={() => navigation.navigate(c.screen, c.label === 'Camera AI' ? { mode: 'camera' } : undefined)} style={{ width: '47.5%', height: 110, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 34 }}>{c.icon}</Text>
            <T bold style={{ marginTop: 6 }}>{c.label}</T>
          </Glass>
        ))}
      </View>
    </Screen>
  );
}

export function SearchScreen({ navigation }: any) {
  const { settings } = useAssistant();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ summary: string; sources: Source[]; searchSource?: string; limitation?: string | null } | null>(null);
  const [err, setErr] = useState('');
  const go = async () => {
    if (!q.trim()) return;
    setBusy(true); setErr(''); setRes(null);
    try { setRes(await webSearch(q, settings.language)); } catch (e) { setErr(friendly(e)); }
    setBusy(false);
  };
  return (
    <Screen title="Web Search" onBack={() => navigation.goBack()}>
      <Input value={q} onChangeText={setQ} placeholder="आजचा सोयाबीन भाव…" returnKeyType="search" onSubmitEditing={go} />
      <Btn label="Search" onPress={go} busy={busy} />
      {!!err && <T style={{ color: '#f87171' }}>{err}</T>}
      {res && (
        <Glass>
          <T>{res.summary}</T>
          <T sub size={12} style={{ marginTop: 10 }}>Retrieved just now via {res.searchSource ?? 'web'}. {res.limitation ?? ''} Verify prices and news with the sources.</T>
          {res.sources.map((s, i) => (
            <Pressable key={i} onPress={() => /^https:\/\//.test(s.url) && Linking.openURL(s.url)} style={{ marginTop: 6 }}>
              <Text numberOfLines={2} style={{ color: '#38bdf8' }}>{i + 1}. {s.title || s.url}</Text>
            </Pressable>
          ))}
        </Glass>
      )}
    </Screen>
  );
}

export function PhoneAppsScreen({ navigation }: any) {
  const [msg, setMsg] = useState('');
  return (
    <Screen title="Phone" onBack={() => navigation.goBack()}>
      <T sub size={13}>Opens apps through public Android/desktop links. Calls and messages always need your confirmation.</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {APP_LIST.map((a) => (
          <Glass key={a.key} onPress={async () => { try { setMsg(`Opened ${await openApp(a.key)}`); } catch { setMsg(`Could not open ${a.label}. It may not be installed.`); } }} style={{ minWidth: '30%' }}>
            <T bold>{a.label}</T>
          </Glass>
        ))}
        <Glass onPress={() => navigation.navigate('Agriculture', { mode: 'camera' })}><T bold>Camera (in-app)</T></Glass>
      </View>
      <T sub size={12}>There is no public link to the system Camera app, so the in-app camera scanner is used instead.</T>
      {!!msg && <T>{msg}</T>}
    </Screen>
  );
}

export function MemoryScreen({ navigation }: any) {
  const { memories, refreshMemories, colors } = useAssistant();
  const [text, setText] = useState('');
  const [edit, setEdit] = useState<string | null>(null);
  const save = async () => {
    if (!text.trim()) return;
    const all = await store.loadMemories();
    const next: Memory[] = edit ? all.map((m) => (m.id === edit ? { ...m, text: text.trim() } : m)) : [{ id: store.uid(), text: text.trim(), ts: Date.now() }, ...all];
    await store.saveMemories(next); setText(''); setEdit(null); await refreshMemories();
  };
  const del = async (id: string) => { await store.saveMemories((await store.loadMemories()).filter((m) => m.id !== id)); await refreshMemories(); };
  return (
    <Screen title="Memory" onBack={() => navigation.goBack()}>
      <T sub size={13}>Only things you explicitly save are remembered (say “Remember that…”). Stored on this device. Passwords, PINs and card numbers are never saved automatically.</T>
      <Input value={text} onChangeText={setText} placeholder={edit ? 'Edit memory' : 'Add a memory'} />
      <Btn label={edit ? 'Update' : 'Save'} onPress={save} />
      {memories.map((m) => (
        <Glass key={m.id}>
          <T>{m.text}</T>
          <View style={{ flexDirection: 'row', gap: 16, marginTop: 6 }}>
            <Pressable onPress={() => { setEdit(m.id); setText(m.text); }}><T style={{ color: colors.accent }}>Edit</T></Pressable>
            <Pressable onPress={() => del(m.id)}><T style={{ color: colors.err }}>Delete</T></Pressable>
          </View>
        </Glass>
      ))}
      {memories.length > 0 && <Btn kind="danger" label="Clear all memories" onPress={() =>
        ask('Clear all memories?', undefined, 'Clear', async () => { await store.saveMemories([]); await refreshMemories(); })} />}
    </Screen>
  );
}

/** Reminders + Tasks + Notes, all local. */
export function RemindersScreen({ navigation }: any) {
  const { colors } = useAssistant();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [title, setTitle] = useState('');
  const [mins, setMins] = useState('60');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(async () => { setTasks(await store.loadTasks()); setNotes(await store.loadNotes()); }, []);
  useEffect(() => { void load(); }, [load]);

  const addReminder = async () => {
    try {
      await createReminder(title.trim(), new Date(Date.now() + Math.max(1, parseInt(mins, 10) || 60) * 60000));
      setTitle(''); setMsg(''); await load();
    } catch (e) { setMsg(friendly(e) + ' (check Notifications permission)'); }
  };
  const toggle = async (t: Task) => { await store.saveTasks(tasks.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x))); await load(); };
  const remove = async (t: Task) => { await cancelReminder(t); await store.saveTasks(tasks.filter((x) => x.id !== t.id)); await load(); };
  const addNote = async () => { if (!note.trim()) return; await store.saveNotes([{ id: store.uid(), text: note.trim(), ts: Date.now() }, ...notes]); setNote(''); await load(); };

  return (
    <Screen title="Reminders & Notes" onBack={() => navigation.goBack()}>
      <Glass style={{ gap: 8 }}>
        <T bold>New reminder</T>
        <Input value={title} onChangeText={setTitle} placeholder="What should I remind you?" />
        <Input value={mins} onChangeText={setMins} keyboardType="number-pad" placeholder="Minutes from now" />
        <Btn label="Set reminder" onPress={addReminder} disabled={!title.trim()} />
        {!!msg && <T style={{ color: colors.err }}>{msg}</T>}
        <T sub size={12}>Tip: say “उद्या सकाळी 8 वाजता आठवण करून दे” to the assistant for exact times.</T>
      </Glass>
      <T bold>Tasks</T>
      {tasks.map((t) => (
        <Row key={t.id} label={(t.done ? '✅ ' : '⬜ ') + t.title} sub={t.due ? new Date(t.due).toLocaleString() : undefined} onPress={() => toggle(t)}>
          <Pressable onPress={() => remove(t)}><T style={{ color: colors.err }}>Delete</T></Pressable>
        </Row>
      ))}
      <T bold style={{ marginTop: 12 }}>Notes</T>
      <Input value={note} onChangeText={setNote} placeholder="Write a note" multiline />
      <Btn label="Save note" kind="ghost" onPress={addNote} />
      {notes.map((n) => (
        <Row key={n.id} label={n.text} sub={new Date(n.ts).toLocaleString()}>
          <Pressable onPress={async () => { await store.saveNotes(notes.filter((x) => x.id !== n.id)); await load(); }}><T style={{ color: colors.err }}>Delete</T></Pressable>
        </Row>
      ))}
    </Screen>
  );
}

export function CalendarScreen({ navigation }: any) {
  const [events, setEvents] = useState<{ id: string; title: string; startDate: any }[]>([]);
  const [title, setTitle] = useState('');
  const [mins, setMins] = useState('60');
  const [msg, setMsg] = useState('');
  const load = useCallback(async () => {
    try { setEvents((await upcomingEvents(7)) as any); setMsg(''); } catch (e) { setMsg(friendly(e) + ' (Calendar permission needed)'); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <Screen title="Calendar" onBack={() => navigation.goBack()}>
      <Glass style={{ gap: 8 }}>
        <T bold>New event</T>
        <Input value={title} onChangeText={setTitle} placeholder="Title" />
        <Input value={mins} onChangeText={setMins} keyboardType="number-pad" placeholder="Starts in (minutes)" />
        <Btn label="Add to calendar" disabled={!title.trim()} onPress={async () => {
          try { await createCalendarEvent(title.trim(), new Date(Date.now() + (parseInt(mins, 10) || 60) * 60000)); setTitle(''); await load(); } catch (e) { setMsg(friendly(e)); }
        }} />
      </Glass>
      {!!msg && <T sub>{msg}</T>}
      <T bold>Next 7 days</T>
      {events.length === 0 && !msg && <T sub>No events.</T>}
      {events.map((e) => <Row key={e.id} label={e.title} sub={new Date(e.startDate).toLocaleString()} />)}
    </Screen>
  );
}
