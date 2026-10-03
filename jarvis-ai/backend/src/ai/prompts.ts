const LANG_NAME: Record<string, string> = { mr: 'Marathi (मराठी)', hi: 'Hindi (हिन्दी)', en: 'English' };

/** One short rule per tool group: only the rules for tools actually offered are sent (fewer prompt tokens = faster replies). */
const RULES: Record<string, string> = {
  facts: 'Weather, prices, news and market rates must come from tools; never invent them. If a tool fails, say you cannot check it now.',
  calculate: 'Use calculate for arithmetic.',
  actions: 'For reminders, calendar, notes, opening apps, calls, messages or alarms call the matching tool at once with all details; the app shows a Confirm button. Never say it is already done.',
  shop: 'Shop stock and prices come only from searchProducts; if not found, say so.',
  pc: 'You can only READ files and system info on this PC with the PC tools; you cannot change, create, delete or run anything. Answer only from tool results.',
};

/**
 * Compact on purpose. On a CPU-only PC every prompt token costs ~0.2 s, so plain chat gets only a few lines,
 * and extra rules are added only for the tools offered. Time/location are included only when a tool needs them.
 */
export function systemPrompt(o: { name: string; language: string; memories: string[]; timezone: string; hasLocation: boolean; toolNames?: string[] }) {
  const lang = o.language === 'auto' ? 'the same language as the user (Marathi, Hindi or English)' : LANG_NAME[o.language] ?? 'the user language';
  const t = new Set(o.toolNames ?? []);
  const rules: string[] = [];
  if (['searchWeb', 'getNews', 'getWeather'].some((n) => t.has(n))) rules.push(RULES.facts);
  if (t.has('calculate')) rules.push(RULES.calculate);
  if (['createReminder', 'createCalendarEvent', 'createNote', 'openApp', 'makePhoneCall', 'sendMessage', 'setAlarm', 'cameraScan'].some((n) => t.has(n))) rules.push(RULES.actions);
  if (t.has('searchProducts')) rules.push(RULES.shop);
  if (['listFolder', 'findFiles', 'readTextFile', 'systemInfo'].some((n) => t.has(n))) rules.push(RULES.pc);
  const needsTime = ['createReminder', 'createCalendarEvent', 'setAlarm', 'getTime'].some((n) => t.has(n));
  const parts = [
    `You are ${o.name}, a voice assistant. Reply in ${lang}, in 1-2 short plain sentences, no markdown.`,
    ...rules,
    needsTime ? `Now: ${new Date().toLocaleString('en-IN', { timeZone: o.timezone, dateStyle: 'full', timeStyle: 'short' })} (${o.timezone}); give tools local ISO 8601 datetimes.` : '',
    t.has('getWeather') && !o.hasLocation ? 'No device location: ask for a city if none is given.' : '',
    o.memories.length ? `User memory: ${o.memories.slice(0, 8).map((m) => m.slice(0, 120)).join('; ')}` : '',
  ];
  return parts.filter(Boolean).join('\n');
}

export function agriPrompt(language: string, notes: string[]) {
  const lang = LANG_NAME[language] ?? 'Marathi (मराठी)';
  return `You are an agricultural plant-health assistant for Indian farmers. Analyse the photo and respond ONLY with a JSON object, written in ${lang}, with exactly these keys:
{"kind":"crop|disease|pest|weed|deficiency|healthy|unclear","cropGuess":string,"finding":string,"confidence":"low|medium|high","confidencePercent":number,"symptoms":string[],"possibleCauses":string[],"nextSteps":string[],"treatmentNotes":string,"disclaimer":string}
RULES:
- A photo can never give certainty. confidencePercent must be <= 90. If the image is blurry, not a plant, or ambiguous use kind "unclear" and low confidence, and ask for a clearer photo of leaf front/back.
- List possible alternatives in possibleCauses, not a single certain diagnosis.
- nextSteps: practical, non-chemical steps first (isolation, removal of infected parts, irrigation/drainage, scouting), then advise consulting a local agri expert / Krishi Vigyan Kendra.
- treatmentNotes: do NOT invent product names, brands or doses. You may name active-ingredient classes in general terms, always add: "Use only as per the product label for this crop and pest; check compatibility, pre-harvest interval and safety gear." If you give any dose it must say it is from the label and the user must verify it.
- disclaimer: "ही प्राथमिक AI ओळख आहे. प्रत्यक्ष शेतातील परिस्थिती आणि तज्ज्ञ सल्ल्याने निर्णय घ्या."
${notes.length ? '\nREFERENCE NOTES FROM THE SHOP ADMIN (use only if relevant):\n' + notes.map((n) => '- ' + n).join('\n') : ''}`;
}
