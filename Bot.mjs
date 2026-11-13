// MemeLab AI — paper trading bot v4 (NO real money, NO wallet, NO private keys)
// v4: trailing stop 5% (tiered), momentum confirmation, RugCheck filter, daily loss breaker,
//     mark-to-market equity, trade statistics, paging fix (Supabase 1000-row limit).
// Run:  npm i @supabase/supabase-js   then   node Bot.mjs      (Node 18+)
import { createClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_URL || "https://wduflmaakgoemxsegnbp.supabase.co";
const KEY = process.env.SUPABASE_KEY || "sb_publishable_muU19iaA6GTGNIvX6orqDg_ZO-50q5e";
const { BOT_EMAIL, BOT_PASSWORD } = process.env;

// ================= SETTINGS (change freely, or override with env vars) =================
const num = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" ? +process.env[k] : d);

// -- position sizing (% of portfolio equity, depends on RISK level) --
const PCT_LOW = num("PCT_LOW", 0.30);
const PCT_MED = num("PCT_MED", 0.15);
const PCT_HIGH = num("PCT_HIGH", 0.05);
const MAX_EXPOSURE = num("MAX_EXPOSURE", 0.80);
const MIN_USD = num("MIN_USD", 10);
const MAX_USD = num("MAX_USD", 0);
const MAX_OPEN = num("MAX_OPEN", 8);
const DAILY_PICKS = 7, DAILY_WATCH = 18;

// -- exits: tiered trailing stop (sell EVERYTHING when price drops X% below the peak) --
const TRAIL_WIDE = num("TRAIL_WIDE", 8);       // % trail while peak < TIER_LO_X (loose start, survives noise)
const TRAIL_PCT = num("TRAIL_PCT", 5);         // % trail while TIER_LO_X <= peak < TIER_HI_X
const TRAIL_TIGHT = num("TRAIL_TIGHT", 3);     // % trail once peak >= TIER_HI_X (protect big profit)
const TIER_LO_X = num("TIER_LO_X", 1.5);
const TIER_HI_X = num("TIER_HI_X", 3);
const ARM_X = num("ARM_X", 1.10);              // trailing is armed once peak >= 1.10x entry (before that only the hard stop-loss works)
const STOP = num("STOP", 0.65);                // hard stop-loss at -35% (only while trailing is not armed)
const RUG_LIQ = num("RUG_LIQ", 2500);          // liquidity below this on an open position = rug suspected
const POLL_SEC = num("POLL_SEC", 60);          // how often open positions are checked (loop mode)

// -- entry momentum confirmation (DexScreener 5m/1h data) --
const MOM_M5_MIN = num("MOM_M5_MIN", 0.3);     // price must be up at least this % in the last 5 min
const MOM_M5_MAX = num("MOM_M5_MAX", 25);      // ...but not more than this % (do not buy a spike top)
const MOM_MIN_TRADES = num("MOM_MIN_TRADES", 10); // min trades in the last 5 min
const MOM_BUY_RATIO = num("MOM_BUY_RATIO", 1.0);  // buys(5m) must be >= sells(5m) * this

// -- RugCheck safety filter (mint/freeze authority, honeypot, "danger" risks) --
const RUGCHECK = num("RUGCHECK", 1);           // 1 = on, 0 = off
const RUGCHECK_STRICT = num("RUGCHECK_STRICT", 1); // 1 = if RugCheck is unreachable, do NOT enter

// -- daily loss breaker (realized): stop opening new positions after losing this much today --
const DAILY_LOSS_LIMIT = num("DAILY_LOSS_LIMIT", 0.10);   // 0.10 = -10% of day-start equity, 0 = off

// -- waiting list --
const WATCH_HOURS = num("WATCH_HOURS", 24);    // re-check WAIT tokens that were updated within this many hours

// -- cooldown / blacklist --
const COOLDOWN_MIN = num("COOLDOWN_MIN", 30);
const COOLDOWN_STOP_MIN = num("COOLDOWN_STOP_MIN", 60);
const BL_LOSS = num("BL_LOSS", 0.40);          // exit at <= 0.40x = permanent blacklist

// -- simulated costs --
const FEE = num("FEE", 0.005), SLIP = num("SLIP", 0.015);
// ========================================================================================

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
    if (i + 30 < addrs.length) await sleep(1100);
  }
  return out;
}
function bestPair(pairs) {
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

const slipRate = (usd, liq) => clamp(SLIP + (liq > 0 ? usd / liq : 0.1), SLIP, 0.20);

// ---- analysis: hard risk filters first, then a 0-100 score + risk level ----
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
  let score = Math.min(25, liq / 4000)
    + (liq ? Math.min(20, (vol / liq) * 5) : 0)
    + (b + s ? clamp((b / (b + s) - 0.45) * 200, 0, 20) : 0)
    + (ch1 > 0 && ch1 <= 60 ? 15 : ch1 > 60 ? 8 : 0)
    + (ch6 > 0 ? 10 : 0) + (age >= 2 && age <= 48 ? 10 : 0);
  score = Math.round(score);

  let rp = 0;
  if (liq < 30000) rp++;
  if (ch1 > 60) rp++;
  if (age < 3) rp++;
  if (mc && liq / mc < 0.06) rp++;
  if (s > b * 1.1) rp++;
  if (mc < 200000) rp++;
  const level = rp >= 4 ? "HIGH" : rp >= 2 ? "MEDIUM" : "LOW";

  const note = `risk ${level} (${rp} pts), liq $${Math.round(liq)}, vol24h $${Math.round(vol)}, mcap $${Math.round(mc)}, age ${age.toFixed(1)}h, buys/sells 1h ${b}/${s}, 1h ${ch1}%`;
  return { score, risks, note, level, rp };
}

// ---- entry confirmation: price still rising in the last minutes and buyers ahead ----
function momentum(p) {
  const ch5 = p.priceChange?.m5, ch1 = p.priceChange?.h1;
  const b5 = p.txns?.m5?.buys || 0, s5 = p.txns?.m5?.sells || 0;
  if (ch5 === undefined || ch5 === null) return "no 5m data";
  if (ch5 < MOM_M5_MIN) return `5m change ${ch5}% is below +${MOM_M5_MIN}%`;
  if (ch5 > MOM_M5_MAX) return `5m change ${ch5}% is a spike (over +${MOM_M5_MAX}%)`;
  if (!(ch1 > 0)) return `1h change ${ch1}% is not positive`;
  if (b5 + s5 < MOM_MIN_TRADES) return `only ${b5 + s5} trades in 5m`;
  if (b5 < s5 * MOM_BUY_RATIO) return `buyers not ahead in 5m (${b5}/${s5})`;
  return null;
}

// ---- RugCheck: blocks mint/freeze authority, honeypot and any "danger" level risk ----
const rcCache = new Map();
async function rugCheck(mint) {
  if (!RUGCHECK) return { ok: true };
  if (rcCache.has(mint)) return rcCache.get(mint);
  let res;
  try {
    const j = await api(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`);
    const risks = Array.isArray(j?.risks) ? j.risks : [];
    const bad = risks.filter(r => r?.level === "danger" || /mint authority|freeze authority|honeypot/i.test(r?.name || ""));
    if (j?.rugged === true) bad.push({ name: "marked as rugged" });
    res = bad.length
      ? { ok: false, fatal: true, why: bad.map(r => r.name).join("; ") }
      : { ok: true, why: risks.length ? "warnings: " + risks.map(r => r.name).join("; ") : "clean" };
  } catch (e) {
    res = RUGCHECK_STRICT ? { ok: false, fatal: false, why: "RugCheck unavailable (" + e.message + ")" } : { ok: true, why: "RugCheck unavailable, skipped" };
  }
  await sleep(600);
  rcCache.set(mint, res);
  return res;
}

function sizeFor(e, equity, invested, cashLeft) {
  const pct = e.level === "LOW" ? PCT_LOW : e.level === "MEDIUM" ? PCT_MED : PCT_HIGH;
  let usd = equity * pct;
  if (MAX_USD > 0) usd = Math.min(usd, MAX_USD);
  usd = Math.min(usd, equity * MAX_EXPOSURE - invested, cashLeft);
  usd = Math.floor(usd * 100) / 100;
  return { usd: usd >= MIN_USD ? usd : 0, pct };
}

// ---- database (paged, because Supabase returns max 1000 rows per request) ----
async function fetchAll(table, orderCol) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await db.from(table).select("*").eq("user_id", USER).order(orderCol, { ascending: true }).range(from, from + 999);
    if (r.error) throw new Error(table + ": " + r.error.message);
    out.push(...r.data);
    if (r.data.length < 1000) break;
  }
  return out;
}
async function load() {
  const [tokens, trades, decisions, ledger] = await Promise.all([
    fetchAll("tokens", "id"), fetchAll("paper_trades", "executed_at"),
    fetchAll("token_decisions", "created_at"), fetchAll("portfolio_ledger", "created_at"),
  ]);
  return { tokens, trades, decisions, ledger };
}
async function peakSince(tokenId, since) {     // highest price ever snapshotted since entry
  const r = await db.from("token_snapshots").select("price").eq("user_id", USER).eq("token_id", tokenId)
    .gte("observed_at", since.toISOString()).order("price", { ascending: false }).limit(1);
  if (r.error) throw new Error("token_snapshots: " + r.error.message);
  return r.data?.[0] ? +r.data[0].price : 0;
}
const legacy = r => r.event_type === "INITIAL_CAPITAL" || (r.event_type === "DEPOSIT" && r.description === "PIERWSZY_PRZELEW_PAPER_TRADING");
const cash = (S, until) => S.ledger.reduce((s, r) => {
  if (legacy(r)) return s;
  if (until && new Date(r.created_at) >= until) return s;
  const a = Math.abs(+r.amount_usd || 0);
  return ["DEPOSIT", "TRADE_SELL"].includes(r.event_type) ? s + a : ["TRADE_BUY", "WITHDRAWAL"].includes(r.event_type) ? s - a : s;
}, 0);
function positions(S, until) {
  const m = {};
  const trades = S.trades.filter(t => !until || new Date(t.executed_at) < until)
    .sort((a, b) => new Date(a.executed_at) - new Date(b.executed_at));
  for (const t of trades) {
    const p = m[t.token_id] || (m[t.token_id] = { qty: 0, entry: 0, firstAt: null });
    if (t.side === "BUY") {
      if (p.qty <= 1e-8) { p.firstAt = new Date(t.executed_at); p.entry = +t.price; }   // new cycle (also after re-entry)
      p.qty += +t.quantity;
    } else {
      p.qty = Math.max(0, p.qty - +t.quantity);
    }
  }
  return m;
}
const openOf = pos => Object.entries(pos).filter(([, p]) => p.qty > 1e-8);
const equityAtCost = (S, until) => cash(S, until) + openOf(positions(S, until)).reduce((s, [, p]) => s + p.qty * p.entry, 0);

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
async function tokenFor(S, p) {
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

// ---- mark-to-market: open positions valued at the current price ----
async function markToMarket(S) {
  const open = openOf(positions(S));
  let value = 0;
  if (open.length) {
    const toks = open.map(([id]) => S.tokens.find(t => t.id === id)).filter(Boolean);
    const best = bestPair(await pairsFor(toks.map(t => t.mint_address)));
    for (const [id, p] of open) {
      const t = S.tokens.find(x => x.id === id), pr = t && best[t.mint_address];
      const price = pr && +pr.priceUsd > 0 ? +pr.priceUsd : p.entry;   // no price -> value at cost
      value += p.qty * price;
    }
  }
  return { count: open.length, value };
}

// ---- trade statistics: win rate, average win/loss, per risk level ----
function stats(S) {
  const sorted = S.trades.slice().sort((a, b) => new Date(a.executed_at) - new Date(b.executed_at));
  const byTok = {};
  for (const t of sorted) (byTok[t.token_id] || (byTok[t.token_id] = [])).push(t);
  const cycles = [];
  for (const [tid, list] of Object.entries(byTok)) {
    let cur = null, qty = 0;
    for (const t of list) {
      const q = +t.quantity, gross = +t.price * q, fee = +t.fee || 0, slip = +t.slippage || 0;
      if (t.side === "BUY") {
        if (!cur) cur = { tid, at: new Date(t.executed_at), cost: 0, proceeds: 0 };
        cur.cost += gross + fee + slip; qty += q;
      } else if (cur) {
        cur.proceeds += gross - fee - slip; qty -= q;
        if (qty <= 1e-8) { cycles.push(cur); cur = null; qty = 0; }
      }
    }
  }
  const entries = S.decisions.filter(d => /risk (LOW|MEDIUM|HIGH)/.test(d.reason || ""));
  for (const c of cycles) {
    c.pnl = c.proceeds - c.cost; c.ret = c.cost > 0 ? c.proceeds / c.cost - 1 : 0;
    const e = entries.filter(d => d.token_id === c.tid && new Date(d.created_at) <= new Date(c.at.getTime() + 120000))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    c.level = e ? e.reason.match(/risk (LOW|MEDIUM|HIGH)/)[1] : "?";
  }
  const line = (name, list) => {
    if (!list.length) return null;
    const w = list.filter(c => c.pnl > 0), l = list.filter(c => c.pnl <= 0);
    const avg = a => (a.length ? (a.reduce((s, c) => s + c.ret, 0) / a.length * 100).toFixed(1) + "%" : "-");
    return `${name}: ${list.length} trades, win rate ${(w.length / list.length * 100).toFixed(0)}%, avg win ${avg(w)}, avg loss ${avg(l)}, P&L $${list.reduce((s, c) => s + c.pnl, 0).toFixed(2)}`;
  };
  log("STATS", line("ALL", cycles) || "no closed trades yet");
  for (const lv of ["LOW", "MEDIUM", "HIGH"]) { const ln = line(lv, cycles.filter(c => c.level === lv)); if (ln) log("STATS", ln); }
}

// ---- daily scan: picks the best coins of the day ----
async function scan(S) {
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);

  // daily loss breaker (realized): no new entries after losing too much since day start
  if (DAILY_LOSS_LIMIT > 0) {
    const eqStart = equityAtCost(S, dayStart), eqNow = equityAtCost(S);
    if (eqStart > 0 && (eqNow - eqStart) / eqStart <= -DAILY_LOSS_LIMIT) {
      return log(`DAILY LOSS BREAKER: ${(((eqNow - eqStart) / eqStart) * 100).toFixed(1)}% today (limit -${DAILY_LOSS_LIMIT * 100}%), no new entries until tomorrow (UTC)`);
    }
  }

  const today = S.decisions.filter(d => new Date(d.created_at) >= dayStart && (d.reason || "").startsWith("[BOT]") && !/sold|exit|stop/i.test(d.reason));
  const picks = today.filter(d => d.decision === "WEJŚĆ").length, waits = today.filter(d => d.decision === "POCZEKAĆ").length;
  if (picks >= DAILY_PICKS && waits >= DAILY_WATCH) return log("daily quota done");
  const h = new Date().getUTCHours();
  const minScore = picks >= DAILY_PICKS ? 70 : h >= 18 ? 45 : h >= 12 ? 55 : 70;
  const pos = positions(S);
  const known = new Set(S.tokens.map(t => t.mint_address));
  const notHeld = t => !(pos[t.id]?.qty > 1e-8) && !isBlacklisted(S, t.id) && cooldownLeftMin(S, t.id) <= 0;
  const lastDec = {};                                       // token -> time of its latest decision
  for (const d of S.decisions) { const ts = +new Date(d.created_at); if (!(lastDec[d.token_id] >= ts)) lastDec[d.token_id] = ts; }
  // exited tokens may come back, and tokens on the WAIT list are re-checked (recent ones only)
  const reentry = S.tokens.filter(t => t.status === "WYJŚĆ" && notHeld(t)).map(t => t.mint_address);
  const watch = S.tokens.filter(t => t.status === "POCZEKAĆ" && notHeld(t) && Date.now() - (lastDec[t.id] || 0) <= WATCH_HOURS * 36e5).map(t => t.mint_address);
  step = "discover tokens";
  const addrs = [...new Set([...(await discover()).filter(a => !known.has(a)), ...reentry, ...watch])];
  log(`scan: ${addrs.length} candidates (${reentry.length} re-entry, ${watch.length} waiting), min score ${minScore}`);
  step = "fetch pair data";
  const ev = Object.values(bestPair(await pairsFor(addrs))).map(p => ({ p, ...evaluate(p) }));
  const ok = ev.filter(e => !e.risks.length).sort((a, b) => b.score - a.score);
  log(`passed risk filters: ${ok.length}/${ev.length}; rejected: ${ev.length - ok.length}`);

  step = "equity";
  const mtm = await markToMarket(S);                        // open positions at CURRENT price
  let freeSlots = MAX_OPEN - mtm.count, c = cash(S), invested = mtm.value;
  const equity = c + invested;
  log(`equity $${equity.toFixed(2)} (cash $${c.toFixed(2)} + open positions $${invested.toFixed(2)}), open ${mtm.count}`);

  // WAIT = saved once; already-waiting tokens are not written again (no spam, no quota burn)
  const handled = new Set();
  const park = async (e, reason, trigger) => {
    handled.add(e.p.baseToken.address);
    const tok = await tokenFor(S, e.p);
    if (tok.status === "POCZEKAĆ") return;
    await snapshot(tok.id, e.p);
    await decide(tok.id, "POCZEKAĆ", reason, trigger || "Re-check momentum and buy pressure");
    log("WAIT", tok.ticker, "-", reason.slice(0, 90));
  };

  step = "save picks";
  let entered = 0;
  for (const e of ok.filter(e => e.score >= minScore)) {
    if (picks + entered >= DAILY_PICKS) break;
    const mom = momentum(e.p);
    if (mom) { await park(e, `score ${e.score}/100 but no momentum confirmation: ${mom}. ${e.note}`, "Wait for a 5m uptrend with buyers ahead"); continue; }
    if (freeSlots <= 0) { await park(e, `score ${e.score}/100 but no free slot. ${e.note}`); continue; }
    const { usd, pct } = sizeFor(e, equity, invested, c);
    if (!usd) { await park(e, `score ${e.score}/100 but no cash or exposure room. ${e.note}`); continue; }
    const rc = await rugCheck(e.p.baseToken.address);
    if (!rc.ok) {
      if (rc.fatal) {                                       // real danger: never look at it again
        handled.add(e.p.baseToken.address);
        const tok = await tokenFor(S, e.p);
        await decide(tok.id, "POCZEKAĆ", `rugcheck danger: ${rc.why} [BLACKLIST]`);
        log("REJECT (rugcheck)", tok.ticker, "-", rc.why);
      } else await park(e, `score ${e.score}/100 but ${rc.why}. ${e.note}`);
      continue;
    }
    const tok = await tokenFor(S, e.p);
    await snapshot(tok.id, e.p);
    await paperBuy(tok.id, tok.ticker, +e.p.priceUsd, usd, e.p.liquidity?.usd || 0);
    handled.add(e.p.baseToken.address);
    await decide(tok.id, "WEJŚĆ", `score ${e.score}/100, risk ${e.level}, size $${usd.toFixed(2)} (${(usd / equity * 100).toFixed(1)}% of portfolio, base ${(pct * 100).toFixed(1)}%). rugcheck ${rc.why || "off"}. ${e.note}`,
      `Hold while price rises; sell all on a ${TRAIL_WIDE}% / ${TRAIL_PCT}% / ${TRAIL_TIGHT}% drop from the peak (armed after ${ARM_X}x)`, `Risk level ${e.level}. Stop-loss at -${Math.round((1 - STOP) * 100)}% until trailing is armed. Memecoin: can go to zero.`);
    freeSlots--; c -= usd; invested += usd; entered++;
    log("ENTER", tok.ticker, "score", e.score, "risk", e.level, "size $" + usd.toFixed(2));
  }
  let watched = 0;
  for (const e of ok.filter(e => e.score >= 45 && e.score < minScore && !handled.has(e.p.baseToken.address))) {
    if (waits + watched >= DAILY_WATCH) break;
    await park(e, `score ${e.score}/100, needs more time. ${e.note}`);
    watched++;
  }
}

// ---- manage open positions: let winners run, sell all on a trailing drop from the peak ----
async function manage(S) {
  const pos = positions(S);
  const toks = openOf(pos).map(([id]) => S.tokens.find(t => t.id === id)).filter(Boolean);
  if (!toks.length) return;
  const best = bestPair(await pairsFor(toks.map(t => t.mint_address)));
  for (const t of toks) {
    const pr = best[t.mint_address], p = pos[t.id];
    if (!pr || !(+pr.priceUsd > 0)) { log("no price for", t.ticker); continue; }
    const price = +pr.priceUsd, x = price / p.entry;
    const liq = pr.liquidity?.usd || 0;
    await snapshot(t.id, pr);                               // saved first, so the peak query below includes the current price
    const peak = Math.max(price, await peakSince(t.id, p.firstAt));
    const peakX = peak / p.entry;
    const armed = peakX >= ARM_X;
    const trailPct = peakX >= TIER_HI_X ? TRAIL_TIGHT : peakX >= TIER_LO_X ? TRAIL_PCT : TRAIL_WIDE;
    const trailStop = peak * (1 - trailPct / 100);

    const exitAll = async (why, forceBlacklist) => {
      await paperSell(t.id, t.ticker, price, p.qty, why, liq);
      const bl = forceBlacklist || x <= BL_LOSS;
      await decide(t.id, "WYJŚĆ", `exit all (${why}) at ${x.toFixed(2)}x, peak ${peakX.toFixed(2)}x${bl ? " [BLACKLIST]" : ""}`);
      log("EXIT", t.ticker, why, x.toFixed(4) + "x", "peak", peakX.toFixed(4) + "x", bl ? "-> BLACKLISTED" : "");
    };

    if (liq < RUG_LIQ || x <= 0.2) { await exitAll(`rug pull suspected, liquidity $${Math.round(liq)}`, true); continue; }

    if (armed) {
      if (price <= trailStop) await exitAll(`trailing stop ${trailPct}% below peak ${peakX.toFixed(4)}x`);
      else log("HOLD", t.ticker, x.toFixed(4) + "x", "peak", peakX.toFixed(4) + "x", `(trail ${trailPct}%)`);
    } else if (x <= STOP) {
      await exitAll("stop-loss");
    } else {
      log("HOLD (not armed)", t.ticker, x.toFixed(4) + "x");
    }
  }
}

async function main() {
  if (!BOT_EMAIL || !BOT_PASSWORD) throw new Error("secret BOT_EMAIL or BOT_PASSWORD is empty");
  step = "login";
  const r = await db.auth.signInWithPassword({ email: BOT_EMAIL, password: BOT_PASSWORD });
  if (r.error) throw new Error(r.error.message);
  USER = r.data.user.id;
  log("bot v4 started (paper trading only), user", r.data.user.email, `| trail ${TRAIL_WIDE}/${TRAIL_PCT}/${TRAIL_TIGHT}% armed at ${ARM_X}x | poll ${POLL_SEC}s | rugcheck ${RUGCHECK ? "on" : "off"}`);
  if (process.argv.includes("--once")) {
    step = "load data";
    const S1 = await load();
    step = "manage positions";
    await manage(S1);
    step = "load data (scan)";
    const S2 = await load();
    step = "scan";
    await scan(S2);
    step = "stats";
    stats(await load());
    log("run finished");
    return;
  }
  let lastScan = 0;
  for (;;) {
    try {
      await manage(await load());
      if (Date.now() - lastScan > 30 * 60e3) {
        await scan(await load()); lastScan = Date.now();
        stats(await load());
      }
    } catch (e) { log("cycle error:", e.message); }
    await sleep(POLL_SEC * 1000);
  }
}
main().catch(e => {
  console.log("::error::[" + step + "] " + String(e?.message || e).replace(/\s+/g, " "));
  process.exit(1);
});
