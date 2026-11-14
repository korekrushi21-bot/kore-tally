// Plain-Marathi wording for the strategy's and risk engine's English reasons.
// Anything not recognised is shown as-is rather than guessed at.

const SIGNAL_RULES: [RegExp, (m: RegExpMatchArray) => string | null][] = [
  [/bullish trend alignment/i, () => "सरासरी भाव (EMA 9, 21, 50) वरच्या क्रमाने आहेत: कल वाढीचा आहे"],
  [/bearish trend alignment/i, () => "सरासरी भाव (EMA 9, 21, 50) खालच्या क्रमाने आहेत: कल घसरणीचा आहे"],
  [/RSI ([\d.]+) rising/i, (m) => `खरेदीचा जोर वाढतोय (RSI ${Math.round(Number(m[1]))}), पण अजून अति-खरेदी नाही`],
  [/RSI ([\d.]+) falling/i, (m) => `विक्रीचा जोर वाढतोय (RSI ${Math.round(Number(m[1]))}), पण अजून अति-विक्री नाही`],
  [/RSI ([\d.]+) overbought/i, (m) => `भाव खूप वेगात वाढलाय (RSI ${Math.round(Number(m[1]))}): इथून थोडा थांबू शकतो`],
  [/RSI ([\d.]+) oversold/i, (m) => `भाव खूप वेगात घसरलाय (RSI ${Math.round(Number(m[1]))}): इथून थोडा थांबू शकतो`],
  [/MACD line above/i, () => "गती (MACD) वाढीच्या बाजूने आहे आणि वाढतेय"],
  [/MACD line below/i, () => "गती (MACD) घसरणीच्या बाजूने आहे आणि वाढतेय"],
  [/above VWAP ([\d.]+)/i, (m) => `भाव सरासरी व्यवहार-भावाच्या (VWAP ₹${Number(m[1]).toFixed(0)}) वर: खरेदीदार वरचढ`],
  [/below VWAP ([\d.]+)/i, (m) => `भाव सरासरी व्यवहार-भावाच्या (VWAP ₹${Number(m[1]).toFixed(0)}) खाली: विक्रेते वरचढ`],
  [/Breakout above ([\d.]+)/i, (m) => `मागच्या 20 दिवसांचा उच्चांक ₹${Number(m[1]).toFixed(0)} जास्त व्यवहारांसह (volume) तोडला`],
  [/Breakdown below ([\d.]+)/i, (m) => `मागच्या 20 दिवसांचा नीचांक ₹${Number(m[1]).toFixed(0)} जास्त व्यवहारांसह (volume) तोडला`],
  [/Volatility regime: (\w+)/i, (m) => `भावातले रोजचे चढ-उतार: ${({ low: "कमी", normal: "सामान्य", high: "जास्त" } as Record<string, string>)[m[1]] ?? m[1]}`],
  [/No volume data/i, () => null],
];

export function signalReason(text: string): string | null {
  for (const [re, fn] of SIGNAL_RULES) {
    const m = text.match(re);
    if (m) return fn(m);
  }
  return text;
}

const RISK_RULES: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/max of (\d+) simultaneous/i, (m) => `एका वेळी जास्तीत जास्त ${m[1]} सराव trades चालू ठेवता येतात. आधी एखादा बंद होऊ द्या.`],
  [/already open/i, () => "या शेअरचा सराव trade आधीच चालू आहे."],
  [/Risk:reward/i, () => "संभाव्य नफा, संभाव्य तोट्याच्या दुप्पट नाही. म्हणून हा trade घेतला नाही."],
  [/Daily loss limit|daily limit/i, () => "आजची तोट्याची मर्यादा पूर्ण झाली. उद्या पुन्हा."],
  [/halted/i, () => "Emergency Stop चालू आहे. सराव trading थांबवलेलं आहे."],
  [/stale/i, () => "बाजाराचा data जुना आहे. ताज्या data शिवाय trade घेत नाही."],
  [/rounds to zero/i, () => "तुमच्या धोका-मर्यादेत एकही शेअर बसत नाही (stop खूप दूर आहे)."],
  [/no valid stop-loss/i, () => "Stop-loss ठरत नाही. Stop-loss शिवाय trade घेत नाही."],
  [/Not an actionable signal/i, () => "आत्ता या शेअरवर BUY किंवा SELL signal नाही."],
];

export function riskReason(text: string): string {
  for (const [re, fn] of RISK_RULES) {
    const m = text.match(re);
    if (m) return fn(m);
  }
  return text;
}

export function rupees(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function pctChange(from: number, to: number): string {
  const p = ((to - from) / from) * 100;
  return `${p > 0 ? "+" : ""}${p.toFixed(1)}%`;
}
