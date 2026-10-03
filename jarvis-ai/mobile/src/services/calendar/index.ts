import * as Calendar from 'expo-calendar';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { AppError } from '../../utils';
import { loadTasks, saveTasks, uid } from '../../storage/store';
import type { Task } from '../../types';

const web = Platform.OS === 'web';
if (!web) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
}

export async function ensureNotifications() {
  if (web) {
    if (typeof Notification === 'undefined') return false;
    return Notification.permission === 'granted' || (await Notification.requestPermission()) === 'granted';
  }
  const cur = await Notifications.getPermissionsAsync();
  if (cur.granted) return true;
  return (await Notifications.requestPermissionsAsync()).granted;
}

/** Local reminder: scheduled notification + a task entry. Fully on-device. */
export async function createReminder(title: string, when: Date): Promise<Task> {
  if (!(await ensureNotifications())) throw new AppError('failed', 'notifications disabled');
  if (when.getTime() <= Date.now()) throw new AppError('failed', 'time in the past');
  let notificationId: string;
  if (web) {
    // Browsers cannot schedule notifications for a closed tab: this fires only while the page stays open.
    const delay = when.getTime() - Date.now();
    if (delay > 2_147_000_000) throw new AppError('failed', 'too far');
    const h = setTimeout(() => new Notification('Reminder', { body: title }), delay);
    notificationId = 'web:' + String(h);
  } else {
    notificationId = await Notifications.scheduleNotificationAsync({
      content: { title: 'Reminder', body: title, sound: true },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: when },
    });
  }
  const task: Task = { id: uid(), title, done: false, due: when.getTime(), notificationId };
  await saveTasks([task, ...(await loadTasks())]);
  return task;
}

export async function cancelReminder(t: Task) {
  if (web) { if (t.notificationId?.startsWith('web:')) clearTimeout(Number(t.notificationId.slice(4)) as any); return; }
  if (t.notificationId) await Notifications.cancelScheduledNotificationAsync(t.notificationId).catch(() => {});
}

async function calendarId(): Promise<string> {
  if (web) throw new AppError('failed', 'calendar unavailable on desktop web');
  const p = await Calendar.requestCalendarPermissionsAsync();
  if (!p.granted) throw new AppError('failed', 'calendar permission');
  if (Platform.OS === 'ios') {
    const def = await Calendar.getDefaultCalendarAsync();
    return def.id;
  }
  const cals = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const w = cals.find((c) => c.allowsModifications);
  if (!w) throw new AppError('failed');
  return w.id;
}

export async function createCalendarEvent(title: string, start: Date, end?: Date, notes?: string) {
  const id = await calendarId();
  return Calendar.createEventAsync(id, { title, startDate: start, endDate: end ?? new Date(start.getTime() + 3600_000), notes, alarms: [{ relativeOffset: -10 }] });
}

export async function upcomingEvents(days = 7) {
  if (web) throw new AppError('failed', 'calendar unavailable on desktop web');
  const p = await Calendar.requestCalendarPermissionsAsync();
  if (!p.granted) throw new AppError('failed', 'calendar permission');
  const cals = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const now = new Date();
  return Calendar.getEventsAsync(cals.map((c) => c.id), now, new Date(now.getTime() + days * 86400_000));
}
