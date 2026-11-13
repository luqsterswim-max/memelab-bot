// MemeLab AI — paper trading bot v2 (NO real money, NO wallet, NO private keys)
// Run:  npm i @supabase/supabase-js   then   node Bot.mjs      (Node 18+)
import { createClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_URL || "https://wduflmaakgoemxsegnbp.supabase.co";
const KEY = process.env.SUPABASE_KEY || "sb_publishable_muU19iaA6GTGNIvX6orqDg_ZO-50q5e";
const { BOT_EMAIL, BOT_PASSWORD } = process.env;

// ================= SETTINGS (change freely) =================
const num = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" ? +process.env[k] : d);

// -- position sizing (% of portfolio equity, scaled by signal score) --
const MIN_PCT = num("MIN_PCT", 0.05);          // weakest accepted signal  -> 5% of portfolio
const MAX_PCT = num("MAX_PCT", 0.30);          // strongest signal         -> 30% of portfolio
const MAX_EXPOSURE = num("MAX_EXPOSURE", 0.80);// total open positions never above 80% of portfolio
const MIN_USD = num("MIN_USD", 10);            // never enter with less than this
const MAX_USD = num("MAX_USD", 0);             // optional hard cap per entry in USD (0 = off)
const MAX_OPEN = num("MAX_OPEN", 4);           // max open positions at once
const DAILY_PICKS = 2, DAILY_WATCH = 3;        // coins to ENTER / WAIT per day

// -- exits --
const PARTIAL_X = num("PARTIAL_X", 1.5);       // sell 50% at 1.5x
const TARGET = num("TARGET", 2.2);             // after this peak the trailing stop gets tighter
const STOP = num("STOP", 0.65);                // stop-loss at -35% (before partial sale)
const BE_X = num("BE_X", 1.04);                // break-even incl. costs (stop moves here after partial sale)
const TRAIL = num("TRAIL", 0.75);              // after partial: sell rest if price < 75% of peak
const TRAIL_HI = num("TRAIL_HI", 0.80);        // once peak >= TARGET: 80% of peak
const RUG_LIQ = num("RUG_LIQ", 2500);          // liquidity below this on an open position = rug suspected

// -- cooldown / blacklist --
const COOLDOWN_MIN = num("COOLDOWN_MIN", 30);          // wait after a normal exit before re-entering same token
const COOLDOWN_STOP_MIN = num("COOLDOWN_STOP_MIN", 60);// wait after a stop-loss on same token
const BL_LOSS = num("BL_LOSS", 0.40);          // exit at <= 0.40x (loss over 60%) = permanent blacklist

// -- simulated costs --
const FEE = num("FEE", 0.005), SLIP = num("SLIP", 0.015);   // 0.5% fee + 1.5% base slippage
// slippage grows with size relative to liquidity (see slipRate)
// =============================================================

let step = "start";
let db;
try {
  db = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: true } });
} catch (e) {
  console.log("::error::[createClient] " + String(e?.message || e).replace(/\s+/g, " "));
  process.exit(1);
}
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
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

// ---- costs: slippage grows when the trade is large vs liquidity ----
const slipRate = (usd, liq) => clamp(SLIP + (liq > 0 ? usd / liq : 0.1), SLIP, 0.20);

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
  if (s > b * 1.5 && b + s >= 30) risks.push("sells dominate in 1h");
  let score = Math.min(25, liq / 4000)                                   // liquidity
    + (liq ? Math.min(20, (vol / liq) * 5) : 0)                          // turnover
    + (b + s ? clamp((b / (b + s) - 0.45) * 200, 0, 20) : 0)             // buy pressure
    + (ch1 > 0 && ch1 <= 60 ? 15 : ch1 > 60 ? 8 : 0)                     // healthy momentum
    + (ch6 > 0 ? 10 : 0) + (age >= 2 && age <= 48 ? 10 : 0);
  score = Math.round(score);
  const note = `liq $${Math.round(liq)}, vol24h $${Math.round(vol)}, mcap $${Math.round(mc)}, age ${age.toFixed(1)}h, buys/sells 1h ${b}/${s}, 1h ${ch1}%`;
  return { score, risks, note };
}

// ---- dynamic position size: bigger for strong/safe signals, smaller for weak/risky ----
function sizeFor(e, equity, invested, cashLeft) {
  const p = e.p, liq = p.liquidity?.usd || 0, ch1 = p.priceChange?.h1 || 0;
  let pct = MIN_PCT + clamp((e.score - 45) / 55, 0, 1) * (MAX_PCT - MIN_PCT);
  if (ch1 > 60) pct *= 0.7;            // already running hot
  if (liq < 30000) pct *= 0.8;         // thin liquidity
  let usd = equity * pct;
  if (MAX_USD > 0) usd = Math.min(usd, MAX_USD);
  usd = Math.min(usd, equity * MAX_EXPOSURE - invested, cashLeft);   // 80% total exposure cap
  usd = Math.floor(usd * 100) / 100;
  return { usd: usd >= MIN_USD ? usd : 0, pct };
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
    if (t.side === "BUY") {
      if (p.qty <= 1e-8) { p.firstAt = new Date(t.executed_at); p.entry = +t.price; p.halfAt = null; }   // new cycle (also after re-entry)
      p.qty += +t.quantity;
    } else {
      p.qty = Math.max(0, p.qty - +t.quantity);
      if (!p.halfAt) p.halfAt = new Date(t.executed_at);
    }
  }
  return m;
}
async function must(q) { const r = await q; if (r.error) throw new Error(r.error.message); return r.data; }
const now = () => new Date().toISOString();

async function paperBuy(tokenId, ticker, price, usd, liq) {
  const fee = usd * FEE, slip = usd * slipRate(usd, liq), qty = (usd - fee - slip) / price;
  await must(db.from("paper_trades").insert({ user_id: USER, token_id: tokenId, side: "BUY", price, quantity: qty, fee, slippage: slip, executed_at: now() }));
  await must(db.from("portfolio_ledger").insert({ user_id: USER, event_type: "TRADE_BUY", amount_usd: usd, description: `[BOT] BUY ${ticker} @ ${price} ($${usd.toFixed(2)})`, created_at: now() }));
}
async function paperSell(tokenId, ticker, price, qty, why, liq) {
  const gross = price * qty, fee = gross * FEE, slip = gross * slipRate(gross, liq);
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
async function addToken(p) {
  return must(db.from("tokens").insert({ user_id: USER, mint_address: p.baseToken.address, name: p.baseToken.name || p.baseToken.symbol, ticker: (p.baseToken.symbol || "?").toUpperCase(), status: "ANALIZUJE" }).select().single());
}
async function tokenFor(S, p) {       // reuse existing token row (re-entry) or create a new one
  return S.tokens.find(t => t.mint_address === p.baseToken.address) || addToken(p);
}

// ---- blacklist & cooldown (derived from the decision log) ----
const isBlacklisted = (S, tokenId) => S.decisions.some(d => d.token_id === tokenId && /BLACKLIST/.test(d.reason || ""));
function cooldownLeftMin(S, tokenId) {
  const exits = S.decisions.filter(d => d.token_id === tokenId && d.decision === "WYJŚĆ")
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  if (!exits.length) return 0;
  const last = exits[0], wait = /stop-loss/i.test(last.reason || "") ? COOLDOWN_STOP_MIN : COOLDOWN_MIN;
  return Math.max(0, wait - (Date.now() - new Date(last.created_at)) / 6e4);
}

// ---- daily scan: picks the best coins of the day ----
async function scan(S) {
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const today = S.decisions.filter(d => new Date(d.created_at) >= dayStart && (d.reason || "").startsWith("[BOT]") && !/sold|exit|stop/i.test(d.reason));
  const picks = today.filter(d => d.decision === "WEJŚĆ").length, waits = today.filter(d => d.decision === "POCZEKAĆ").length;
  if (picks >= DAILY_PICKS && waits >= DAILY_WATCH) return log("daily quota done");
  const h = new Date().getUTCHours();
  const minScore = picks >= DAILY_PICKS ? 70 : h >= 18 ? 45 : h >= 12 ? 55 : 70;   // relaxes score only, never the risk filters
  const pos = positions(S);
  const known = new Set(S.tokens.map(t => t.mint_address));
  // previously exited tokens may come back, but only if not blacklisted and cooldown is over
  const reentry = S.tokens.filter(t => t.status === "WYJŚĆ" && !(pos[t.id]?.qty > 1e-8) && !isBlacklisted(S, t.id) && cooldownLeftMin(S, t.id) <= 0).map(t => t.mint_address);
  step = "discover tokens";
  const addrs = [...new Set([...(await discover()).filter(a => !known.has(a)), ...reentry])];
  log(`scan: ${addrs.length} candidates (${reentry.length} re-entry), min score ${minScore}`);
  step = "fetch pair data";
  const ev = Object.values(bestPair(await pairsFor(addrs))).map(p => ({ p, ...evaluate(p) }));
  const ok = ev.filter(e => !e.risks.length).sort((a, b) => b.score - a.score);
  log(`passed risk filters: ${ok.length}/${ev.length}; rejected: ${ev.length - ok.length}`);
  const openList = Object.values(pos).filter(p => p.qty > 1e-8);
  let freeSlots = MAX_OPEN - openList.length, c = cash(S);
  let invested = openList.reduce((s, p) => s + p.qty * p.entry, 0);       // open positions at cost
  const equity = c + invested;

  step = "save picks";
  for (const e of ok.filter(e => e.score >= minScore).slice(0, Math.max(0, DAILY_PICKS - picks))) {
    const tok = await tokenFor(S, e.p);
    const { usd, pct } = sizeFor(e, equity, invested, c);
    if (freeSlots <= 0 || !usd) { await decide(tok.id, "POCZEKAĆ", `score ${e.score}/100 but no free slot, cash or exposure room. ${e.note}`); log("WAIT (no cash/slot/exposure)", tok.ticker); continue; }
    await snapshot(tok.id, e.p);
    await paperBuy(tok.id, tok.ticker, +e.p.priceUsd, usd, e.p.liquidity?.usd || 0);
    await decide(tok.id, "WEJŚĆ", `score ${e.score}/100, size $${usd.toFixed(2)} (${(usd / equity * 100).toFixed(1)}% of portfolio, base ${(pct * 100).toFixed(1)}%). ${e.note}`,
      `Sell 50% at ${PARTIAL_X}x, then break-even stop + trailing stop on the rest`, `Stop-loss at -${Math.round((1 - STOP) * 100)}%. Memecoin: can go to zero.`);
    freeSlots--; c -= usd; invested += usd; log("ENTER", tok.ticker, "score", e.score, "size $" + usd.toFixed(2));
  }
  for (const e of ok.filter(e => e.score >= 45 && e.score < minScore).slice(0, Math.max(0, DAILY_WATCH - waits))) {
    const tok = await tokenFor(S, e.p);
    await snapshot(tok.id, e.p);
    await decide(tok.id, "POCZEKAĆ", `score ${e.score}/100, needs more time. ${e.note}`, "Re-check momentum and buy pressure");
    log("WAIT", tok.ticker, "score", e.score);
  }
}

// ---- manage open positions: partial profit, break-even, trailing, smart exits ----
async function manage(S) {
  const pos = positions(S);
  const toks = Object.entries(pos).filter(([, p]) => p.qty > 1e-8).map(([id]) => S.tokens.find(t => t.id === id)).filter(Boolean);
  if (!toks.length) return;
  const best = bestPair(await pairsFor(toks.map(t => t.mint_address)));
  for (const t of toks) {
    const pr = best[t.mint_address], p = pos[t.id];
    if (!pr || !(+pr.priceUsd > 0)) { log("no price for", t.ticker); continue; }
    const price = +pr.priceUsd, x = price / p.entry, ageH = (Date.now() - p.firstAt) / 36e5;
    const liq = pr.liquidity?.usd || 0;
    const ch1 = pr.priceChange?.h1 || 0, ch6 = pr.priceChange?.h6 || 0;
    const b = pr.txns?.h1?.buys || 0, s = pr.txns?.h1?.sells || 0;
    await snapshot(t.id, pr);
    const mySnaps = S.snaps.filter(sn => sn.token_id === t.id && new Date(sn.observed_at) >= p.firstAt).map(sn => +sn.price);
    const peakX = Math.max(price, ...mySnaps) / p.entry;

    const exitAll = async (why, forceBlacklist) => {
      await paperSell(t.id, t.ticker, price, p.qty, why, liq);
      const bl = forceBlacklist || x <= BL_LOSS;
      await decide(t.id, "WYJŚĆ", `exit all (${why}) at ${x.toFixed(2)}x, peak ${peakX.toFixed(2)}x${bl ? " [BLACKLIST]" : ""}`);
      log("EXIT", t.ticker, why, x.toFixed(2) + "x", bl ? "-> BLACKLISTED" : "");
    };

    // rug pull protection comes first
    if (liq < RUG_LIQ || x <= 0.2) { await exitAll(`rug pull suspected, liquidity $${Math.round(liq)}`, true); continue; }

    if (!p.halfAt) {
      if (x >= PARTIAL_X) {
        await paperSell(t.id, t.ticker, price, p.qty / 2, `${PARTIAL_X}x target, sold 50%`, liq);
        await decide(t.id, "WEJŚĆ", `sold 50% at ${x.toFixed(2)}x, stop moved to break-even, rest trails the peak`);
        log("HALF SOLD", t.ticker, x.toFixed(2) + "x");
      }
      else if (x <= STOP) await exitAll("stop-loss");
      else if (peakX >= 1.25 && x <= BE_X) await exitAll("break-even stop after a +25% run");
      else if (ageH >= 1 && x < 1.25 && ch1 < -8 && ch6 < -15 && s > b * 1.3) await exitAll("downtrend: falling 1h/6h and sellers dominate");
      else if (ageH >= 6 && x < 1.3 && ch1 < -10) await exitAll("momentum fading, will not reach target");
      else if (ageH >= 24 && x < 1.5) await exitAll("24h time stop");
    } else {
      const peakH = Math.max(price, ...S.snaps.filter(sn => sn.token_id === t.id && new Date(sn.observed_at) >= p.halfAt).map(sn => +sn.price));
      const trail = peakH / p.entry >= TARGET ? TRAIL_HI : TRAIL;
      const beStop = p.entry * BE_X, trailStop = peakH * trail;
      if (price <= Math.max(beStop, trailStop)) await exitAll(trailStop >= beStop ? `trailing stop, peak ${(peakH / p.entry).toFixed(2)}x` : "break-even stop on the rest");
      else if ((Date.now() - p.halfAt) / 36e5 >= 48) await exitAll("48h time stop after half sale");
    }
  }
}

async function main() {
  if (!BOT_EMAIL || !BOT_PASSWORD) throw new Error("secret BOT_EMAIL or BOT_PASSWORD is empty");
  step = "login";
  const r = await db.auth.signInWithPassword({ email: BOT_EMAIL, password: BOT_PASSWORD });
  if (r.error) throw new Error(r.error.message);
  USER = r.data.user.id;
  log("bot v2 started (paper trading only), user", r.data.user.email);
  if (process.argv.includes("--once")) {          // single run (for GitHub Actions / cron)
    step = "load data";
    const S1 = await load();
    step = "manage positions";
    await manage(S1);
    step = "load data (scan)";
    const S2 = await load();
    step = "scan";
    await scan(S2);
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
main().catch(e => {
  console.log("::error::[" + step + "] " + String(e?.message || e).replace(/\s+/g, " "));
  process.exit(1);
});

