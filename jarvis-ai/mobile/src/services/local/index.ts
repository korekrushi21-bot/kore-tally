import { calculate } from '../../utils/calc';
import { currentCoords, describeCode, fetchWeather, geocode } from '../weather';
import { uid } from '../../storage/store';
import type { ClientAction, Settings } from '../../types';

export interface LocalReply { text: string; actions?: ClientAction[] }

type L = 'mr' | 'hi' | 'en';
const say = (l: L, en: string, mr: string, hi: string) => (l === 'mr' ? mr : l === 'hi' ? hi : en);

// Marathi/Devanagari digits -> ASCII so "२५०००" works
const ascii = (s: string) => s.replace(/[०-९]/g, (d) => String('०१२३४५६७८९'.indexOf(d)));

/**
 * Rule-based assistant used when no AI is available (no key, offline, or backend down).
 * Handles only what can be answered exactly: maths, time/date, weather, notes, reminders.
 * Returns null when the request needs the real AI.
 */
export async function localAssistant(raw: string, lang: L, s: Settings): Promise<LocalReply | null> {
  const text = ascii(raw.trim());
  const t = text.toLowerCase();

  // ---- maths: "18% of 25000", "25000 चं 18 टक्के", "12*(3+4)" ----
  const pct = t.match(/(\d+(?:\.\d+)?)\s*(?:%|percent|टक्के|प्रतिशत)\s*(?:of|च[ंं्]?|का)?\s*(\d+(?:\.\d+)?)/)
    ?? null;
  const pct2 = t.match(/(\d+(?:\.\d+)?)\s*(?:च[ंं]|चे|चा|का|की|of)\s*(\d+(?:\.\d+)?)\s*(?:%|percent|टक्के|प्रतिशत)/);
  try {
    if (pct2) { const r = calculate(`${pct2[2]}/100*${pct2[1]}`); return { text: fmtNum(r, lang, `${pct2[2]}% of ${pct2[1]}`) }; }
    if (pct && /(%|percent|टक्के|प्रतिशत)/.test(t)) { const r = calculate(`${pct[1]}/100*${pct[2]}`); return { text: fmtNum(r, lang, `${pct[1]}% of ${pct[2]}`) }; }
    const expr = text.replace(/[^\d+\-*/().^%x×÷ ]/g, '').trim();
    if (/\d\s*[+\-*/^x×÷]\s*\d/.test(expr) && /(calc|math|गणित|किती|कितना|how much|what is|=|^[\d\s+\-*/().^x×÷%]+$)/.test(t)) {
      return { text: fmtNum(calculate(expr), lang, expr) };
    }
  } catch { /* fall through */ }

  // ---- time / date ----
  if (/(what('| i)?s the time|current time|time now|what time|आत्ता.*(वेळ|किती वाजले)|किती वाजले|वेळ काय|समय क्या|कितने बजे|today'?s date|आजची तारीख|आज की तारीख)/.test(t)) {
    return { text: new Date().toLocaleString(lang === 'en' ? 'en-IN' : lang === 'mr' ? 'mr-IN' : 'hi-IN', { dateStyle: 'full', timeStyle: 'short' }) };
  }

  // ---- reminder: "remind me in 30 minutes to call dad" / "३० मिनिटांनी ... आठवण करून दे" ----
  const rem = t.match(/(?:remind me|reminder|आठवण|याद दिला|याद दिलाना)/);
  if (rem) {
    const m = t.match(/(\d+)\s*(min|minute|minutes|मिनिट|मिनट|hour|hours|तास|घंटे|घंटा)/);
    if (m) {
      const n = parseInt(m[1], 10);
      const mins = /h|तास|घंट/.test(m[2]) ? n * 60 : n;
      const title = text.replace(/remind me|in\s+\d+\s*\w+|to\b|\d+\s*(मिनिटांनी|मिनिटाने|मिनट में|तासांनी|घंटे में)|आठवण करून दे|आठवण करा|याद दिला(ओ|ना)?/gi, ' ').replace(/\s+/g, ' ').trim() || 'Reminder';
      const when = new Date(Date.now() + mins * 60000);
      return { text: say(lang, `I can set a reminder in ${mins} minutes. Please confirm.`, `मी ${mins} मिनिटांनी आठवण लावू शकतो. कृपया पुष्टी करा.`, `मैं ${mins} मिनट बाद याद दिला सकता हूँ। कृपया पुष्टि करें।`),
        actions: [{ id: uid(), tool: 'createReminder', args: { title, whenIso: when.toISOString() }, summary: `Reminder “${title}” at ${when.toLocaleTimeString()}?`, requiresConfirmation: true }] };
    }
    return { text: say(lang, 'Tell me when, e.g. “remind me in 30 minutes to call Dad”. For exact times like “tomorrow 8 am” I need the AI, or use the Reminders screen.', 'वेळ सांगा, उदा. “३० मिनिटांनी आठवण करून दे”. “उद्या सकाळी ८” सारख्या वेळेसाठी AI लागते किंवा Reminders स्क्रीन वापरा.', 'समय बताइए, जैसे “30 मिनट बाद याद दिलाओ”. “कल सुबह 8” जैसे समय के लिए AI चाहिए या Reminders स्क्रीन इस्तेमाल करें।') };
  }

  // ---- note ----
  const note = text.match(/^(?:make a note|take a note|note|नोट|note kar|नोंद)\s*[:\-]?\s*(.+)$/i);
  if (note) {
    return { text: say(lang, 'Save this note? Please confirm.', 'ही नोट सेव्ह करू का? पुष्टी करा.', 'यह नोट सेव करूँ? पुष्टि करें।'),
      actions: [{ id: uid(), tool: 'createNote', args: { text: note[1] }, summary: `Save note: “${note[1].slice(0, 60)}”?`, requiresConfirmation: true }] };
  }

  // ---- weather ----
  if (/(weather|rain|temperature|forecast|हवामान|पाऊस|तापमान|मौसम|बारिश|तापमान)/.test(t)) {
    try {
      let lat: number, lon: number, place: string;
      const city = text.match(/(?:in|at|for)\s+([A-Za-z][A-Za-z ]{2,30})$/i)?.[1]?.trim()
        ?? text.match(/([ऀ-ॿ]{3,})\s*(?:मध्ये|मधील|में|का|चं|चे)/)?.[1];
      if (city && !/^(the|today|tomorrow|my)$/i.test(city)) {
        const g = await geocode(city);
        if (!g[0]) return { text: say(lang, `I could not find “${city}”.`, `“${city}” सापडले नाही.`, `“${city}” नहीं मिला।`) };
        ({ lat, lon } = g[0]); place = g[0].name;
      } else if (s.manualLocation) { ({ lat, lon } = s.manualLocation); place = s.manualLocation.name; }
      else { ({ lat, lon } = await currentCoords()); place = say(lang, 'your location', 'तुमचे स्थान', 'आपका स्थान'); }
      const w = await fetchWeather(lat, lon, place);
      const tom = w.daily[1];
      return { text: say(lang,
        `${w.place}: ${Math.round(w.current.temp)}°C, ${describeCode(w.current.code)}, humidity ${w.current.humidity}%, wind ${Math.round(w.current.wind)} km/h. Chance of rain now ${w.current.rainProb}%, today up to ${w.daily[0].rain}%${tom ? `. Tomorrow ${Math.round(tom.min)}–${Math.round(tom.max)}°C, rain ${tom.rain}%` : ''}.`,
        `${w.place}: ${Math.round(w.current.temp)}°C, आर्द्रता ${w.current.humidity}%, वारा ${Math.round(w.current.wind)} किमी/तास. सध्या पावसाची शक्यता ${w.current.rainProb}%, आज जास्तीत जास्त ${w.daily[0].rain}%${tom ? `. उद्या ${Math.round(tom.min)}–${Math.round(tom.max)}°C, पाऊस ${tom.rain}%` : ''}.`,
        `${w.place}: ${Math.round(w.current.temp)}°C, नमी ${w.current.humidity}%, हवा ${Math.round(w.current.wind)} किमी/घंटा. अभी बारिश की संभावना ${w.current.rainProb}%, आज अधिकतम ${w.daily[0].rain}%${tom ? `. कल ${Math.round(tom.min)}–${Math.round(tom.max)}°C, बारिश ${tom.rain}%` : ''}.`) };
    } catch {
      return { text: say(lang, 'I could not get the weather. Check your connection and location permission, or pick a city on the Weather screen.', 'हवामान मिळाले नाही. इंटरनेट व लोकेशन परवानगी तपासा किंवा Weather स्क्रीनवर शहर निवडा.', 'मौसम नहीं मिला। इंटरनेट और लोकेशन अनुमति जाँचें या Weather स्क्रीन पर शहर चुनें।') };
    }
  }
  return null;
}

function fmtNum(n: number, lang: L, label: string) {
  const v = Math.round(n * 1e6) / 1e6;
  const out = v.toLocaleString('en-IN');
  return say(lang, `${label} = ${out}`, `${label} = ${out}`, `${label} = ${out}`);
}

export const NO_AI_HELP = (lang: L) => say(lang,
  'AI chat is not set up yet, so I can only do maths, time, weather, simple notes and reminders. Add an AI key to the backend to unlock everything else.',
  'AI चॅट अजून सेट केलेले नाही, त्यामुळे मी फक्त गणित, वेळ, हवामान, नोट्स व रिमाइंडर करू शकतो. बाकी सर्वासाठी बॅकएंडमध्ये AI की जोडा.',
  'AI चैट अभी सेट नहीं है, इसलिए मैं केवल गणित, समय, मौसम, नोट्स और रिमाइंडर कर सकता हूँ। बाकी सब के लिए बैकएंड में AI की जोड़ें।');
