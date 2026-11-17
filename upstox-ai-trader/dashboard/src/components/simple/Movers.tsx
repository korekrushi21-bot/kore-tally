import { useCallback, useEffect, useMemo, useState } from "react";
import type { ScanLatest, ScanResultDTO } from "../../types";
import { api } from "../../api";
import { rupees } from "./translate";

// Fast-moving F&O shares, two ways:
//  - today: biggest live % move vs the scan's last close (gainers and losers)
//  - usually: highest average daily move (ATR14 as % of price, from the scan)
type View = "today" | "usual";
const LTP_BATCH = 50;
const REFRESH_MS = 30_000;
const SHOW = 10;
const CHEAP = 500;

const VERDICT: Record<string, string> = { supports: "🟢", mixed: "🟡", against: "🔴", too_few: "⚪", "": "⚪" };

export function Movers({ scan, connected }: { scan: ScanLatest | null; connected: boolean }) {
  const [view, setView] = useState<View>("today");
  const [cheapOnly, setCheapOnly] = useState(true);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [at, setAt] = useState<Date | null>(null);

  const all = useMemo(() => (scan?.results ?? []).filter((r) => r.action !== "ERROR" && r.last_close), [scan]);
  const pool = useMemo(
    () => (cheapOnly ? all.filter((r) => (r.last_close ?? Infinity) < CHEAP) : all),
    [all, cheapOnly]
  );

  const refresh = useCallback(async () => {
    if (!connected || all.length === 0) return;
    const keys = all.map((r) => r.instrument_key);
    const next: Record<string, number> = {};
    for (let i = 0; i < keys.length; i += LTP_BATCH) {
      try {
        Object.assign(next, (await api.marketLtp(keys.slice(i, i + LTP_BATCH))).prices);
      } catch {
        /* skip this batch */
      }
    }
    if (Object.keys(next).length) {
      setPrices(next);
      setAt(new Date());
    }
  }, [connected, all]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const change = (r: ScanResultDTO) => {
    const live = prices[r.instrument_key];
    return live !== undefined && r.last_close ? ((live - r.last_close) / r.last_close) * 100 : null;
  };

  const withChange = pool.filter((r) => change(r) !== null);
  const gainers = [...withChange].sort((a, b) => change(b)! - change(a)!).slice(0, SHOW);
  const losers = [...withChange].sort((a, b) => change(a)! - change(b)!).slice(0, SHOW);
  const usual = pool
    .filter((r) => r.stats?.atr_pct)
    .sort((a, b) => (b.stats!.atr_pct ?? 0) - (a.stats!.atr_pct ?? 0))
    .slice(0, SHOW * 2);
  const hasStats = all.some((r) => r.stats?.atr_pct);

  return (
    <div className="wl mv">
      <div className="wl-head">
        <div>
          <h2>⚡ जास्त चढ-उतार होणारे शेअर्स</h2>
          <div className="wl-rules">F&amp;O शेअर्स · {cheapOnly ? `फक्त ₹${CHEAP} खालचे` : "सगळे भाव"}</div>
        </div>
        <button className={`chip ${cheapOnly ? "chip-on" : ""}`} onClick={() => setCheapOnly(!cheapOnly)}>
          {cheapOnly ? `✓ ₹${CHEAP} खालचे` : "सगळे भाव"}
        </button>
      </div>
      <div className="adv-tabs mv-tabs">
        <button className={view === "today" ? "on" : ""} onClick={() => setView("today")}>
          आज सर्वात जास्त हललेले
        </button>
        <button className={view === "usual" ? "on" : ""} onClick={() => setView("usual")}>
          नेहमी जास्त हलणारे
        </button>
      </div>

      <div className="wl-note">
        ⚠ जास्त हलणाऱ्या शेअर्समध्ये नफा जलद होऊ शकतो, पण तोटाही तितकाच जलद. Stop-loss दूर ठेवावा लागतो, म्हणून तेवढ्याच
        धोक्यात कमी शेअर्स घेता येतात. नवशिक्यांनी इथे विशेष काळजी घ्यावी.
      </div>

      {view === "today" ? (
        !connected ? (
          <p className="mv-empty">आजचे live भाव पाहण्यासाठी Upstox जोडा.</p>
        ) : withChange.length === 0 ? (
          <p className="mv-empty">Live भाव येत आहेत…</p>
        ) : (
          <>
            <p className="wl-meta">
              Live भाव {at?.toLocaleTimeString("mr-IN")} · बदल मागच्या closing पासून · दर 30 सेकंदांनी अद्ययावत
            </p>
            <div className="mv-cols">
              <MoverList title="📈 सर्वात जास्त वाढलेले" rows={gainers} prices={prices} change={change} />
              <MoverList title="📉 सर्वात जास्त घसरलेले" rows={losers} prices={prices} change={change} />
            </div>
          </>
        )
      ) : !hasStats ? (
        <p className="mv-empty">हा आकडा नवीन scan नंतर दिसेल (उद्या सकाळी 9 ला, किंवा "सोपा मोड" मध्ये scan चालवा).</p>
      ) : (
        <>
          <p className="wl-meta">"रोज सरासरी ±%" = मागच्या 14 दिवसांत रोज भाव साधारण इतके टक्के वर-खाली होतो (ATR).</p>
          <div className="wl-list">
            {usual.map((r) => (
              <Row
                key={r.instrument_key}
                r={r}
                price={prices[r.instrument_key] ?? r.last_close ?? 0}
                right={
                  <>
                    <div className="wl-ltp">±{r.stats!.atr_pct!.toFixed(1)}%</div>
                    <div className="wl-chg muted">रोज सरासरी</div>
                  </>
                }
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function MoverList({
  title,
  rows,
  prices,
  change,
}: {
  title: string;
  rows: ScanResultDTO[];
  prices: Record<string, number>;
  change: (r: ScanResultDTO) => number | null;
}) {
  return (
    <div>
      <div className="mv-col-title">{title}</div>
      <div className="wl-list">
        {rows.map((r) => {
          const c = change(r)!;
          return (
            <Row
              key={r.instrument_key}
              r={r}
              price={prices[r.instrument_key]}
              right={
                <>
                  <div className="wl-ltp">{rupees(prices[r.instrument_key], 2)}</div>
                  <div className={`wl-chg ${c >= 0 ? "text-green" : "text-red"}`}>
                    {c >= 0 ? "+" : ""}
                    {c.toFixed(2)}%
                  </div>
                </>
              }
            />
          );
        })}
      </div>
    </div>
  );
}

function Row({ r, price, right }: { r: ScanResultDTO; price: number; right: React.ReactNode }) {
  const signal =
    r.action === "BUY" ? (
      <span className="wl-badge buy">BUY संकेत</span>
    ) : r.action === "SELL" ? (
      <span className="wl-badge wait">SELL संकेत</span>
    ) : null;
  return (
    <div className="wl-row">
      <div className="wl-main" style={{ cursor: "default" }}>
        <div className="wl-left">
          <div className="wl-symbol">
            {r.symbol} {signal}
          </div>
          <div className="wl-sub">
            {rupees(price, 2)} · मागे {VERDICT[r.backtest.verdict] ?? "⚪"}
            {r.stats?.atr_pct ? ` · रोज ±${r.stats.atr_pct.toFixed(1)}%` : ""}
          </div>
        </div>
        <div className="wl-right">{right}</div>
      </div>
    </div>
  );
}
