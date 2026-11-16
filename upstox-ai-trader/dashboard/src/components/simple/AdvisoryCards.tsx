import { useCallback, useEffect, useMemo, useState } from "react";
import type { ScanLatest, ScanResultDTO } from "../../types";
import { api, ApiError } from "../../api";
import { fromServerTime, riskReason, rupees } from "./translate";

// Idea cards in the familiar broker "advisory" layout: created time, name,
// live price and change, Stop-loss / Entry / Target and Potential.
// Potential = (target - live price) / live price, the same way Upstox's
// advisory cards compute it (e.g. target 65, price 30.20 -> 114.9%).

type Tab = "stocks" | "fno" | "cheap";
const CHEAP = 500;
const LTP_BATCH = 50;
const REFRESH_MS = 15_000;

interface Card {
  key: string; // instrument whose live price we show
  title: string;
  sub: string;
  side: "BUY" | "SELL";
  entry: number;
  stop: number;
  target: number;
  closePrice: number; // reference for the change when the live price arrives
  verdict: string;
  winRate: number | null;
  trades: number;
  stockKey: string;
  optionNote?: string; // F&O cards: why the app won't size or practise it
}

function stockCard(r: ScanResultDTO): Card | null {
  if (!r.entry_price || !r.stop_loss || !r.target || (r.action !== "BUY" && r.action !== "SELL")) return null;
  return {
    key: r.instrument_key,
    title: r.symbol,
    sub: `NSE शेअर · ${r.action === "BUY" ? "खरेदी" : "विक्री (short)"}`,
    side: r.action,
    entry: r.entry_price,
    stop: r.stop_loss,
    target: r.target,
    closePrice: r.last_close ?? r.entry_price,
    verdict: r.backtest.verdict,
    winRate: r.backtest.win_rate,
    trades: r.backtest.trades,
    stockKey: r.instrument_key,
  };
}

function optionCard(r: ScanResultDTO): Card | null {
  const p = r.option_plan;
  if (!p?.contract || !p.premium || !p.exit) return null;
  return {
    key: p.contract.instrument_key,
    title: p.contract.trading_symbol,
    sub: `Option खरेदी · lot ${p.contract.lot_size} · expiry ${p.contract.expiry}`,
    side: "BUY", // options are only ever bought in this app
    entry: p.premium,
    stop: p.exit.stop_premium_est,
    target: p.exit.target_premium_est,
    closePrice: p.premium,
    verdict: r.backtest.verdict,
    winRate: r.backtest.win_rate,
    trades: r.backtest.trades,
    stockKey: r.instrument_key,
    optionNote:
      p.status === "too_big"
        ? `lot मोठा: 1 lot मध्ये ${rupees(p.one_lot_risk)} धोका`
        : "सराव: सविस्तर मोड → Options",
  };
}

const VERDICT_TEXT: Record<string, { text: string; cls: string }> = {
  supports: { text: "🟢 मागे नफा", cls: "green" },
  mixed: { text: "🟡 मागे बरोबरी", cls: "amber" },
  against: { text: "🔴 मागे तोटा", cls: "red" },
  too_few: { text: "⚪ trades कमी", cls: "neutral" },
};

export function AdvisoryCards({ scan, connected }: { scan: ScanLatest | null; connected: boolean }) {
  const [tab, setTab] = useState<Tab>("stocks");
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const signals = useMemo(
    () => (scan?.results ?? []).filter((r) => r.action === "BUY" || r.action === "SELL"),
    [scan]
  );
  const decks = useMemo(() => {
    const stocks = signals.map(stockCard).filter((c): c is Card => !!c);
    return {
      stocks,
      fno: signals.map(optionCard).filter((c): c is Card => !!c),
      cheap: stocks.filter((c) => c.closePrice < CHEAP),
    };
  }, [signals]);
  const cards = decks[tab];

  const refresh = useCallback(async () => {
    if (!connected) return;
    const keys = [...new Set([...decks.stocks, ...decks.fno].map((c) => c.key))];
    const next: Record<string, number> = {};
    for (let i = 0; i < keys.length; i += LTP_BATCH) {
      try {
        Object.assign(next, (await api.marketLtp(keys.slice(i, i + LTP_BATCH))).prices);
      } catch {
        /* keep closing prices for this batch */
      }
    }
    setPrices(next);
  }, [connected, decks]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  async function practise(c: Card) {
    setBusy(c.key);
    try {
      const res = await api.paperEvaluate(c.stockKey);
      const er = res.entry_result;
      setNotes((n) => ({
        ...n,
        [c.key]:
          er.action === "opened"
            ? "✅ सराव trade सुरू झाला"
            : er.action === "no_trade"
            ? "आत्ताच्या भावावर संकेत राहिलेला नाही"
            : (er.reasons ?? ["घेतला नाही"]).map(riskReason).join(" "),
      }));
    } catch (e) {
      setNotes((n) => ({ ...n, [c.key]: e instanceof ApiError ? e.message : "काहीतरी चुकलं" }));
    } finally {
      setBusy(null);
    }
  }

  const created = fromServerTime(scan?.run?.finished_at ?? scan?.run?.started_at);
  const createdText = created
    ? created.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).toUpperCase()
    : "—";

  return (
    <div className="adv">
      <div className="adv-head">
        <strong>💡 आजच्या कल्पना</strong>
        <span className="muted"> · app च्या नियमांवरून, SEBI तज्ज्ञांचा सल्ला नाही</span>
      </div>
      <div className="adv-tabs">
        <button className={tab === "stocks" ? "on" : ""} onClick={() => setTab("stocks")}>
          शेअर्स ({decks.stocks.length})
        </button>
        <button className={tab === "fno" ? "on" : ""} onClick={() => setTab("fno")}>
          F&amp;O ({decks.fno.length})
        </button>
        <button className={tab === "cheap" ? "on" : ""} onClick={() => setTab("cheap")}>
          ₹{CHEAP} खालचे ({decks.cheap.length})
        </button>
      </div>

      {cards.length === 0 ? (
        <p className="muted adv-empty">आज या गटात एकही कल्पना नाही.</p>
      ) : (
        <div className="adv-row">
          {cards.map((c) => {
            const live = prices[c.key];
            const ltp = live ?? c.closePrice;
            const change = ltp - c.closePrice;
            const changePct = (change / c.closePrice) * 100;
            const long = c.side === "BUY";
            const potential = ((long ? c.target - ltp : ltp - c.target) / ltp) * 100;
            const hitStop = long ? ltp <= c.stop : ltp >= c.stop;
            const hitTarget = long ? ltp >= c.target : ltp <= c.target;
            const v = VERDICT_TEXT[c.verdict] ?? VERDICT_TEXT.too_few;
            return (
              <div key={c.key} className="adv-card">
                <div className="adv-top">
                  <span>Created on: {createdText}</span>
                  <span className={`adv-verdict ${v.cls}`}>{v.text}</span>
                </div>
                <div className="adv-title">
                  <div>
                    <div className="adv-name">{c.title}</div>
                    <div className="adv-sub">{c.sub}</div>
                  </div>
                  <div className="adv-price">
                    <div className={change >= 0 ? "text-green" : "text-red"}>{ltp.toFixed(2)}</div>
                    <div className="adv-sub">
                      {live !== undefined
                        ? `${change >= 0 ? "+" : ""}${change.toFixed(2)} (${changePct.toFixed(2)}%)`
                        : "closing भाव"}
                    </div>
                  </div>
                </div>
                <div className="adv-levels">
                  <div>
                    <span>Stop-loss</span>
                    {c.stop.toFixed(2)}
                  </div>
                  <div className="mid">
                    <span>Entry Price</span>
                    {c.entry.toFixed(2)}
                  </div>
                  <div className="end">
                    <span>Target</span>
                    {c.target.toFixed(2)}
                  </div>
                </div>
                <div className="adv-foot">
                  <div className={`adv-pot ${hitStop ? "bad" : ""}`}>
                    {hitTarget ? (
                      <>🎯 Target गाठलं</>
                    ) : hitStop ? (
                      <>⚠ Stop-loss च्या पलीकडे</>
                    ) : (
                      <>
                        <strong>⏫ {potential.toFixed(2)}%</strong>
                        <span>Potential</span>
                      </>
                    )}
                  </div>
                  {c.optionNote ? (
                    <span className="adv-optnote">{c.optionNote}</span>
                  ) : (
                    <button
                      className="adv-btn"
                      disabled={!connected || busy === c.key || hitStop || hitTarget}
                      onClick={() => practise(c)}
                      title="खोटे पैसे; Upstox वर order जात नाही"
                    >
                      {busy === c.key ? "…" : "सराव"}
                    </button>
                  )}
                </div>
                <div className="adv-sub">
                  मागचे 2 वर्ष: {c.trades} trades, {c.winRate !== null ? Math.round(c.winRate * 100) : "—"}% जिंकले
                  {c.key !== c.stockKey && " (शेअरवरचा हिशोब)"}
                </div>
                {notes[c.key] && <div className="adv-note">{notes[c.key]}</div>}
              </div>
            );
          })}
        </div>
      )}
      <p className="muted adv-foot-note">
        Potential = (Target − आत्ताचा भाव) ÷ आत्ताचा भाव. ही फक्त target पर्यंतची उंची आहे, तिथे पोचण्याची खात्री नाही.
        F&amp;O मध्ये Stop/Target हे premium चे अंदाज आहेत; खरा trigger शेअरचा भाव.
      </p>
    </div>
  );
}
