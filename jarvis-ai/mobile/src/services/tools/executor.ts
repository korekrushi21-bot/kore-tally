import { createCalendarEvent, createReminder } from '../calendar';
import { findContactNumber, makeCall, openApp, sendMessage } from '../phone/actions';
import { loadNotes, saveNotes, uid } from '../../storage/store';
import { AppError } from '../../utils';
import type { ClientAction, ToolName } from '../../types';
import { Linking, Platform } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';

/** Actions that must NEVER run without an explicit user tap, regardless of what the server says. */
const ALWAYS_CONFIRM: ToolName[] = ['makePhoneCall', 'sendMessage', 'createReminder', 'createCalendarEvent', 'setAlarm', 'createNote'];

export function needsConfirmation(a: ClientAction) {
  return a.requiresConfirmation || ALWAYS_CONFIRM.includes(a.tool);
}

export interface ExecCtx { navigate: (screen: string, params?: object) => void }

/** Executes a user-approved action and returns a short human-readable result. Throws AppError on failure. */
export async function executeAction(a: ClientAction, ctx: ExecCtx): Promise<string> {
  const args = a.args ?? {};
  switch (a.tool) {
    case 'createReminder': {
      const when = new Date(String(args.whenIso));
      if (isNaN(+when)) throw new AppError('failed');
      await createReminder(String(args.title ?? 'Reminder'), when);
      return `Reminder set for ${when.toLocaleString()}.`;
    }
    case 'createCalendarEvent': {
      const start = new Date(String(args.startIso));
      if (isNaN(+start)) throw new AppError('failed');
      const end = args.endIso ? new Date(String(args.endIso)) : undefined;
      await createCalendarEvent(String(args.title ?? 'Event'), start, end && !isNaN(+end) ? end : undefined, args.notes);
      return `Calendar event created for ${start.toLocaleString()}.`;
    }
    case 'openApp': return `Opened ${await openApp(String(args.app ?? ''))}.`;
    case 'makePhoneCall': {
      const c = await findContactNumber(String(args.contact ?? ''));
      if (!c) throw new AppError('failed', 'contact not found');
      await makeCall(c.number);
      return `Calling ${c.name}.`;
    }
    case 'sendMessage': {
      const c = await findContactNumber(String(args.contact ?? ''));
      if (!c) throw new AppError('failed', 'contact not found');
      await sendMessage(args.channel === 'sms' ? 'sms' : 'whatsapp', c.number, String(args.text ?? ''));
      return `Message to ${c.name} is ready — press Send in the app that opened.`;
    }
    case 'setAlarm':
    {
      const t = args.timeIso ? new Date(String(args.timeIso)) : null;
      if (Platform.OS === 'android' && t && !isNaN(+t)) {
        // Standard Android SET_ALARM intent: the Clock app opens with the alarm prefilled (skipUi sets it directly).
        await IntentLauncher.startActivityAsync('android.intent.action.SET_ALARM', {
          extra: { 'android.intent.extra.alarm.HOUR': t.getHours(), 'android.intent.extra.alarm.MINUTES': t.getMinutes(), 'android.intent.extra.alarm.MESSAGE': String(args.label ?? ''), 'android.intent.extra.alarm.SKIP_UI': true },
        }).catch(() => { throw new AppError('failed'); });
        return `Alarm set for ${t.toLocaleTimeString()}.`;
      }
      // Desktop / iOS have no public alarm API: use a reminder notification instead.
      if (t && !isNaN(+t)) { await createReminder(String(args.label || 'Alarm'), t); return `This device cannot set system alarms, so I set a reminder for ${t.toLocaleTimeString()} instead.`; }
      throw new AppError('failed');
    }
    case 'createNote': {
      const notes = await loadNotes();
      await saveNotes([{ id: uid(), text: String(args.text ?? ''), ts: Date.now() }, ...notes]);
      return 'Note saved.';
    }
    case 'cameraScan':
    case 'cropDiseaseAnalysis':
      ctx.navigate('Agriculture');
      return 'Opened the crop scanner.';
    default:
      throw new AppError('failed');
  }
}
