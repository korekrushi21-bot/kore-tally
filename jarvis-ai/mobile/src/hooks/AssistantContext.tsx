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
  startVoice: (opts?: { followUp?: boolean }) => Promise<void>; stopVoice: () => void;
  send: (text: string, fromVoice?: boolean) => Promise<void>; cancel: () => void; regenerate: () => Promise<void>;
  speakText: (t: string) => void; stopSpeak: () => void;
  confirm: (msgId: string, a: ClientAction) => Promise<void>; decline: (msgId: string, a: ClientAction) => void;
  newConversation: () => void; openConversation: (id: string) => void; clearHistory: () => Promise<void>;
  wakeActive: boolean; wakeHeard: string; wakeListening: boolean; retryWake: () => void;
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
  const [wakeHeard, setWakeHeard] = useState('');
  const [wakeListening, setWakeListening] = useState(false);
  const convId = useRef(store.uid());
  const abortRef = useRef<AbortController | null>(null);
  const lastLang = useRef<'mr' | 'hi' | 'en'>('en');
  const stateRef = useRef<AssistantState>('idle');
  const settingsRef = useRef(settings);
  const messagesRef = useRef<Message[]>([]);
  const wakeOn = useRef(false);
  const voiceTurn = useRef(false);      // last user turn was spoken -> keep the conversation hands-free
  const lastPartial = useRef('');
  const wakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakeErrors = useRef(0);
  const startVoiceRef = useRef<(o?: { followUp?: boolean }) => Promise<void>>(async () => {});

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
      onDone: () => {
        if (stateRef.current !== 'speaking') return;
        setSt('idle');
        const st = settingsRef.current;
        if (st.alwaysOn && st.followUp && voiceTurn.current && AppState.currentState === 'active') {
          setTimeout(() => { if (stateRef.current === 'idle') void startVoiceRef.current({ followUp: true }); }, 600);
        }
      },
    });
  }, []);
  const stopSpeak = useCallback(() => { voiceTurn.current = false; stopSpeaking(); if (stateRef.current === 'speaking') setSt('idle'); }, []);

  const reply = (text: string, extra: Partial<Message> = {}) => {
    const m: Message = { id: store.uid(), role: 'assistant', text, ts: Date.now(), ...extra };
    setMsgs((x) => [...x, m]);
    if (settingsRef.current.autoSpeak && !extra.error) speakText(text); else setSt('idle');
    void persist();
  };

  const send = useCallback(async (raw: string, fromVoice = false) => {
    const text = raw.trim();
    if (!text) return;
    voiceTurn.current = fromVoice;
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

    // Voice commands to stop talking.
    if (/^\s*(stop|cancel|quiet|be quiet|थांब|थांबा|बस|चूप|रुको|बंद कर)[.!।\s]*$/i.test(text)) { cancel(); return; }

    // Instant on-device answers (greetings, who are you, time, maths, weather, simple reminders/notes). No AI wait.
    if (text.length < 160) {
      setSt('processing');
      const l0 = effLang(text) as 'mr' | 'hi' | 'en';
      const quick = await localAssistant(text, l0, settingsRef.current).catch(() => null);
      if (quick) {
        const actionState: Record<string, 'pending'> = {};
        quick.actions?.forEach((a) => { actionState[a.id] = 'pending'; });
        reply(quick.text, { actions: quick.actions, actionState });
        return;
      }
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
        location, provider: s.provider, model: s.model || undefined, // blank model = backend auto-picks an installed local model
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, ctrl.signal);
      const actionState: Record<string, 'pending'> = {};
      r.actions.forEach((a) => { actionState[a.id] = 'pending'; });
      reply(r.reply, { sources: r.sources, toolEvents: r.toolEvents, actions: r.actions, actionState });
    } catch (e) {
      if (e instanceof AppError && e.code === 'cancelled') { setSt('idle'); return; }
      // AI unreachable/unconfigured: answer what we can exactly on-device (maths, time, weather, notes, reminders).
      const code = e instanceof AppError ? e.code : 'failed';
      if (['offline', 'ai_down', 'unconfigured', 'auth', 'ai_unconfigured'].includes(code)) {
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
    voiceTurn.current = false; abortRef.current?.abort(); abortListening(); stopSpeaking(); setPending(null); setPartial(''); setSt('idle');
  }, []);

  const startVoice = useCallback(async (opts?: { followUp?: boolean }) => {
    if (stateRef.current === 'listening') { stopListening(); return; }
    stopSpeaking(); abortListening();
    if (wakeTimer.current) { clearTimeout(wakeTimer.current); wakeTimer.current = null; }
    setPartial(''); setPending(null); setError(null);
    lastPartial.current = '';
    let got = false;
    // Recognized text: send straight away (default) or show it for confirmation.
    const finish = (t: string) => {
      const text = t.trim();
      if (!text || got) return;
      got = true; setPartial('');
      if (settingsRef.current.voiceAutoSend) void send(text, true); else { voiceTurn.current = true; setPending(text); }
    };
    try {
      setSt('listening');
      await startListening(sttLocale(), {
        onPartial: (t) => { lastPartial.current = t; setPartial(t); },
        onFinal: (t) => finish(t),
        onLevel: setLevel,
        onEnd: () => {
          setLevel(0);
          // Some recognizers end without a final result: use what we heard.
          if (!got && lastPartial.current.trim()) finish(lastPartial.current);
          else if (!got) voiceTurn.current = false; // silence: end the hands-free conversation, back to wake-word mode
          if (stateRef.current === 'listening') setSt('idle');
        },
        onError: (e) => { voiceTurn.current = false; setError(friendly(e)); setSt('idle'); },
      });
    } catch (e) { voiceTurn.current = false; setError(friendly(e)); setSt('idle'); }
  }, [send]);
  startVoiceRef.current = startVoice;
  const stopVoice = useCallback(() => stopListening(), []);

  // ---------- Always-on (hands-free) mode: wake word while the app is open ----------
  // Android and iOS do not allow third-party apps to listen continuously in the background, so this runs only
  // while the app / window is open and visible. Recognition restarts automatically; it stops when the app is
  // hidden or "JARVIS always on" is switched off. The browser/OS shows its normal "microphone in use" indicator.
  const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{M}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
  const wakeAliases = () => {
    const st = settingsRef.current;
    const base = norm(st.wakeWord).replace(/^(hey|hi|hello|ok|okay|ए|हे|हाय)\s+/, '');
    const list = new Set<string>([base, norm(st.assistantName)].filter((x) => x.length > 2));
    if (/jarvis/.test(base) || /jarvis/i.test(st.assistantName)) ['जार्विस', 'जारविस', 'जार्वीस', 'जरविस', 'जार्विज', 'जार्वीज', 'जारविज'].forEach((x) => list.add(x));
    return [...list];
  };
  // Speech recognizers rarely spell a name the same way ("jarvis", "jarvish", "harvest", "जार्विस", "जरवीस"), so match approximately.
  const lev = (x: string, y: string) => {
    const d: number[][] = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]);
    for (let j = 1; j <= y.length; j++) d[0][j] = j;
    for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    return d[x.length][y.length];
  };
  const skel = (w: string) => w.replace(/\p{M}/gu, '');
  const isDev = (w: string) => /[\u0900-\u097F]/.test(w);
  const findWake = (t: string): { found: boolean; rest: string } => {
    const n = norm(t);
    const words = n.split(' ').filter(Boolean);
    const aliases = wakeAliases();
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const hit = aliases.some((a) => {
        if (a.includes(' ')) return false;
        if (w === a) return true;
        if (isDev(a)) return isDev(w) && lev(skel(w), skel(a)) <= 1;
        return !isDev(w) && w.length >= 4 && a.length >= 4 && lev(w, a) <= (a.length >= 6 ? 2 : 1);
      });
      if (hit) return { found: true, rest: words.slice(i + 1).join(' ') };
    }
    // multi-word wake phrases
    for (const a of aliases) if (a.includes(' ')) { const k = n.indexOf(a); if (k >= 0) return { found: true, rest: n.slice(k + a.length).trim() }; }
    return { found: false, rest: '' };
  };

  const startWake = useCallback(async () => {
    if (!wakeOn.current || stateRef.current !== 'idle' || AppState.currentState !== 'active') return;
    let handled = false;
    const woke = (rest: string) => {
      if (handled) return;
      handled = true;
      if (wakeTimer.current) { clearTimeout(wakeTimer.current); wakeTimer.current = null; }
      abortListening();
      // The wake phrase was heard by the English recognizer. For Marathi/Hindi the words after it would be garbage,
      // so always listen again in the chosen language. In English, "Hey JARVIS what is the weather" is answered directly.
      const lang = settingsRef.current.language;
      if (rest.length > 3 && lang !== 'mr' && lang !== 'hi') void send(rest, true); else void startVoice();
    };
    try {
      await startListening('en-IN', {
        onPartial: (t) => {
          setWakeHeard(t); setWakeListening(true);
          if (handled || wakeTimer.current) return;
          const w = findWake(t);
          // wake word heard but the sentence is not finished: give it 1.8 s, then start listening for the command
          if (w.found) wakeTimer.current = setTimeout(() => { wakeTimer.current = null; woke(findWake(t).rest); }, 1800);
        },
        onFinal: (t) => { setWakeHeard(t); setWakeListening(true); const w = findWake(t); if (w.found) woke(w.rest); },
        onEnd: () => {
          if (!handled && wakeOn.current && stateRef.current === 'idle') setTimeout(() => void startWake(), 400);
        },
        onError: (e) => {
          if (e.code === 'mic' || e.code === 'stt_unavailable') { wakeOn.current = false; setWakeActive(false); setError(friendly(e)); return; }
          wakeErrors.current += 1; // transient (network etc.): retry a few times with a pause
          if (wakeErrors.current <= 5 && wakeOn.current) setTimeout(() => void startWake(), 3000);
          else { wakeOn.current = false; setWakeActive(false); }
        },
      }, { continuous: true, onDevice: true });
      wakeErrors.current = 0; setWakeListening(true);
    } catch { wakeOn.current = false; setWakeActive(false); setWakeListening(false); }
  }, [send, startVoice]);

  // Called from a button press (a user gesture), so the browser reliably shows its microphone permission prompt.
  const retryWake = useCallback(() => {
    setError(null); wakeErrors.current = 0;
    wakeOn.current = settingsRef.current.alwaysOn;
    setWakeActive(wakeOn.current);
    abortListening();
    if (wakeOn.current) setTimeout(() => void startWake(), 150);
  }, [startWake]);

  useEffect(() => {
    wakeOn.current = settings.alwaysOn && settings.onboarded && ready;
    setWakeActive(wakeOn.current);
    wakeErrors.current = 0;
    if (wakeOn.current) void startWake(); else if (stateRef.current === 'idle') abortListening();
  }, [settings.alwaysOn, settings.onboarded, settings.wakeWord, settings.assistantName, settings.language, ready, startWake]);
  // While JARVIS is thinking/speaking the wake listener must be off (it would hear JARVIS's own voice).
  useEffect(() => { if (state === 'thinking' || state === 'speaking' || state === 'processing') abortListening(); }, [state]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') { voiceTurn.current = false; abortListening(); stopSpeaking(); setSt('idle'); }
      else if (wakeOn.current) void startWake();
    });
    return () => sub.remove();
  }, [startWake]);
  useEffect(() => { if (state === 'idle' && wakeOn.current) { const t = setTimeout(() => void startWake(), 700); return () => clearTimeout(t); } }, [state, startWake]);

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
    wakeActive, wakeHeard, wakeListening, retryWake, error, clearError: () => setError(null),
  }), [ready, settings, colors, state, level, partial, pending, messages, conversations, memories, wakeActive, wakeHeard, wakeListening, retryWake, error,
    updateSettings, refreshMemories, startVoice, stopVoice, send, cancel, regenerate, speakText, stopSpeak, confirm, decline, newConversation, openConversation, clearHistory]);

  return <C.Provider value={value}>{children}</C.Provider>;
}

export const LANG_LABEL = (l: string) => LANGS.find((x) => x.code === l)?.label ?? l;
