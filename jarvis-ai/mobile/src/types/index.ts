export type Lang = 'auto' | 'mr' | 'hi' | 'en';
export type AssistantState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'processing';

export interface Settings {
  assistantName: string;
  language: Lang;
  voiceId?: string;
  speechRate: number;
  volume: number;
  autoSpeak: boolean;
  wakeWordEnabled: boolean;
  wakeWord: string;
  provider: 'openai' | 'anthropic' | 'custom';
  model: string;
  theme: 'dark' | 'light';
  animation: 'low' | 'normal' | 'high';
  uiScale: number;
  backendUrl: string;
  onboarded: boolean;
  manualLocation?: { name: string; lat: number; lon: number };
}

export interface Source { title: string; url: string }

export interface ToolEvent { tool: string; status: 'running' | 'done' | 'error'; summary: string }

export interface ClientAction {
  id: string;
  tool: ToolName;
  args: Record<string, any>;
  summary: string;
  requiresConfirmation: boolean;
}

export type ToolName =
  | 'createReminder' | 'createCalendarEvent' | 'openApp' | 'makePhoneCall'
  | 'sendMessage' | 'getLocation' | 'setAlarm' | 'cameraScan' | 'cropDiseaseAnalysis' | 'createNote';

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  ts: number;
  sources?: Source[];
  toolEvents?: ToolEvent[];
  actions?: ClientAction[];
  actionState?: Record<string, 'pending' | 'done' | 'cancelled' | 'failed'>;
  error?: boolean;
}

export interface Conversation { id: string; title: string; updated: number; messages: Message[] }
export interface Memory { id: string; text: string; ts: number }
export interface Note { id: string; text: string; ts: number }
export interface Task { id: string; title: string; done: boolean; due?: number; notificationId?: string }

export interface AgriResult {
  kind: 'crop' | 'disease' | 'pest' | 'weed' | 'deficiency' | 'healthy' | 'unclear';
  cropGuess: string;
  finding: string;
  confidence: 'low' | 'medium' | 'high';
  confidencePercent: number;
  symptoms: string[];
  possibleCauses: string[];
  nextSteps: string[];
  treatmentNotes: string;
  disclaimer: string;
}

export interface Product {
  id: number; name: string; category: string; description: string;
  unit: string; price: number | null; inStock: boolean; stockQty: number | null; updatedAt: string;
}
