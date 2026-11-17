import { useCallback, useEffect, useMemo, useState } from "react";
import type { ScanLatest, ScanResultDTO } from "../../types";
import { api } from "../../api";
import { fromServerTime, marathiDate, marathiDateTime, pctChange, rupees } from "./translate";
import { AdvisoryCards } from "./AdvisoryCards";
import { Movers } from "./Movers";

// The user's list rules. "Win rate" is how often the strategy's past trades on
// this share ended in profit, not a forecast for the next trade.
const MAX_PRICE = 500;
const MIN_WIN_PCT = 40;
const MIN_TRADES = 5;
const WANTED = 20;
const PRICE_REFRESH_MS = 15_000;

function qualifies(r: ScanResultDTO): boolean {
  const b = r.backtest;
  return (
    r.last_close !== null &&
    r.last_close < MAX_PRICE &&
    b.trades >= MIN_TRADES &&
    b.win_rate !== null &&
    b.win_rate * 100 > MIN_WIN_PCT &&
    (b.net_pnl ?? 0) > 0 &&
    (b.profit_factor === null || b.profit_factor >= 1)
  );
}

export function Watchlist({ connected, riskBudget }: { connected: boolean; riskBudget: number }) {
  const [scan, setScan] = useState<ScanLatest | null>(null);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [pricesAt, setPricesAt] = useState<Date | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    api.scanLatest().then(setScan).catch(() => setScan(null));
  }, []);

  const list = useMemo(() => {
    const rows = (scan?.results ?? []).filter(qualifies);
    return rows.sort((a, b) => {
      const buyFirst = Number(b.action === "BUY") - Number(a.action === "BUY");
      return buyFirst || (b.backtest.win_rate ?? 0) - (a.backtest.win_rate ?? 0);
    });
  }, [scan]);

  const refreshPrices = useCallback(async () => {
    if (!connected || list.length === 0) return;
    try {
      const res = await api.marketLtp(list.map((r) => r.instrument_key));
      setPrices(res.prices);
      setPricesAt(new Date());
    } catch {
      /* keep the closing prices; the header says which ones are shown */
    }
  }, [connected, list]);

  useEffect(() => {
    refreshPrices();
    const id = setInterval(refreshPrices, PRICE_REFRESH_MS);
    return () => clearInterval(id);
  }, [refreshPrices]);

  const run = scan?.run;
  const buys = list.filter((r) => r.action === "BUY").length;

  return (
    <>
    <AdvisoryCards scan={scan} connected={connected} />
    <Movers scan={scan} connected={connected} />
    <div className="wl">
      <div className="wl-head">
        <div>
          <h2>📋 माझी यादी</h2>
          <div className="wl-rules">
            ₹{MAX_PRICE} खालचे · मागच्या 2 वर्षांत नफा · जिंकण्याचा दर {MIN_WIN_PCT}% पेक्षा जास्त
          </div>
        </div>
        <div className="wl-count">
          <strong>{list.length}</strong> शेअर्स
          <div className="muted">{buys} वर आज BUY संकेत</div>
        </div>
      </div>

      <div className="wl-meta">
        {run ? (
          <>
            Scan: {marathiDateTime(fromServerTime(run.finished_at ?? run.started_at))} · यादी {marathiDate(run.data_date)} च्या
            closing वर ·{" "}
            {pricesAt ? (
              <span className="text-green">● live भाव {pricesAt.toLocaleTimeString("mr-IN")}</span>
            ) : (
              <span>closing भाव{connected ? "" : " (live भावांसाठी Upstox जोडा)"}</span>
            )}
          </>
        ) : (
          "अजून scan झालेला नाही."
        )}
      </div>

      {run && list.length > 0 && list.length < WANTED && (
        <div className="wl-note">
          तुम्हाला किमान {WANTED} हवे होते, पण आज फक्त <strong>{list.length}</strong> F&amp;O शेअर्स या अटी पूर्ण करतात. यादी
          भरण्यासाठी अटी सैल केलेल्या नाहीत.
        </div>
      )}
      {buys === 0 && list.length > 0 && (
        <div className="wl-note">
          आज यादीतल्या <strong>एकाही शेअरवर BUY संकेत नाही</strong>. म्हणजे app नुसार आज यातलं काहीही घेण्याची वेळ नाही.
          रोज सकाळी पाहा; संकेत आला की तो शेअर वर हिरव्या बिल्ल्यासह येईल.
        </div>
      )}

      <div className="wl-list">
        {list.map((r) => {
          const live = prices[r.instrument_key];
          const ltp = live ?? r.last_close ?? 0;
          const change = r.last_close ? ((ltp - r.last_close) / r.last_close) * 100 : 0;
          const isBuy = r.action === "BUY";
          const expanded = open === r.instrument_key;
          return (
            <div key={r.instrument_key} className={`wl-row ${isBuy ? "wl-buy" : ""}`}>
              <button className="wl-main" onClick={() => setOpen(expanded ? null : r.instrument_key)}>
                <div className="wl-left">
                  <div className="wl-symbol">
                    {r.symbol}
                    {isBuy ? <span className="wl-badge buy">आज BUY संकेत</span> : <span className="wl-badge wait">थांबा</span>}
                  </div>
                  <div className="wl-sub">
                    NSE · {Math.round((r.backtest.win_rate ?? 0) * 100)}% जिंकले · {r.backtest.trades} trades
                  </div>
                </div>
                <div className="wl-right">
                  <div className="wl-ltp">{rupees(ltp, 2)}</div>
                  <div className={`wl-chg ${change >= 0 ? "text-green" : "text-red"}`}>
                    {live !== undefined ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : "closing"}
                  </div>
                </div>
              </button>
              {expanded && (
                <div className="wl-detail">
                  <div className="muted">{r.name}</div>
                  {isBuy && r.entry_price && r.stop_loss && r.target ? (
                    <>
                      <div className="wl-levels">
                        <div>
                          <span className="label">खरेदी सुमारे</span>
                          {rupees(r.entry_price, 2)}
                        </div>
                        <div>
                          <span className="label">Stop-loss</span>
                          <span className="text-red">
                            {rupees(r.stop_loss, 2)} ({pctChange(r.entry_price, r.stop_loss)})
                          </span>
                        </div>
                        <div>
                          <span className="label">Target</span>
                          <span className="text-green">
                            {rupees(r.target, 2)} ({pctChange(r.entry_price, r.target)})
                          </span>
                        </div>
                      </div>
                      <p className="muted">
                        {rupees(riskBudget)} धोका ठेवला तर सुमारे{" "}
                        {Math.floor(riskBudget / Math.abs(r.entry_price - r.stop_loss))} शेअर्स. Upstox वर order देताना
                        stop-loss पण लावा.
                      </p>
                    </>
                  ) : (
                    <p>आज संकेत नाही, म्हणून entry, stop किंवा target नाही. आत्ता घेऊ नका; संकेत आला की इथे दिसेल.</p>
                  )}
                  <p className="muted">
                    मागचे 2 वर्ष: {r.backtest.trades} trades, {Math.round((r.backtest.win_rate ?? 0) * 100)}% जिंकले,
                    profit factor {r.backtest.profit_factor?.toFixed(2) ?? "—"}, ₹1 लाख वर {rupees(r.backtest.net_pnl)} नफा.
                    भूतकाळ पुन्हा घडेलच असं नाही.
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="muted wl-foot">
        "जिंकण्याचा दर" म्हणजे भविष्यातली शक्यता नाही, मागच्या trades पैकी किती नफ्यात गेले ते. हे app order टाकत नाही; Upstox
        वर trade करायचा निर्णय आणि जबाबदारी तुमची.
      </p>
    </div>
    </>
  );
}
