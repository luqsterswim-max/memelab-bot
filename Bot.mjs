// MemeLab AI — paper trading bot v1 (NO real money, NO wallet, NO private keys)
// Run:  npm i @supabase/supabase-js   then   node bot.mjs      (Node 18+)
import { createClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_URL || "https://wduflmaakgoemxsegnbp.supabase.co";
const KEY = process.env.SUPABASE_KEY || "sb_publishable_muU19iaA6GTGNIvX6orqDg_ZO-50q5e";
const { BOT_EMAIL, BOT_PASSWORD } = process.env;      // same login as the MemeLab app

// ---- settings (change freely) ----
const POS = +process.env.POSITION_USD || 50;   // USD per coin (from your paper cash)
const MAX_OPEN = +process.env.MAX_OPEN || 4;   // max open positions
const DAILY_PICKS = 2, DAILY_WATCH = 3;        // coins to ENTER / WAIT per day
const TARGET = 2.2;                            // sell 50% at 2.2x
const STOP = 0.65;                             // stop-loss at -35% (before target)
const TRAIL = 0.70;                            // after target: sell rest if price < 70% of peak
const FEE = 0.005, SLIP = 0.015;               // simulated costs (0.5% + 1.5%)

const db = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: true } });
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let USER = null;

async function api(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(r.status + " " + url);
  return r.json();
}
async function pairsFor(addrs) {
  const out = [];
  for (let i = 0; i < addrs.length; i += 30) {
    const j = await api(`https://api.dexscreener.com/tokens/v1/solana/${addrs.slice(i, i + 30).join(",")}`);
    if (Array.isArray(j)) out.push(...j);
    await sleep(1100);
  }
  return out;
}
function bestPair(pairs) {            // most liquid pair per token
  const m = {};
  for (const p of pairs) {
    const a = p.baseToken?.address;
    if (!a || p.chainId !== "solana") continue;
    if (!m[a] || (p.liquidity?.usd || 0) > (m[a].liquidity?.usd || 0)) m[a] = p;
  }
  return m;
}
async function discover() {
  const urls = ["https://api.dexscreener.com/token-profiles/latest/v1", "https://api.dexscreener.com/token-boosts/latest/v1"];
  const set = new Set();
  for (const u of urls) {
    try { (await api(u)).forEach(x => x.chainId === "solana" && x.tokenAddress && set.add(x.tokenAddress)); }
    catch (e) { log("discover failed:", e.message); }
    await sleep(1100);
  }
  return [...set];
}

// ---- analysis: hard risk filters first, then a 0-100 score ----
function evaluate(p) {
  const liq = p.liquidity?.usd || 0, vol = p.volume?.h24 || 0, mc = p.marketCap || p.fdv || 0;
  const age = (Date.now() - (p.pairCreatedAt || Date.now())) / 36e5;
  const b = p.txns?.h1?.buys || 0, s = p.txns?.h1?.sells || 0;
  const ch1 = p.priceChange?.h1 || 0, ch6 = p.priceChange?.h6 || 0, ch24 = p.priceChange?.h24 || 0;
  const risks = [];
  if (liq < 15000) risks.push("liquidity under $15k");
  if (vol < 30000) risks.push("24h volume under $30k");
  if (age < 1) risks.push("pair younger than 1h");
  if (age > 96) risks.push("pair older than 4 days");
  if (mc < 80000 || mc > 8e6) risks.push("market cap outside $80k-$8M");
  if (mc && liq / mc < 0.03) risks.push("liquidity under 3% of market cap");
  if (ch1 > 150) risks.push("already pumped over 150% in 1h");
  if (ch24 < -40) risks.push("down over 40% in 24h");
  if (b + s < 30) risks.push("too few trades in 1h");
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  let score = Math.min(25, liq / 4000)                                   // liquidity
    + (liq ? Math.min(20, (vol / liq) * 5) : 0)                          // turnover
    + (b + s ? clamp((b / (b + s) - 0.45) * 200, 0, 20) : 0)             // buy pressure
    + (ch1 > 0 && ch1 <= 60 ? 15 : ch1 > 60 ? 8 : 0)                     // healthy momentum
    + (ch6 > 0 ? 10 : 0) + (age >= 2 && age <= 48 ? 10 : 0);
  score = Math.round(score);
  const note = `liq $${Math.round(liq)}, vol24h $${Math.round(vol)}, mcap $${Math.round(mc)}, age ${age.toFixed(1)}h, buys/sells 1h ${b}/${s}, 1h ${ch1}%`;
  return { score, risks, note };
}

// ---- database ----
async function load() {
  const names = ["tokens", "paper_trades", "token_snapshots", "token_decisions", "portfolio_ledger"];
  const res = await Promise.all(names.map(n => db.from(n).select("*").eq("user_id", USER)));
  res.forEach((r, i) => { if (r.error) throw new Error(names[i] + ": " + r.error.message); });
  return { tokens: res[0].data, trades: res[1].data, snaps: res[2].data, decisions: res[3].data, ledger: res[4].data };
}
const legacy = r => r.event_type === "INITIAL_CAPITAL" || (r.event_type === "DEPOSIT" && r.description === "PIERWSZY_PRZELEW_PAPER_TRADING");
const cash = S => S.ledger.reduce((s, r) => {
  if (legacy(r)) return s;
  const a = Math.abs(+r.amount_usd || 0);
  return ["DEPOSIT", "TRADE_SELL"].includes(r.event_type) ? s + a : ["TRADE_BUY", "WITHDRAWAL"].includes(r.event_type) ? s - a : s;
}, 0);
function positions(S) {
  const m = {};
  for (const t of S.trades.slice().sort((a, b) => new Date(a.executed_at) - new Date(b.executed_at))) {
    const p = m[t.token_id] || (m[t.token_id] = { qty: 0, entry: 0, firstAt: null, halfAt: null });
    if (t.side === "BUY") { if (!p.firstAt) { p.firstAt = new Date(t.executed_at); p.entry = +t.price; } p.qty += +t.quantity; }
    else { p.qty = Math.max(0, p.qty - +t.quantity); if (!p.halfAt) p.halfAt = new Date(t.executed_at); }
  }
  return m;
}
async function must(q) { const r = await q; if (r.error) throw new Error(r.error.message); return r.data; }
const now = () => new Date().toISOString();

async function paperBuy(tokenId, ticker, price) {
  const fee = POS * FEE, slip = POS * SLIP, qty = (POS - fee - slip) / price;
  await must(db.from("paper_trades").insert({ user_id: USER, token_id: tokenId, side: "BUY", price, quantity: qty, fee, slippage: slip, executed_at: now() }));
  await must(db.from("portfolio_ledger").insert({ user_id: USER, event_type: "TRADE_BUY", amount_usd: POS, description: `[BOT] BUY ${ticker} @ ${price}`, created_at: now() }));
}
async function paperSell(tokenId, ticker, price, qty, why) {
  const gross = price * qty, fee = gross * FEE, slip = gross * SLIP;
  await must(db.from("paper_trades").insert({ user_id: USER, token_id: tokenId, side: "SELL", price, quantity: qty, fee, slippage: slip, executed_at: now() }));
  await must(db.from("portfolio_ledger").insert({ user_id: USER, event_type: "TRADE_SELL", amount_usd: gross - fee - slip, description: `[BOT] SELL ${ticker}: ${why}`, created_at: now() }));
}
async function snapshot(tokenId, p) {
  await must(db.from("token_snapshots").insert({ user_id: USER, token_id: tokenId, price: +p.priceUsd, market_cap: p.marketCap || p.fdv || 0,
    liquidity: p.liquidity?.usd || 0, volume_24h: p.volume?.h24 || 0, holders: 0, observed_at: now() }));
}
async function decide(tokenId, decision, reason, trigger, risk) {
  await must(db.from("token_decisions").insert({ user_id: USER, token_id: tokenId, decision, reason: "[BOT] " + reason, trigger_condition: trigger || "", risk_notes: risk || "", created_at: now() }));
  await must(db.from("tokens").update({ status: decision }).eq("id", tokenId).eq("user_id", USER));
}

// ---- daily scan: picks the best coins of the day ----
async function scan(S) {
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const today = S.decisions.filter(d => new Date(d.created_at) >= dayStart && (d.reason || "").startsWith("[BOT]") && !/sold|exit|stop/i.test(d.reason));
  const picks = today.filter(d => d.decision === "WEJŚĆ").length, waits = today.filter(d => d.decision === "POCZEKAĆ").length;
  if (picks >= DAILY_PICKS && waits >= DAILY_WATCH) return log("daily quota done");
  const h = new Date().getUTCHours();
  const minScore = picks >= DAILY_PICKS ? 70 : h >= 18 ? 45 : h >= 12 ? 55 : 70;   // relaxes score only, never the risk filters
  const known = new Set(S.tokens.map(t => t.mint_address));
  const addrs = (await discover()).filter(a => !known.has(a));
  log(`scan: ${addrs.length} new candidates, min score ${minScore}`);
  const ev = Object.values(bestPair(await pairsFor(addrs))).map(p => ({ p, ...evaluate(p) }));
  const ok = ev.filter(e => !e.risks.length).sort((a, b) => b.score - a.score);
  log(`passed risk filters: ${ok.length}/${ev.length}; rejected: ${ev.length - ok.length}`);
  const open = Object.values(positions(S)).filter(p => p.qty > 1e-8).length;
  let freeSlots = MAX_OPEN - open, c = cash(S);

  for (const e of ok.filter(e => e.score >= minScore).slice(0, Math.max(0, DAILY_PICKS - picks))) {
    const tok = await addToken(e.p);
    if (freeSlots <= 0 || c < POS) { await decide(tok.id, "POCZEKAĆ", `score ${e.score}/100 but no free slot or cash. ${e.note}`); log("WAIT (no cash/slot)", tok.ticker); continue; }
    await snapshot(tok.id, e.p);
    await paperBuy(tok.id, tok.ticker, +e.p.priceUsd);
    await decide(tok.id, "WEJŚĆ", `score ${e.score}/100. ${e.note}`, `Sell 50% at ${TARGET}x, trailing stop on the rest`, `Stop-loss at -${Math.round((1 - STOP) * 100)}%. Memecoin: can go to zero.`);
    freeSlots--; c -= POS; log("ENTER", tok.ticker, "score", e.score);
  }
  for (const e of ok.filter(e => e.score >= 45 && e.score < minScore).slice(0, Math.max(0, DAILY_WATCH - waits))) {
    const tok = await addToken(e.p);
    await snapshot(tok.id, e.p);
    await decide(tok.id, "POCZEKAĆ", `score ${e.score}/100, needs more time. ${e.note}`, "Re-check momentum and buy pressure");
    log("WAIT", tok.ticker, "score", e.score);
  }
}
async function addToken(p) {
  return must(db.from("tokens").insert({ user_id: USER, mint_address: p.baseToken.address, name: p.baseToken.name || p.baseToken.symbol, ticker: (p.baseToken.symbol || "?").toUpperCase(), status: "ANALIZUJE" }).select().single());
}

// ---- manage open positions: 2.2x half-exit, trailing stop, smart exits ----
async function manage(S) {
  const pos = positions(S);
  const toks = Object.entries(pos).filter(([, p]) => p.qty > 1e-8).map(([id]) => S.tokens.find(t => t.id === id)).filter(Boolean);
  if (!toks.length) return;
  const best = bestPair(await pairsFor(toks.map(t => t.mint_address)));
  for (const t of toks) {
    const pr = best[t.mint_address], p = pos[t.id];
    if (!pr || !(+pr.priceUsd > 0)) { log("no price for", t.ticker); continue; }
    const price = +pr.priceUsd, x = price / p.entry, ageH = (Date.now() - p.firstAt) / 36e5, ch1 = pr.priceChange?.h1 || 0;
    await snapshot(t.id, pr);
    const exitAll = async why => { await paperSell(t.id, t.ticker, price, p.qty, why); await decide(t.id, "WYJŚĆ", `exit all (${why}) at ${x.toFixed(2)}x`); log("EXIT", t.ticker, why, x.toFixed(2) + "x"); };
    if (!p.halfAt) {
      if (x >= TARGET) {
        await paperSell(t.id, t.ticker, price, p.qty / 2, `${TARGET}x target, sold 50%`);
        await decide(t.id, "WEJŚĆ", `sold 50% at ${x.toFixed(2)}x, rest trails the peak`); log("HALF SOLD", t.ticker, x.toFixed(2) + "x");
      } else if (x <= STOP) await exitAll("stop-loss");
      else if (ageH >= 6 && x < 1.3 && ch1 < -10) await exitAll("momentum fading, will not reach target");
      else if (ageH >= 24 && x < 1.5) await exitAll("24h time stop");
    } else {
      const peak = Math.max(price, ...S.snaps.filter(s => s.token_id === t.id && new Date(s.observed_at) >= p.halfAt).map(s => +s.price));
      if (price <= peak * TRAIL) await exitAll(`trailing stop, peak ${(peak / p.entry).toFixed(2)}x`);
      else if ((Date.now() - p.halfAt) / 36e5 >= 48) await exitAll("48h time stop after half sale");
    }
  }
}

async function main() {
  if (!BOT_EMAIL || !BOT_PASSWORD) throw new Error("Set BOT_EMAIL and BOT_PASSWORD (your MemeLab login).");
  const r = await db.auth.signInWithPassword({ email: BOT_EMAIL, password: BOT_PASSWORD });
  if (r.error) throw r.error;
  USER = r.data.user.id;
  log("bot started (paper trading only), user", r.data.user.email);
  if (process.argv.includes("--once")) {          // single run (for GitHub Actions / cron)
    await manage(await load());
    await scan(await load());
    log("run finished");
    return;
  }
  let lastScan = 0;
  for (;;) {
    try {
      await manage(await load());
      if (Date.now() - lastScan > 30 * 60e3) { await scan(await load()); lastScan = Date.now(); }
    } catch (e) { log("cycle error:", e.message); }
    await sleep(5 * 60e3);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
