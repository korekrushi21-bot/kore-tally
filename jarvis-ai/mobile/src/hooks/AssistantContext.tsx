import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { DEFAULT_SETTINGS, LANGS, palette, type Palette } from '../config';
import * as store from '../storage/store';
import { setBackendUrl, chat, isOnline } from '../services/ai/api';
import { abortListening, startListening, stopListening } from '../services/speech/stt';
import { speak, stopSpeaking } from '../services/tts/tts';
import { currentCoords } from '../services/weather';
import { executeAction } from '../services/tools/executor';
import { AppError, detectLang, friendly, speechLocale } from '../utils';
import { navigate } from '../navigation/ref';
import { localAssistant, NO_AI_HELP } from '../services/local';
import type { AssistantState, ClientAction, Conversation, Memory, Message, Settings } from '../types';

interface Ctx {
  ready: boolean;
  settings: Settings; updateSettings: (p: Partial<Settings>) => Promise<void>;
  colors: Palette;
  state: AssistantState; level: number; partial: string;
  pending: string | null; setPending: (t: string | null) => void;
  messages: Message[]; conversations: Conversation[];
  memories: Memory[]; refreshMemories: () => Promise<void>;
  startVoice: () => Promise<void>; stopVoice: () => void;
  send: (text: string) => Promise<void>; cancel: () => void; regenerate: () => Promise<void>;
  speakText: (t: string) => void; stopSpeak: () => void;
  confirm: (msgId: string, a: ClientAction) => Promise<void>; decline: (msgId: string, a: ClientAction) => void;
  newConversation: () => void; openConversation: (id: string) => void; clearHistory: () => Promise<void>;
  wakeActive: boolean;
  error: string | null; clearError: () => void;
}
const C = createContext<Ctx>(null as unknown as Ctx);
export const useAssistant = () => useContext(C);

const SENSITIVE = /(password|passcode|otp|\bpin\b|cvv|card number|aadhaar|आधार|पासवर्ड|पिन)/i;
const REMEMBER = /^\s*(remember( that)?|लक्षात ठेव|याद रख(ो)?)\s*[:,]?\s*(.+)$/is;

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [state, setState] = useState<AssistantState>('idle');
  const [level, setLevel] = useState(0);
  const [partial, setPartial] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [wakeActive, setWakeActive] = useState(false);
  const convId = useRef(store.uid());
  const abortRef = useRef<AbortController | null>(null);
  const lastLang = useRef<'mr' | 'hi' | 'en'>('en');
  const stateRef = useRef<AssistantState>('idle');
  const settingsRef = useRef(settings);
  const messagesRef = useRef<Message[]>([]);
  const wakeOn = useRef(false);

  const setSt = (s: AssistantState) => { stateRef.current = s; setState(s); };
  const setMsgs = (fn: (m: Message[]) => Message[]) => { messagesRef.current = fn(messagesRef.current); setMessages(messagesRef.current); };

  useEffect(() => {
    (async () => {
      const s = await store.loadSettings();
      setSettings(s); settingsRef.current = s; setBackendUrl(s.backendUrl);
      setConversations(await store.loadConversations());
      setMemories(await store.loadMemories());
      setReady(true);
    })();
  }, []);

  const colors = palette[settings.theme];

  const updateSettings = useCallback(async (p: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...p };
    settingsRef.current = next; setSettings(next);
    if (p.backendUrl !== undefined) setBackendUrl(p.backendUrl);
    await store.saveSettings(next);
  }, []);

  const effLang = (text?: string) => {
    const l = settingsRef.current.language;
    if (l !== 'auto') return l;
    return text ? detectLang(text) : lastLang.current;
  };
  const sttLocale = () => speechLocale(settingsRef.current.language === 'auto' ? lastLang.current : (settingsRef.current.language as 'mr' | 'hi' | 'en'));

  const persist = useCallback(async () => {
    const msgs = messagesRef.current;
    if (!msgs.length) return;
    const first = msgs.find((m) => m.role === 'user')?.text ?? 'Conversation';
    const conv: Conversation = { id: convId.current, title: first.slice(0, 48), updated: Date.now(), messages: msgs.slice(-60) };
    setConversations((prev) => {
      const next = [conv, ...prev.filter((c) => c.id !== conv.id)];
      void store.saveConversations(next);
      return next;
    });
  }, []);

  const speakText = useCallback((t: string) => {
    const s = settingsRef.current;
    setSt('speaking');
    speak(t, {
      locale: speechLocale(effLang(t)), voice: s.voiceId, rate: s.speechRate, volume: s.volume,
      onDone: () => { if (stateRef.current === 'speaking') setSt('idle'); },
    });
  }, []);
  const stopSpeak = useCallback(() => { stopSpeaking(); if (stateRef.current === 'speaking') setSt('idle'); }, []);

  const reply = (text: string, extra: Partial<Message> = {}) => {
    const m: Message = { id: store.uid(), role: 'assistant', text, ts: Date.now(), ...extra };
    setMsgs((x) => [...x, m]);
    if (settingsRef.current.autoSpeak && !extra.error) speakText(text); else setSt('idle');
    void persist();
  };

  const send = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    setPending(null); setPartial(''); setError(null);
    stopSpeaking();
    lastLang.current = detectLang(text);
    setMsgs((x) => [...x, { id: store.uid(), role: 'user', text, ts: Date.now() }]);

    // Explicit long-term memory: only saved when the user says "remember ...".
    const rm = text.match(REMEMBER);
    if (rm) {
      const fact = rm[4].trim();
      if (SENSITIVE.test(fact)) { reply('I will not store passwords, PINs, OTPs or card/ID numbers in memory.'); return; }
      const mem = { id: store.uid(), text: fact, ts: Date.now() };
      const all = [mem, ...(await store.loadMemories())];
      await store.saveMemories(all); setMemories(all);
      reply(lastLang.current === 'mr' ? 'ठीक आहे, लक्षात ठेवलं.' : lastLang.current === 'hi' ? 'ठीक है, याद रख लिया।' : 'Okay, I will remember that.');
      return;
    }

    setSt('thinking');
    const ctrl = new AbortController(); abortRef.current = ctrl;
    try {
      if (!(await isOnline())) throw new AppError('offline');
      const s = settingsRef.current;
      let location: { lat: number; lon: number; name?: string } | undefined = s.manualLocation && { lat: s.manualLocation.lat, lon: s.manualLocation.lon, name: s.manualLocation.name };
      // Only fetch device location when the question looks location/weather related; never stored.
      if (!location && /(weather|rain|temperature|near me|हवामान|पाऊस|तापमान|जवळ|मौसम|बारिश)/i.test(text)) {
        try { location = await currentCoords(); } catch { /* assistant will ask for a city */ }
      }
      const history = messagesRef.current.filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.error).slice(-12)
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.text }));
      const r = await chat({
        messages: history, language: effLang(text), assistantName: s.assistantName,
        memories: (await store.loadMemories()).map((m) => m.text),
        location, provider: s.provider, model: s.model || undefined,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, ctrl.signal);
      const actionState: Record<string, 'pending'> = {};
      r.actions.forEach((a) => { actionState[a.id] = 'pending'; });
      reply(r.reply, { sources: r.sources, toolEvents: r.toolEvents, actions: r.actions, actionState });
    } catch (e) {
      if (e instanceof AppError && e.code === 'cancelled') { setSt('idle'); return; }
      // AI unreachable/unconfigured: answer what we can exactly on-device (maths, time, weather, notes, reminders).
      const code = e instanceof AppError ? e.code : 'failed';
      if (['offline', 'ai_down', 'unconfigured', 'auth'].includes(code)) {
        const l = effLang(text) as 'mr' | 'hi' | 'en';
        const local = await localAssistant(text, l, settingsRef.current).catch(() => null);
        if (local) {
          const actionState: Record<string, 'pending'> = {};
          local.actions?.forEach((a) => { actionState[a.id] = 'pending'; });
          reply(local.text, { actions: local.actions, actionState });
          return;
        }
        const msg = code === 'offline' ? friendly(e) : NO_AI_HELP(l);
        setError(msg);
        reply(msg, { error: true });
        return;
      }
      const msg = friendly(e);
      setError(msg);
      reply(msg, { error: true });
    } finally { abortRef.current = null; }
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort(); abortListening(); stopSpeaking(); setPending(null); setPartial(''); setSt('idle');
  }, []);

  const startVoice = useCallback(async () => {
    if (stateRef.current === 'listening') { stopListening(); return; }
    stopSpeaking(); abortListening();
    setPartial(''); setPending(null); setError(null);
    try {
      setSt('listening');
      await startListening(sttLocale(), {
        onPartial: (t) => setPartial(t),
        onFinal: (t) => { setPartial(''); if (t.trim()) setPending(t); },
        onLevel: setLevel,
        onEnd: () => { setLevel(0); if (stateRef.current === 'listening') setSt('idle'); },
        onError: (e) => { setError(friendly(e)); setSt('idle'); },
      });
    } catch (e) { setError(friendly(e)); setSt('idle'); }
  }, []);
  const stopVoice = useCallback(() => stopListening(), []);

  // ---------- Foreground-only wake word ("Hey JARVIS") ----------
  // Android and iOS do not allow third-party apps to listen continuously in the background. This only runs
  // while the app is open and in the foreground, uses on-device recognition when available,
  // and stops as soon as the app is backgrounded or the toggle is switched off.
  const startWake = useCallback(async () => {
    if (!wakeOn.current || stateRef.current !== 'idle' || AppState.currentState !== 'active') return;
    const phrase = settingsRef.current.wakeWord.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim();
    const hit = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').includes(phrase);
    try {
      await startListening(sttLocale(), {
        onPartial: (t) => { if (hit(t)) { abortListening(); void startVoice(); } },
        onFinal: (t) => { if (hit(t)) { abortListening(); void startVoice(); } },
        onEnd: () => { if (wakeOn.current && stateRef.current === 'idle') setTimeout(() => void startWake(), 400); },
        onError: () => { wakeOn.current = false; setWakeActive(false); },
      }, { continuous: true, onDevice: true });
    } catch { wakeOn.current = false; setWakeActive(false); }
  }, [startVoice]);

  useEffect(() => {
    wakeOn.current = settings.wakeWordEnabled && ready;
    setWakeActive(wakeOn.current);
    if (wakeOn.current) void startWake(); else if (stateRef.current === 'idle') abortListening();
  }, [settings.wakeWordEnabled, settings.wakeWord, ready, startWake]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') { if (stateRef.current === 'listening') abortListening(); abortListening(); setSt('idle'); }
      else if (wakeOn.current) void startWake();
    });
    return () => sub.remove();
  }, [startWake]);
  useEffect(() => { if (state === 'idle' && wakeOn.current) { const t = setTimeout(() => void startWake(), 600); return () => clearTimeout(t); } }, [state, startWake]);

  const regenerate = useCallback(async () => {
    const last = [...messagesRef.current].reverse().find((m) => m.role === 'user');
    if (!last) return;
    // drop trailing assistant messages after the last user message
    const idx = messagesRef.current.map((m) => m.id).lastIndexOf(last.id);
    setMsgs((x) => x.slice(0, idx));
    await send(last.text);
  }, [send]);

  const patchAction = (msgId: string, id: string, st: 'done' | 'cancelled' | 'failed') =>
    setMsgs((x) => x.map((m) => (m.id === msgId ? { ...m, actionState: { ...m.actionState, [id]: st } } : m)));

  const confirm = useCallback(async (msgId: string, a: ClientAction) => {
    setSt('processing');
    try {
      const res = await executeAction(a, { navigate });
      patchAction(msgId, a.id, 'done');
      setMsgs((x) => [...x, { id: store.uid(), role: 'system', text: '✅ ' + res, ts: Date.now() }]);
    } catch (e) {
      patchAction(msgId, a.id, 'failed');
      setMsgs((x) => [...x, { id: store.uid(), role: 'system', text: '⚠️ ' + friendly(e), ts: Date.now() }]);
    } finally { setSt('idle'); void persist(); }
  }, [persist]);
  const decline = useCallback((msgId: string, a: ClientAction) => patchAction(msgId, a.id, 'cancelled'), []);

  const newConversation = useCallback(() => { cancel(); convId.current = store.uid(); messagesRef.current = []; setMessages([]); }, [cancel]);
  const openConversation = useCallback((id: string) => {
    const c = conversations.find((x) => x.id === id);
    if (!c) return;
    cancel(); convId.current = c.id; messagesRef.current = c.messages; setMessages(c.messages);
  }, [conversations, cancel]);
  const clearHistory = useCallback(async () => { await store.deleteConversations(); setConversations([]); messagesRef.current = []; setMessages([]); }, []);
  const refreshMemories = useCallback(async () => setMemories(await store.loadMemories()), []);

  const value = useMemo<Ctx>(() => ({
    ready, settings, updateSettings, colors, state, level, partial, pending, setPending, messages, conversations, memories, refreshMemories,
    startVoice, stopVoice, send, cancel, regenerate, speakText, stopSpeak, confirm, decline, newConversation, openConversation, clearHistory,
    wakeActive, error, clearError: () => setError(null),
  }), [ready, settings, colors, state, level, partial, pending, messages, conversations, memories, wakeActive, error,
    updateSettings, refreshMemories, startVoice, stopVoice, send, cancel, regenerate, speakText, stopSpeak, confirm, decline, newConversation, openConversation, clearHistory]);

  return <C.Provider value={value}>{children}</C.Provider>;
}

export const LANG_LABEL = (l: string) => LANGS.find((x) => x.code === l)?.label ?? l;
