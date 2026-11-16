import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuthStatus, PaperAccount, PaperPositionDTO, ScanLatest, ScanResultDTO } from "../../types";
import { api, ApiError } from "../../api";
import {
  fromServerTime,
  marathiDate,
  marathiDateTime,
  pctChange,
  riskReason,
  rupees,
  signalReason,
} from "./translate";
import { Glossary } from "./Glossary";

// Same per-browser filters the detailed scan panel uses, so both views agree.
const PRICE_KEY = "scan.maxSharePrice";
const WIN_KEY = "scan.minWinRatePct";
const IDEAS_SHOWN = 5;

function readFilter(key: string, fallback: number): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === "" ? null : Number(raw) || null;
  } catch {
    return fallback;
  }
}

function writeFilter(key: string, value: number | null) {
  try {
    localStorage.setItem(key, value === null ? "" : String(value));
  } catch {
    /* per-browser convenience only */
  }
}

const VERDICT = {
  supports: { light: "🟢", text: "मागच्या 2 वर्षांत याच नियमांनी या शेअरवर नफा झाला", pill: "green" },
  mixed: { light: "🟡", text: "मागच्या 2 वर्षांत साधारण बरोबरी (ना नफा ना तोटा)", pill: "amber" },
  against: { light: "🔴", text: "मागच्या 2 वर्षांत याच नियमांनी या शेअरवर तोटा झाला", pill: "red" },
  too_few: { light: "⚪", text: "मागचे trades खूप कमी, अंदाज लावता येत नाही", pill: "neutral" },
  "": { light: "⚪", text: "माहिती नाही", pill: "neutral" },
} as const;

export function SimpleView({
  authStatus,
  account,
  trades,
  onRefresh,
}: {
  authStatus: AuthStatus | null;
  account: PaperAccount | null;
  trades: PaperPositionDTO[];
  onRefresh: () => void;
}) {
  const connected = authStatus?.connected ?? false;
  const [scan, setScan] = useState<ScanLatest | null>(null);
  const [maxPrice, setMaxPrice] = useState<number | null>(() => readFilter(PRICE_KEY, 500));
  const [minWin, setMinWin] = useState<number | null>(() => readFilter(WIN_KEY, 50));

  const loadScan = useCallback(async () => {
    try {
      setScan(await api.scanLatest());
    } catch {
      /* backend unreachable; the steps box shows it */
    }
  }, []);
  useEffect(() => {
    loadScan();
  }, [loadScan]);
  const scanRunning = scan?.run?.status === "RUNNING" || !!scan?.in_progress;
  useEffect(() => {
    if (!scanRunning) return;
    const id = setInterval(loadScan, 4000);
    return () => clearInterval(id);
  }, [scanRunning, loadScan]);

  const signals = useMemo(
    () => (scan?.results ?? []).filter((r) => r.action === "BUY" || r.action === "SELL"),
    [scan]
  );
  const ideas = useMemo(
    () =>
      signals
        .filter((r) => maxPrice === null || (r.last_close ?? Infinity) <= maxPrice)
        .filter(
          (r) =>
            minWin === null ||
            (r.backtest.trades >= 5 && r.backtest.win_rate !== null && r.backtest.win_rate * 100 > minWin)
        )
        .slice(0, IDEAS_SHOWN),
    [signals, maxPrice, minWin]
  );
  const symbols = useMemo(() => {
    const map: Record<string, string> = {};
    for (const r of scan?.results ?? []) map[r.instrument_key] = r.symbol;
    return map;
  }, [scan]);

  const capital = account?.starting_capital ?? 100_000;
  const riskPct = account?.risk_per_trade_pct ?? 0.01;
  const riskBudget = capital * riskPct;

  function setPrice(v: number | null) {
    setMaxPrice(v);
    writeFilter(PRICE_KEY, v);
  }
  function setWin(v: number | null) {
    setMinWin(v);
    writeFilter(WIN_KEY, v);
  }

  return (
    <div className="simple">
      <Steps connected={connected} scan={scan} account={account} trades={trades} onScan={loadScan} />

      <div className="card simple-safety">
        <h2>🛡️ तुमचं संरक्षण: हे app काय करत नाही</h2>
        <ul>
          <li>
            इथे सगळे trades <strong>सराव (paper)</strong> आहेत: खोटे पैसे, खरे भाव. तुमच्या Upstox खात्यातून एक रुपयाही
            जात नाही.
          </li>
          <li>
            प्रत्येक सराव trade मध्ये जास्तीत जास्त <strong>{rupees(riskBudget)}</strong> धोका ({(riskPct * 100).toFixed(1)}%
            of {rupees(capital)}). एका वेळी जास्तीत जास्त {account?.max_open_positions ?? 3} trades.
          </li>
          <li>
            इथल्या कल्पना म्हणजे <strong>नियमांवर आधारित संकेत</strong> आहेत, सल्ला किंवा नफ्याची खात्री नाही. आधी किमान 2–4
            आठवडे सराव करा.
          </li>
        </ul>
      </div>

      <BuyTodayCard scan={scan} riskBudget={riskBudget} connected={connected} onTraded={onRefresh} />

      <div className="card">
        <h2>💡 आजच्या कल्पना</h2>
        <p className="muted">
          रोज सकाळी 9 वाजता app सगळे F&amp;O शेअर्स तपासतो. खाली फक्त तुमच्या अटी पूर्ण करणारे पहिले {IDEAS_SHOWN} दाखवले
          आहेत.
        </p>
        <div className="row simple-filters">
          <span className="muted">तुमच्या अटी:</span>
          <FilterChip
            on={maxPrice !== null}
            label={maxPrice !== null ? `शेअरचा भाव ≤ ${rupees(maxPrice)}` : "कोणताही भाव"}
            onToggle={() => setPrice(maxPrice === null ? 500 : null)}
          />
          <FilterChip
            on={minWin !== null}
            label={minWin !== null ? `मागचा जिंकण्याचा दर > ${minWin}%` : "कोणताही जिंकण्याचा दर"}
            onToggle={() => setWin(minWin === null ? 50 : null)}
          />
        </div>

        {!scan?.run && <p>अजून scan झालेला नाही. वर "आजचा scan चालवा" दाबा.</p>}
        {scan?.run?.status === "DONE" && ideas.length === 0 && (
          <div className="simple-empty">
            <p>
              <strong>आज तुमच्या अटींमध्ये एकही कल्पना बसत नाही.</strong> आज एकूण {signals.length} शेअर्सवर संकेत आले, पण
              त्यापैकी एकही दोन्ही अटी पूर्ण करत नाही.
            </p>
            <p className="muted">
              अटी पूर्ण न करणारे trades app दाखवत नाही. काहीच न करणं हा सुद्धा एक चांगला निर्णय असतो. वरच्या अटींवर क्लिक
              करून त्या बदलू शकता.
            </p>
          </div>
        )}
        <div className="simple-ideas">
          {ideas.map((r) => (
            <IdeaCard key={r.instrument_key} r={r} riskBudget={riskBudget} connected={connected} onTraded={onRefresh} />
          ))}
        </div>
      </div>

      <MyPractice account={account} trades={trades} symbols={symbols} connected={connected} onRefresh={onRefresh} />

      <div className="card">
        <h2>📘 शब्दकोश: हे शब्द म्हणजे काय?</h2>
        <Glossary />
      </div>
    </div>
  );
}

function Steps({
  connected,
  scan,
  account,
  trades,
  onScan,
}: {
  connected: boolean;
  scan: ScanLatest | null;
  account: PaperAccount | null;
  trades: PaperPositionDTO[];
  onScan: () => void;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = scan?.run;
  const todayDone =
    run?.status === "DONE" && fromServerTime(run.started_at)?.toDateString() === new Date().toDateString();
  const openCount = account?.open_positions.length ?? 0;

  async function startScan() {
    setStarting(true);
    setError(null);
    try {
      await api.scanRun();
      onScan();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Scan सुरू झाला नाही");
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="card">
      <h2>आजचं काम, 4 पायऱ्यांमध्ये</h2>
      <ol className="simple-steps">
        <li className={connected ? "done" : "todo"}>
          <strong>Upstox जोडा</strong>
          {connected ? (
            <span> ✅ जोडलेलं आहे. रोज रात्री आपोआप सुटतं, उद्या पुन्हा जोडावं लागेल.</span>
          ) : (
            <span>
              {" "}
              रोज एकदा लागतं.{" "}
              <a className="button primary" href={api.loginUrl()}>
                Upstox ने login करा
              </a>
            </span>
          )}
        </li>
        <li className={todayDone ? "done" : "todo"}>
          <strong>आजचा scan</strong>
          {run?.status === "RUNNING" || scan?.in_progress ? (
            <span> ⏳ चालू आहे, साधारण 2 मिनिटं…</span>
          ) : todayDone ? (
            <span> ✅ आज झाला ({run?.data_date} पर्यंतचा data).</span>
          ) : (
            <span>
              {" "}
              सकाळी 9 ला आपोआप होतो. आत्ता हवा असेल तर:{" "}
              <button className="primary" disabled={starting} onClick={startScan}>
                आजचा scan चालवा
              </button>
            </span>
          )}
        </li>
        <li className={openCount > 0 ? "done" : "todo"}>
          <strong>एखादी कल्पना निवडून सराव करा</strong>
          <span> खाली "आजच्या कल्पना" मध्ये. {openCount > 0 && `✅ ${openCount} सराव trades चालू.`}</span>
        </li>
        <li className={trades.length > 0 ? "done" : "todo"}>
          <strong>निकाल पाहा आणि शिका</strong>
          <span> "माझे सराव trades" मध्ये. रोज एकदा "आत्ता तपासा" दाबा.</span>
        </li>
      </ol>
      {error && <div className="error-banner">{error}</div>}
    </div>
  );
}

function FilterChip({ on, label, onToggle }: { on: boolean; label: string; onToggle: () => void }) {
  return (
    <button className={`chip ${on ? "chip-on" : ""}`} onClick={onToggle} title="अट चालू/बंद करण्यासाठी क्लिक करा">
      {on ? "✓ " : ""}
      {label}
    </button>
  );
}

function IdeaCard({
  r,
  riskBudget,
  connected,
  onTraded,
}: {
  r: ScanResultDTO;
  riskBudget: number;
  connected: boolean;
  onTraded: () => void;
}) {
  const [showWhy, setShowWhy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string[] } | null>(null);
  const v = VERDICT[r.backtest.verdict] ?? VERDICT[""];
  const isBuy = r.action === "BUY";
  const entry = r.entry_price ?? r.last_close ?? 0;
  const stop = r.stop_loss ?? 0;
  const target = r.target ?? 0;
  const riskPerShare = Math.abs(entry - stop);
  const shares = riskPerShare > 0 ? Math.floor(riskBudget / riskPerShare) : 0;
  const reasons = r.reasons.map(signalReason).filter((x): x is string => !!x);

  async function practise() {
    setBusy(true);
    setResult(null);
    try {
      const res = await api.paperEvaluate(r.instrument_key);
      const er = res.entry_result;
      if (er.action === "opened" && er.position) {
        setResult({
          ok: true,
          text: [
            `सराव trade सुरू: ${er.position.quantity} शेअर्स @ ${rupees(er.position.entry_price, 2)}.`,
            `Stop ${rupees(er.position.stop_loss, 2)} / लक्ष्य ${rupees(er.position.target, 2)}. "माझे सराव trades" मध्ये दिसेल.`,
          ],
        });
        onTraded();
      } else if (er.action === "no_trade") {
        setResult({ ok: false, text: ["आत्ताच्या भावावर हा संकेत राहिलेला नाही, त्यामुळे trade घेतला नाही."] });
      } else {
        setResult({ ok: false, text: (er.reasons ?? ["Trade घेतला नाही."]).map(riskReason) });
      }
    } catch (e) {
      setResult({ ok: false, text: [e instanceof ApiError ? e.message : "काहीतरी चुकलं, पुन्हा प्रयत्न करा."] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`simple-idea ${v.pill}`}>
      <div className="simple-idea-head">
        <div>
          <div className="simple-symbol">{r.symbol}</div>
          <div className="muted">{r.name}</div>
        </div>
        <span className={`pill ${isBuy ? "green" : "red"}`}>{isBuy ? "📈 भाव वाढेल असा संकेत" : "📉 भाव घटेल असा संकेत"}</span>
      </div>

      <div className="simple-light">
        {v.light} {v.text}
        <span className="muted">
          {" "}
          ({r.backtest.trades} trades, {r.backtest.win_rate !== null ? `${Math.round(r.backtest.win_rate * 100)}% जिंकले` : "—"})
        </span>
      </div>

      {!isBuy && (
        <p className="simple-warn">
          ⚠ SELL म्हणजे भाव पडण्यावर पैसे लावणं (short). नवशिक्यांसाठी हे अवघड आहे. फक्त सराव म्हणून पाहा.
        </p>
      )}

      <div className="simple-levels">
        <div>
          <div className="label">{isBuy ? "खरेदी सुमारे" : "विक्री सुमारे"}</div>
          <div className="value">{rupees(entry, 2)}</div>
        </div>
        <div>
          <div className="label">चूक झाली तर इथे बाहेर (stop-loss)</div>
          <div className="value text-red">
            {rupees(stop, 2)} <small>({pctChange(entry, stop)})</small>
          </div>
        </div>
        <div>
          <div className="label">बरोबर ठरलं तर इथे नफा (target)</div>
          <div className="value text-green">
            {rupees(target, 2)} <small>({pctChange(entry, target)})</small>
          </div>
        </div>
      </div>

      <p className="simple-math">
        {rupees(riskBudget)} धोका ठेवला तर: <strong>{shares} शेअर्स</strong> (गुंतवणूक सुमारे {rupees(shares * entry)}).
        Stop लागला तर तोटा सुमारे <span className="text-red">{rupees(shares * riskPerShare)}</span>, target लागला तर नफा
        सुमारे <span className="text-green">{rupees(shares * Math.abs(target - entry))}</span>.
      </p>

      <div className="row">
        <button className="primary" disabled={!connected || busy} onClick={practise}>
          {busy ? "तपासतोय…" : "🧪 याचा सराव करा (खोटे पैसे)"}
        </button>
        <button onClick={() => setShowWhy(!showWhy)}>{showWhy ? "कारणं लपवा" : "हा संकेत का?"}</button>
      </div>
      {!connected && <p className="muted">सराव करण्यासाठी आधी Upstox जोडा (आत्ताचा भाव तपासण्यासाठी).</p>}
      {result && <div className={result.ok ? "simple-ok" : "simple-no"}>{result.text.map((t, i) => <p key={i}>{t}</p>)}</div>}
      {showWhy && (
        <ul className="reasons">
          {reasons.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MyPractice({
  account,
  trades,
  symbols,
  connected,
  onRefresh,
}: {
  account: PaperAccount | null;
  trades: PaperPositionDTO[];
  symbols: Record<string, string>;
  connected: boolean;
  onRefresh: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const open = account?.open_positions ?? [];
  const won = trades.filter((t) => (t.realized_pnl ?? 0) > 0).length;
  const net = trades.reduce((s, t) => s + (t.realized_pnl ?? 0), 0);
  const name = (p: PaperPositionDTO) => p.option?.trading_symbol || symbols[p.instrument_key] || p.instrument_key;

  async function checkNow() {
    setChecking(true);
    setMessage(null);
    try {
      const res = await api.paperCheckExits();
      if (res.checked === 0) setMessage("तपासायला एकही stock सराव trade चालू नाही.");
      else if (res.closed.length === 0) setMessage(`${res.checked} trades तपासले. अजून कोणताही stop किंवा target लागलेला नाही.`);
      else
        setMessage(
          `${res.closed.length} trade बंद झाले: ` +
            res.closed
              .map((c) => `${name(c)} (${c.exit_reason === "target" ? "target ✅" : "stop-loss ❌"} ${rupees(c.realized_pnl)})`)
              .join(", ")
        );
      onRefresh();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : "तपासता आलं नाही.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="card">
      <h2>🧾 माझे सराव trades</h2>
      <div className="grid" style={{ marginBottom: 10 }}>
        <div className="stat">
          <div className="label">सराव खात्यातले पैसे</div>
          <div className="value">{rupees(account?.net_equity)}</div>
        </div>
        <div className="stat">
          <div className="label">पूर्ण झालेले trades</div>
          <div className="value">
            {trades.length} <small className="muted">({won} नफ्यात)</small>
          </div>
        </div>
        <div className="stat">
          <div className="label">एकूण नफा / तोटा</div>
          <div className={`value ${net >= 0 ? "text-green" : "text-red"}`}>{rupees(net)}</div>
        </div>
      </div>

      <div className="row">
        <button className="primary" disabled={!connected || checking || open.length === 0} onClick={checkNow}>
          {checking ? "तपासतोय…" : "🔄 आत्ता तपासा (stop/target लागला का?)"}
        </button>
        <span className="muted">बाजार चालू असताना दिवसातून एकदा दाबा.</span>
      </div>
      {message && <p>{message}</p>}

      {open.length === 0 ? (
        <p className="muted">सध्या एकही सराव trade चालू नाही.</p>
      ) : (
        <div className="simple-positions">
          {open.map((p) => {
            const mark = p.mark_price ?? p.entry_price;
            const pnl = p.unrealized_pnl ?? 0;
            const span = Math.abs(p.target - p.stop_loss) || 1;
            const progress = Math.min(100, Math.max(0, ((mark - p.stop_loss) / (p.target - p.stop_loss)) * 100));
            return (
              <div key={p.id} className="simple-pos">
                <div className="simple-idea-head">
                  <strong>{name(p)}</strong>
                  <span className={pnl >= 0 ? "text-green" : "text-red"}>
                    {pnl >= 0 ? "+" : ""}
                    {rupees(pnl)}
                  </span>
                </div>
                <div className="muted">
                  {p.quantity} @ {rupees(p.entry_price, 2)} · आत्ता {rupees(mark, 2)}
                </div>
                <div className="simple-bar" title={`stop ${p.stop_loss} ← → target ${p.target} (span ${span.toFixed(0)})`}>
                  <div style={{ width: `${progress}%` }} />
                </div>
                <div className="simple-bar-labels">
                  <span className="text-red">stop {rupees(p.stop_loss)}</span>
                  <span className="text-green">target {rupees(p.target)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const BUY_TODAY_MAX_PRICE = 200;

/** BUY signals on shares under Rs 200 whose 2-year backtest was profitable,
 *  stamped with the scan's date and time. */
function BuyTodayCard({
  scan,
  riskBudget,
  connected,
  onTraded,
}: {
  scan: ScanLatest | null;
  riskBudget: number;
  connected: boolean;
  onTraded: () => void;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const run = scan?.run;
  const all = scan?.results ?? [];
  const cheap = all.filter((r) => r.last_close !== null && r.last_close < BUY_TODAY_MAX_PRICE);
  const rows = cheap.filter((r) => r.action === "BUY" && r.backtest.verdict === "supports");
  const cheapBuysLosing = cheap.filter((r) => r.action === "BUY" && r.backtest.verdict !== "supports");
  const watch = cheap.filter((r) => r.action !== "BUY" && r.backtest.verdict === "supports");

  async function practise(r: ScanResultDTO) {
    setBusyKey(r.instrument_key);
    try {
      const res = await api.paperEvaluate(r.instrument_key);
      const er = res.entry_result;
      const note =
        er.action === "opened" && er.position
          ? `सराव सुरू: ${er.position.quantity} शेअर्स @ ${rupees(er.position.entry_price, 2)}`
          : er.action === "no_trade"
          ? "आत्ताच्या भावावर संकेत राहिलेला नाही."
          : (er.reasons ?? ["घेतला नाही."]).map(riskReason).join(" ");
      setNotes((n) => ({ ...n, [r.instrument_key]: note }));
      if (er.action === "opened") onTraded();
    } catch (e) {
      setNotes((n) => ({ ...n, [r.instrument_key]: e instanceof ApiError ? e.message : "काहीतरी चुकलं." }));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="card buy-today">
      <h2>📅 आज खरेदी: ₹{BUY_TODAY_MAX_PRICE} खालचे, backtest मध्ये फायदेशीर</h2>
      <p className="buy-today-date">
        {run ? (
          <>
            Scan: <strong>{marathiDateTime(fromServerTime(run.finished_at ?? run.started_at))}</strong> · भाव{" "}
            <strong>{marathiDate(run.data_date)}</strong> च्या closing पर्यंतचे
            {(run.status === "RUNNING" || scan?.in_progress) &&
              " · ⏳ नवीन scan चालू आहे, तोपर्यंत ही मागच्या scan ची यादी"}
          </>
        ) : (
          "अजून scan झालेला नाही."
        )}
      </p>

      {run?.status === "DONE" && rows.length === 0 && (
        <div className="simple-empty">
          <p>
            <strong>आज या यादीत एकही शेअर नाही.</strong> ₹{BUY_TODAY_MAX_PRICE} खालचे {cheap.length} F&amp;O शेअर्स
            तपासले.
            {cheapBuysLosing.length > 0 &&
              ` ${cheapBuysLosing.length} वर BUY संकेत आला (${cheapBuysLosing
                .map((r) => r.symbol)
                .join(", ")}), पण त्यांचा backtest फायदेशीर नाही, म्हणून इथे दाखवले नाहीत.`}
          </p>
          {watch.length > 0 && (
            <p>
              👀 <strong>लक्ष ठेवा:</strong> {watch.map((r) => `${r.symbol} (${rupees(r.last_close, 2)})`).join(", ")}.
              यांचा backtest फायदेशीर आहे, पण आज BUY संकेत नाही. संकेत आला की ते इथे दिसतील.
            </p>
          )}
        </div>
      )}

      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>शेअर</th>
                <th>भाव</th>
                <th>खरेदी सुमारे</th>
                <th>Stop-loss</th>
                <th>Target</th>
                <th>₹{Math.round(riskBudget).toLocaleString("en-IN")} धोक्यात</th>
                <th>मागचे 2 वर्ष</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const entry = r.entry_price ?? r.last_close ?? 0;
                const perShare = Math.abs(entry - (r.stop_loss ?? entry));
                const shares = perShare > 0 ? Math.floor(riskBudget / perShare) : 0;
                return (
                  <tr key={r.instrument_key}>
                    <td>
                      <strong>{r.symbol}</strong>
                      <div className="muted">{r.name}</div>
                    </td>
                    <td>{rupees(r.last_close, 2)}</td>
                    <td>{rupees(entry, 2)}</td>
                    <td className="text-red">
                      {rupees(r.stop_loss, 2)} <small>({pctChange(entry, r.stop_loss ?? entry)})</small>
                    </td>
                    <td className="text-green">
                      {rupees(r.target, 2)} <small>({pctChange(entry, r.target ?? entry)})</small>
                    </td>
                    <td>
                      {shares} शेअर्स
                      <div className="muted">≈ {rupees(shares * entry)}</div>
                    </td>
                    <td>
                      🟢 {r.backtest.trades} trades,{" "}
                      {r.backtest.win_rate !== null ? Math.round(r.backtest.win_rate * 100) : "—"}% जिंकले
                      <div className="muted">{rupees(r.backtest.net_pnl)} नफा</div>
                    </td>
                    <td>
                      <button
                        className="primary"
                        disabled={!connected || busyKey === r.instrument_key}
                        onClick={() => practise(r)}
                      >
                        🧪 सराव
                      </button>
                      {notes[r.instrument_key] && <div className="muted">{notes[r.instrument_key]}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted">
        "फायदेशीर" म्हणजे याच नियमांनी या शेअरवर मागच्या 2 वर्षांत नफा झाला असता. भविष्याची खात्री नाही. आधी सराव करा.
      </p>
    </div>
  );
}
