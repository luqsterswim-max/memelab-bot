// MemeLab AI — paper trading bot v8 (NO real money, NO wallet, NO private keys)
// v8: pullback entry, liquidity-drop exit, many more token sources (DexScreener + GeckoTerminal + search),
//     positions are still checked while the scan runs. (+ v7: --minutes loop, dead-pair exit, creator ban,
//     backtest, 2nd partial, size scaling, holder filter, daily report)
// Run:  npm i @supabase/supabase-js
//   node Bot.mjs --minutes=345   (loop for N minutes, then exit; use with GitHub Actions)
//   node Bot.mjs                 (loop forever, e.g. on a server)
//   node Bot.mjs --once          (one pass; pullback entry is off in this mode)
//   node Bot.mjs --backtest      (replays saved snapshots with many exit settings)
import { createClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_URL || "https://wduflmaakgoemxsegnbp.supabase.co";
const KEY = process.env.SUPABASE_KEY || "sb_publishable_muU19iaA6GTGNIvX6orqDg_ZO-50q5e";
const { BOT_EMAIL, BOT_PASSWORD } = process.env;
const WEBHOOK = process.env.DISCORD_WEBHOOK || "";
const ONCE = process.argv.includes("--once");

// ================= SETTINGS (change freely, or override with env vars) =================
const num = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" ? +process.env[k] : d);

// -- position sizing --
const PCT_LOW = num("PCT_LOW", 0.30);
const PCT_MED = num("PCT_MED", 0.15);
const PCT_HIGH = num("PCT_HIGH", 0.05);
const MAX_POS_PCT = num("MAX_POS_PCT", 0.35);
const MAX_EXPOSURE = num("MAX_EXPOSURE", 0.80);
const MIN_USD = num("MIN_USD", 10);
const MAX_USD = num("MAX_USD", 0);
const MAX_OPEN = num("MAX_OPEN", 8);

// -- size scaling --
const SCALE_SCORE = num("SCALE_SCORE", 1);
const SCALE_STREAK = num("SCALE_STREAK", 1);

// -- scanning / token sources --
const SCAN_SEC = num("SCAN_SEC", 300);
const MIN_SCORE = num("MIN_SCORE", 60);
const WATCH_MIN = num("WATCH_MIN", 45);
const MAX_CAND = num("MAX_CAND", 300);          // max candidates checked per scan
const GECKO = num("GECKO", 1);                  // 1 = also use GeckoTerminal (new / trending / top volume pools)
const SEARCH_ON = num("SEARCH_ON", 1);          // 1 = also use DexScreener search with keywords
const SEARCH_QUERIES = (process.env.SEARCH_QUERIES || "pump,pumpswap,raydium,meme,ai,cat,dog,pepe,trump,sol")
  .split(",").map(s => s.trim()).filter(Boolean);

// -- entry filters --
const LIQ_MIN = num("LIQ_MIN", 10000);
const VOL_MIN = num("VOL_MIN", 20000);
const AGE_MIN_H = num("AGE_MIN_H", 0.5);
const AGE_MAX_H = num("AGE_MAX_H", 168);
const MC_MIN = num("MC_MIN", 50000);
const MC_MAX = num("MC_MAX", 1e7);
const LIQ_MC_MIN = num("LIQ_MC_MIN", 0.03);
const TRADES_MIN = num("TRADES_MIN", 20);

// -- pullback entry: after a good signal wait for a dip from the recent high, buy on the bounce --
const PULLBACK = num("PULLBACK", 1);            // 1 = on (loop modes only), 0 = buy immediately
const PULL_MIN = num("PULL_MIN", 3);            // % dip below the high that must happen first
const PULL_MAX = num("PULL_MAX", 12);           // dip deeper than this = trend broken, signal dropped
const BOUNCE = num("BOUNCE", 1);                // % rise from the low of the dip needed to buy
const SIGNAL_MIN = num("SIGNAL_MIN", 60);       // signal expires after this many minutes
const MAX_SIGNALS = num("MAX_SIGNALS", 20);

// -- exits --
const STOP = num("STOP", 0.80);
const ARM_X = num("ARM_X", 1.10);
const TRAIL_WIDE = num("TRAIL_WIDE", 8);
const TRAIL_LOCK = num("TRAIL_LOCK", 5);
const TRAIL_PCT = num("TRAIL_PCT", 5);
const TRAIL_TIGHT = num("TRAIL_TIGHT", 3);
const TIER_LO_X = num("TIER_LO_X", 1.5);
const TIER_HI_X = num("TIER_HI_X", 3);
const LOCK_X = num("LOCK_X", 1.30);
const LOCK_FLOOR = num("LOCK_FLOOR", 1.06);
const FAST_DROP = num("FAST_DROP", 4);
const PARTIAL_X = num("PARTIAL_X", 1.5);
const PARTIAL_PCT = num("PARTIAL_PCT", 0.5);
const PARTIAL2_X = num("PARTIAL2_X", 3);
const PARTIAL2_PCT = num("PARTIAL2_PCT", 0.25);
const RUG_LIQ = num("RUG_LIQ", 2500);
const LIQ_DROP = num("LIQ_DROP", 30);           // exit when liquidity falls this % within LIQ_WINDOW_MIN (0 = off)
const LIQ_WINDOW_MIN = num("LIQ_WINDOW_MIN", 10);
const POLL_SEC = num("POLL_SEC", 20);
const SNAP_SEC = num("SNAP_SEC", 60);
const NOPRICE_MIN = num("NOPRICE_MIN", 3);
const NOPRICE_RECOVERY = num("NOPRICE_RECOVERY", 0.05);

// -- entry momentum confirmation (used before a signal / immediate entry) --
const MOM_M5_MIN = num("MOM_M5_MIN", 0.3);
const MOM_M5_MAX = num("MOM_M5_MAX", 25);
const MOM_MIN_TRADES = num("MOM_MIN_TRADES", 10);
const MOM_BUY_RATIO = num("MOM_BUY_RATIO", 1.0);

// -- RugCheck + holder filter + creator blacklist --
const RUGCHECK = num("RUGCHECK", 1);
const RUGCHECK_STRICT = num("RUGCHECK_STRICT", 1);
const HOLDER_FILTER = num("HOLDER_FILTER", 1);
const MAX_TOP1 = num("MAX_TOP1", 15);
const MAX_TOP10 = num("MAX_TOP10", 45);
const MIN_HOLDERS = num("MIN_HOLDERS", 50);
const CREATOR_BAN = num("CREATOR_BAN", 1);

// -- report / waiting list / cooldown --
const REPORT_HOUR = num("REPORT_HOUR", 21);
const WATCH_HOURS = num("WATCH_HOURS", 24);
const COOLDOWN_MIN = num("COOLDOWN_MIN", 30);
const COOLDOWN_STOP_MIN = num("COOLDOWN_STOP_MIN", 60);
const BL_LOSS = num("BL_LOSS", 0.40);

// -- simulated costs --
const FEE = num("FEE", 0.005), SLIP = num("SLIP", 0.015);
// ========================================================================================

const PARAMS = { STOP, ARM_X, TRAIL_WIDE, TRAIL_LOCK, TRAIL_PCT, TRAIL_TIGHT, TIER_LO_X, TIER_HI_X, LOCK_X, LOCK_FLOOR, FAST_DROP, PARTIAL_X, PARTIAL_PCT, PARTIAL2_X, PARTIAL2_PCT };
const pullbackOn = !!PULLBACK && !ONCE;

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

async function notify(text) {
  if (!WEBHOOK) return;
  try {
    await fetch(WEBHOOK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text.slice(0, 1900) }) });
  } catch (e) { log("notify failed:", e.message); }
}

async function api(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(r.status + " " + url);
  return r.json();
}
// tick (optional) is called between requests, so open positions keep being checked during long scans
async function pairsFor(addrs, tick) {
  const out = [];
  for (let i = 0; i < addrs.length; i += 30) {
    const j = await api(`https://api.dexscreener.com/tokens/v1/solana/${addrs.slice(i, i + 30).join(",")}`);
    if (Array.isArray(j)) out.push(...j);
    if (i + 30 < addrs.length) { await sleep(1100); if (tick) await tick(); }
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

// ---- token sources: DexScreener lists + keyword search + GeckoTerminal pools ----
const STABLE = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);
const GECKO_URLS = [
  "https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1",
  "https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=2",
  "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=1h",
  "https://api.geckoterminal.com/api/v2/networks/solana/pools?page=1&sort=h24_volume_usd_desc",
  "https://api.geckoterminal.com/api/v2/networks/solana/pools?page=2&sort=h24_volume_usd_desc",
];
async function discover(tick) {
  const set = new Set();
  const add = a => { if (typeof a === "string" && a && !STABLE.has(a)) set.add(a); };
  const run = async (label, fn, gap) => {
    const before = set.size;
    try { await fn(); } catch (e) { log(`discover ${label} failed:`, e.message); }
    log(`discover ${label}: +${set.size - before}`);
    await sleep(gap);
    if (tick) await tick();
  };
  const dexLists = ["token-profiles/latest/v1", "token-boosts/latest/v1", "token-boosts/top/v1", "community-takeovers/latest/v1", "ads/latest/v1"];
  for (const path of dexLists) {
    await run("dex " + path.split("/")[0], async () => {
      const j = await api("https://api.dexscreener.com/" + path);
      (Array.isArray(j) ? j : []).forEach(x => x?.chainId === "solana" && add(x.tokenAddress));
    }, 1100);
  }
  if (SEARCH_ON) {
    for (const q of SEARCH_QUERIES) {
      await run("search " + q, async () => {
        const j = await api("https://api.dexscreener.com/latest/dex/search?q=" + encodeURIComponent(q));
        (j?.pairs || []).forEach(p => p?.chainId === "solana" && add(p.baseToken?.address));
      }, 450);
    }
  }
  if (GECKO) {
    for (const u of GECKO_URLS) {
      await run("gecko " + u.split("/").pop().split("?")[0], async () => {
        const j = await api(u);
        (j?.data || []).forEach(d => {
          const id = d?.relationships?.base_token?.data?.id;
          if (typeof id === "string" && id.startsWith("solana_")) add(id.slice(7));
        });
      }, 2200);
    }
  }
  log(`discover: ${set.size} unique tokens from all sources`);
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
  if (liq < LIQ_MIN) risks.push(`liquidity under $${LIQ_MIN}`);
  if (vol < VOL_MIN) risks.push(`24h volume under $${VOL_MIN}`);
  if (age < AGE_MIN_H) risks.push(`pair younger than ${AGE_MIN_H}h`);
  if (age > AGE_MAX_H) risks.push(`pair older than ${AGE_MAX_H}h`);
  if (mc < MC_MIN || mc > MC_MAX) risks.push(`market cap outside $${MC_MIN}-$${MC_MAX}`);
  if (mc && liq / mc < LIQ_MC_MIN) risks.push(`liquidity under ${LIQ_MC_MIN * 100}% of market cap`);
  if (ch1 > 150) risks.push("already pumped over 150% in 1h");
  if (ch24 < -40) risks.push("down over 40% in 24h");
  if (b + s < TRADES_MIN) risks.push(`under ${TRADES_MIN} trades in 1h`);
  if (s > b * 1.5 && b + s >= TRADES_MIN) risks.push("sells dominate in 1h");
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

// ---- entry confirmation ----
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

// ---- RugCheck (full report): authorities, honeypot, danger risks, holders, creator ----
const rcCache = new Map();
async function rugCheck(mint) {
  if (!RUGCHECK) return { ok: true };
  const hit = rcCache.get(mint);
  if (hit && Date.now() - hit.t < 30 * 60e3) return hit.res;
  let res;
  try {
    const j = await api(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`);
    const creator = typeof j?.creator === "string" && j.creator ? j.creator : null;
    const risks = Array.isArray(j?.risks) ? j.risks : [];
    const bad = risks.filter(r => r?.level === "danger" || /mint authority|freeze authority|honeypot/i.test(r?.name || ""));
    if (j?.rugged === true) bad.push({ name: "marked as rugged" });
    const dangerCount = bad.length;

    let holderNote = "holders n/a";
    if (HOLDER_FILTER && Array.isArray(j?.topHolders) && j.topHolders.length) {
      const pool = new Set();
      for (const m of j?.markets || []) for (const k of [m?.pubkey, m?.liquidityA, m?.liquidityB]) if (k) pool.add(k);
      const pcts = j.topHolders.filter(h => !pool.has(h?.address) && !pool.has(h?.owner))
        .map(h => +h?.pct || 0).sort((a, b) => b - a);
      const top1 = pcts[0] || 0, top10 = pcts.slice(0, 10).reduce((s, v) => s + v, 0);
      const total = +j?.totalHolders || 0;
      holderNote = `top1 ${top1.toFixed(1)}%, top10 ${top10.toFixed(1)}%${total ? ", holders " + total : ""}`;
      if (top1 > MAX_TOP1) bad.push({ name: `top wallet holds ${top1.toFixed(1)}% (max ${MAX_TOP1}%)` });
      if (top10 > MAX_TOP10) bad.push({ name: `top 10 wallets hold ${top10.toFixed(1)}% (max ${MAX_TOP10}%)` });
      if (total && total < MIN_HOLDERS) bad.push({ name: `only ${total} holders (min ${MIN_HOLDERS})` });
    }
    res = bad.length
      ? { ok: false, fatal: true, creator, creatorBan: dangerCount > 0, why: bad.map(r => r.name).join("; ") + ` | ${holderNote}` }
      : { ok: true, creator, why: (risks.length ? "warnings: " + risks.map(r => r.name).join("; ") : "clean") + ` | ${holderNote}` };
  } catch (e) {
    res = RUGCHECK_STRICT ? { ok: false, fatal: false, why: "RugCheck unavailable (" + e.message + ")" } : { ok: true, why: "RugCheck unavailable, skipped" };
  }
  await sleep(600);
  rcCache.set(mint, { t: Date.now(), res });
  return res;
}

// ---- position size: base % by risk level x scaling (score, win/loss streak) ----
function sizeMult(score, cycles) {
  let m = 1;
  if (SCALE_SCORE) m *= clamp(0.7 + (score - 60) / 40 * 0.6, 0.7, 1.3);
  if (SCALE_STREAK) {
    const last = cycles.slice().sort((a, b) => a.closedAt - b.closedAt).slice(-3);
    if (last.length === 3 && last.every(c => c.pnl <= 0)) m *= 0.6;
    else if (last.length === 3 && last.every(c => c.pnl > 0)) m *= 1.2;
  }
  return clamp(m, 0.4, 1.5);
}
function sizeFor(e, equity, invested, cashLeft, mult) {
  const pct = e.level === "LOW" ? PCT_LOW : e.level === "MEDIUM" ? PCT_MED : PCT_HIGH;
  let usd = equity * pct * mult;
  usd = Math.min(usd, equity * MAX_POS_PCT);
  if (MAX_USD > 0) usd = Math.min(usd, MAX_USD);
  usd = Math.min(usd, equity * MAX_EXPOSURE - invested, cashLeft);
  usd = Math.floor(usd * 100) / 100;
  return { usd: usd >= MIN_USD ? usd : 0, pct };
}

// ---- database (paged, Supabase returns max 1000 rows per request) ----
async function fetchAll(table, orderCol, cols = "*") {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await db.from(table).select(cols).eq("user_id", USER).order(orderCol, { ascending: true }).range(from, from + 999);
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
async function peakSince(tokenId, since) {
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
    const p = m[t.token_id] || (m[t.token_id] = { qty: 0, entry: 0, firstAt: null, bought: 0, sold: 0 });
    const q = +t.quantity;
    if (t.side === "BUY") {
      if (p.qty <= 1e-8) { p.firstAt = new Date(t.executed_at); p.entry = +t.price; p.bought = 0; p.sold = 0; }
      p.qty += q; p.bought += q;
    } else {
      p.qty = Math.max(0, p.qty - q); p.sold += q;
    }
  }
  return m;
}
const openOf = pos => Object.entries(pos).filter(([, p]) => p.qty > 1e-8);

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

// ---- blacklist, creator blacklist & cooldown (derived from the decision log) ----
const isBlacklisted = (S, tokenId) => S.decisions.some(d => d.token_id === tokenId && /BLACKLIST/.test(d.reason || ""));
function bannedCreators(S) {
  const out = new Set();
  if (!CREATOR_BAN) return out;
  const banTok = new Set(S.decisions.filter(d => /\[CREATORBAN\]/.test(d.reason || "")).map(d => d.token_id));
  for (const d of S.decisions) {
    if (!banTok.has(d.token_id)) continue;
    const m = (d.reason || "").match(/creator:([1-9A-HJ-NP-Za-km-z]{32,44})/);
    if (m) out.add(m[1]);
  }
  return out;
}
function cooldownLeftMin(S, tokenId) {
  const exits = S.decisions.filter(d => d.token_id === tokenId && d.decision === "WYJŚĆ")
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  if (!exits.length) return 0;
  const last = exits[0], wait = /stop-loss/i.test(last.reason || "") ? COOLDOWN_STOP_MIN : COOLDOWN_MIN;
  return Math.max(0, wait - (Date.now() - new Date(last.created_at)) / 6e4);
}

// ---- mark-to-market ----
async function markToMarket(S) {
  const open = openOf(positions(S));
  let value = 0, cost = 0;
  if (open.length) {
    const toks = open.map(([id]) => S.tokens.find(t => t.id === id)).filter(Boolean);
    const best = bestPair(await pairsFor(toks.map(t => t.mint_address)));
    for (const [id, p] of open) {
      const t = S.tokens.find(x => x.id === id), pr = t && best[t.mint_address];
      const price = pr && +pr.priceUsd > 0 ? +pr.priceUsd : p.entry;
      value += p.qty * price; cost += p.qty * p.entry;
    }
  }
  return { count: open.length, value, cost };
}

// ---- closed trade cycles ----
function closedCycles(S) {
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
        if (qty <= 1e-8) { cur.closedAt = new Date(t.executed_at); cycles.push(cur); cur = null; qty = 0; }
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
  return cycles;
}
function stats(S) {
  const cycles = closedCycles(S);
  const line = (name, list) => {
    if (!list.length) return null;
    const w = list.filter(c => c.pnl > 0), l = list.filter(c => c.pnl <= 0);
    const avg = a => (a.length ? (a.reduce((s, c) => s + c.ret, 0) / a.length * 100).toFixed(1) + "%" : "-");
    return `${name}: ${list.length} trades, win rate ${(w.length / list.length * 100).toFixed(0)}%, avg win ${avg(w)}, avg loss ${avg(l)}, P&L $${list.reduce((s, c) => s + c.pnl, 0).toFixed(2)}`;
  };
  log("STATS", line("ALL", cycles) || "no closed trades yet");
  for (const lv of ["LOW", "MEDIUM", "HIGH"]) { const ln = line(lv, cycles.filter(c => c.level === lv)); if (ln) log("STATS", ln); }
}

// ---- daily report (UTC day) ----
async function report(S) {
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const today = closedCycles(S).filter(c => c.closedAt >= dayStart);
  const buys = S.trades.filter(t => t.side === "BUY" && new Date(t.executed_at) >= dayStart).length;
  const wins = today.filter(c => c.pnl > 0);
  const pnl = today.reduce((s, c) => s + c.pnl, 0);
  const name = c => (S.tokens.find(t => t.id === c.tid)?.ticker || "?");
  const best = today.slice().sort((a, b) => b.pnl - a.pnl)[0], worst = today.slice().sort((a, b) => a.pnl - b.pnl)[0];
  const mtm = await markToMarket(S);
  const equity = cash(S) + mtm.value;
  const lines = [
    `DAILY REPORT ${dayStart.toISOString().slice(0, 10)}`,
    `entries today: ${buys} | closed today: ${today.length} (wins ${wins.length}, losses ${today.length - wins.length}, win rate ${today.length ? (wins.length / today.length * 100).toFixed(0) : 0}%)`,
    `realized P&L today: $${pnl.toFixed(2)}`,
    best ? `best: ${name(best)} $${best.pnl.toFixed(2)} (${(best.ret * 100).toFixed(1)}%) | worst: ${name(worst)} $${worst.pnl.toFixed(2)} (${(worst.ret * 100).toFixed(1)}%)` : "no closed trades today",
    `open positions: ${mtm.count}, unrealized P&L $${(mtm.value - mtm.cost).toFixed(2)}`,
    `equity (mark-to-market): $${equity.toFixed(2)} (cash $${cash(S).toFixed(2)})`,
  ];
  lines.forEach(l => log("REPORT", l));
  await notify(lines.join("\n"));
}

// =====================================================================================
// EXIT RULES — one pure function used by the live bot AND by the backtest
// =====================================================================================
function exitRule(s, P) {
  const { x, peakX, dropNow, soldFrac } = s;
  if (x <= P.STOP) return { exit: "stop-loss", partials: [] };
  const partials = [];
  const done1 = soldFrac >= P.PARTIAL_PCT - 0.01;
  const done2 = soldFrac >= P.PARTIAL_PCT + P.PARTIAL2_PCT - 0.01;
  if (P.PARTIAL_PCT > 0 && !done1 && x >= P.PARTIAL_X) partials.push({ pct: P.PARTIAL_PCT, at: P.PARTIAL_X });
  if (P.PARTIAL2_PCT > 0 && !done2 && x >= P.PARTIAL2_X) partials.push({ pct: P.PARTIAL2_PCT, at: P.PARTIAL2_X });
  const locked = peakX >= P.LOCK_X;
  if (locked && dropNow >= P.FAST_DROP) return { exit: `sudden drop ${dropNow.toFixed(1)}% after reaching ${peakX.toFixed(2)}x`, partials, locked };
  if (locked && x <= P.LOCK_FLOOR) return { exit: `profit floor ${P.LOCK_FLOOR}x after peak ${peakX.toFixed(2)}x`, partials, locked };
  let trailPct = null;
  if (peakX >= P.ARM_X) {
    trailPct = peakX >= P.TIER_HI_X ? P.TRAIL_TIGHT : peakX >= P.TIER_LO_X ? P.TRAIL_PCT : locked ? Math.min(P.TRAIL_LOCK, P.TRAIL_WIDE) : P.TRAIL_WIDE;
    let stopX = peakX * (1 - trailPct / 100);
    if (locked) stopX = Math.max(stopX, P.LOCK_FLOOR);
    if (x <= stopX) return { exit: `trailing stop ${trailPct}% below peak ${peakX.toFixed(4)}x`, partials, trailPct, locked };
  }
  return { exit: null, partials, trailPct, locked };
}

// ---- one place that opens a position (used by immediate entries and pullback entries) ----
// returns { ok:true, usd } | { ok:false, park:"reason" } | { ok:false, rejected:true }
async function enter(S, e, ctx, how) {
  const addr = e.p.baseToken.address;
  const known = S.tokens.find(t => t.mint_address === addr);
  if (known && positions(S)[known.id]?.qty > 1e-8) return { ok: false, rejected: true };   // already held
  const mult = sizeMult(e.score, ctx.cycles);
  const { usd, pct } = sizeFor(e, ctx.equity, ctx.invested, ctx.cash, mult);
  if (!usd) return { ok: false, park: `score ${e.score}/100 but no cash or exposure room. ${e.note}` };
  const rc = await rugCheck(addr);
  if (!rc.ok) {
    if (rc.fatal) {
      const tok = await tokenFor(S, e.p);
      if (rc.creatorBan && rc.creator) ctx.banned.add(rc.creator);
      await decide(tok.id, "POCZEKAĆ", `rugcheck/holders: ${rc.why} creator:${rc.creator || "unknown"} [BLACKLIST]${rc.creatorBan ? " [CREATORBAN]" : ""}`);
      log("REJECT (rugcheck/holders)", tok.ticker, "-", rc.why);
      return { ok: false, rejected: true };
    }
    return { ok: false, park: `score ${e.score}/100 but ${rc.why}. ${e.note}` };
  }
  if (CREATOR_BAN && rc.creator && ctx.banned.has(rc.creator)) {
    const tok = await tokenFor(S, e.p);
    await decide(tok.id, "POCZEKAĆ", `creator banned (earlier rug) creator:${rc.creator} [BLACKLIST]`);
    log("REJECT (creator banned)", tok.ticker, rc.creator);
    return { ok: false, rejected: true };
  }
  const tok = await tokenFor(S, e.p);
  await snapshot(tok.id, e.p);
  await paperBuy(tok.id, tok.ticker, +e.p.priceUsd, usd, e.p.liquidity?.usd || 0);
  await decide(tok.id, "WEJŚĆ", `score ${e.score}/100, risk ${e.level}, size $${usd.toFixed(2)} (${(usd / ctx.equity * 100).toFixed(1)}% of portfolio, base ${(pct * 100).toFixed(1)}% x${mult.toFixed(2)}). entry: ${how}. rugcheck ${rc.why || "off"}. creator:${rc.creator || "unknown"}. ${e.note}`,
    `Stop-loss -${Math.round((1 - STOP) * 100)}%; sell ${Math.round(PARTIAL_PCT * 100)}% at ${PARTIAL_X}x and ${Math.round(PARTIAL2_PCT * 100)}% at ${PARTIAL2_X}x; from +${Math.round((LOCK_X - 1) * 100)}% floor ${LOCK_FLOOR}x + sudden-drop exit; trailing ${TRAIL_WIDE}/${TRAIL_LOCK}/${TRAIL_PCT}/${TRAIL_TIGHT}%; liquidity drop ${LIQ_DROP}% in ${LIQ_WINDOW_MIN} min exit`,
    `Risk level ${e.level}. Memecoin: can go to zero.`);
  log("ENTER", tok.ticker, "score", e.score, "risk", e.level, "size $" + usd.toFixed(2), "mult", mult.toFixed(2), "|", how);
  await notify(`ENTER ${tok.ticker} $${usd.toFixed(2)} (score ${e.score}, risk ${e.level}, x${mult.toFixed(2)}) ${how}`);
  return { ok: true, usd };
}

// ---- pullback signals: good coin found -> wait for a dip -> buy on the bounce ----
const signals = new Map();   // mint -> { t0, high, low, reached, ticker }
function addSignal(p) {
  const mint = p.baseToken.address;
  if (signals.has(mint) || signals.size >= MAX_SIGNALS) return false;
  const price = +p.priceUsd;
  signals.set(mint, { t0: Date.now(), high: price, low: Infinity, reached: false, ticker: (p.baseToken.symbol || "?").toUpperCase() });
  log("SIGNAL", (p.baseToken.symbol || "?").toUpperCase(), `waiting for a ${PULL_MIN}-${PULL_MAX}% pullback and a ${BOUNCE}% bounce`);
  return true;
}
async function checkSignals(S) {
  if (!signals.size) return false;
  const pos = positions(S);
  const open = openOf(pos);
  const best = bestPair(await pairsFor([...signals.keys()]));
  const banned = bannedCreators(S), cycles = closedCycles(S);
  let freeSlots = MAX_OPEN - open.length;
  let c = cash(S), invested = open.reduce((s, [, p]) => s + p.qty * p.entry, 0);   // at cost
  let changed = false;
  for (const [mint, sg] of [...signals]) {
    if (Date.now() - sg.t0 > SIGNAL_MIN * 60e3) { signals.delete(mint); log("SIGNAL expired", sg.ticker); continue; }
    const p = best[mint];
    if (!p || !(+p.priceUsd > 0)) continue;
    const price = +p.priceUsd;
    sg.high = Math.max(sg.high, price);
    const dd = (sg.high - price) / sg.high * 100;
    if (dd >= PULL_MIN) { sg.reached = true; sg.low = Math.min(sg.low, price); }
    if (!sg.reached) continue;
    if ((sg.high - sg.low) / sg.high * 100 > PULL_MAX) { signals.delete(mint); log("SIGNAL dropped, fell over", PULL_MAX + "%:", sg.ticker); continue; }
    if (price < sg.low * (1 + BOUNCE / 100) || dd < PULL_MIN / 2) continue;           // no bounce yet (or already back near the high)
    if (freeSlots <= 0) continue;
    const tk = S.tokens.find(t => t.mint_address === mint);
    if (tk && (isBlacklisted(S, tk.id) || pos[tk.id]?.qty > 1e-8 || cooldownLeftMin(S, tk.id) > 0)) { signals.delete(mint); continue; }
    const e = { p, ...evaluate(p) };
    signals.delete(mint);
    if (e.risks.length || e.score < MIN_SCORE - 10) { log("SIGNAL cancelled", sg.ticker, "-", e.risks[0] || `score ${e.score}`); continue; }
    const r = await enter(S, e, { equity: c + invested, invested, cash: c, cycles, banned }, `pullback ${dd.toFixed(1)}% below the high, bounce from the low`);
    if (r.ok) { freeSlots--; c -= r.usd; invested += r.usd; changed = true; }
  }
  return changed;
}

// ---- scan ----
async function scan(S, tick) {
  const pos = positions(S);
  const known = new Set(S.tokens.map(t => t.mint_address));
  const banned = bannedCreators(S);
  const cycles = closedCycles(S);
  const notHeld = t => !(pos[t.id]?.qty > 1e-8) && !isBlacklisted(S, t.id) && cooldownLeftMin(S, t.id) <= 0;
  const lastDec = {};
  for (const d of S.decisions) { const ts = +new Date(d.created_at); if (!(lastDec[d.token_id] >= ts)) lastDec[d.token_id] = ts; }
  const reentry = S.tokens.filter(t => t.status === "WYJŚĆ" && notHeld(t)).map(t => t.mint_address);
  const watch = S.tokens.filter(t => (t.status === "POCZEKAĆ" || t.status === "ANALIZUJE") && notHeld(t) && Date.now() - (lastDec[t.id] || 0) <= WATCH_HOURS * 36e5).map(t => t.mint_address);
  step = "discover tokens";
  const found = (await discover(tick)).filter(a => !known.has(a));
  const addrs = [...new Set([...reentry, ...watch, ...found])].slice(0, MAX_CAND);
  log(`scan: ${addrs.length} candidates (${found.length} new, ${reentry.length} re-entry, ${watch.length} waiting), min score ${MIN_SCORE}, banned creators ${banned.size}, signals ${signals.size}`);
  step = "fetch pair data";
  const ev = Object.values(bestPair(await pairsFor(addrs, tick))).map(p => ({ p, ...evaluate(p) }));
  const ok = ev.filter(e => !e.risks.length).sort((a, b) => b.score - a.score);
  log(`passed risk filters: ${ok.length}/${ev.length}; rejected: ${ev.length - ok.length}`);
  const why = {};
  for (const e of ev) for (const r of e.risks) why[r] = (why[r] || 0) + 1;
  const top = Object.entries(why).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length) log("top rejection reasons:", top.map(([r, n]) => `${r} (${n})`).join("; "));

  step = "equity";
  const mtm = await markToMarket(S);
  let freeSlots = MAX_OPEN - mtm.count, c = cash(S), invested = mtm.value;
  const equity = c + invested;
  log(`equity $${equity.toFixed(2)} (cash $${c.toFixed(2)} + open positions $${invested.toFixed(2)}), open ${mtm.count}`);

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
  for (const e of ok.filter(e => e.score >= MIN_SCORE)) {
    const addr = e.p.baseToken.address;
    const mom = momentum(e.p);
    if (mom) { await park(e, `score ${e.score}/100 but no momentum confirmation: ${mom}. ${e.note}`, "Wait for a 5m uptrend with buyers ahead"); continue; }
    if (freeSlots <= 0) { await park(e, `score ${e.score}/100 but no free slot. ${e.note}`); continue; }
    if (pullbackOn) { addSignal(e.p); handled.add(addr); continue; }       // buy later, on the dip
    handled.add(addr);
    const r = await enter(S, e, { equity, invested, cash: c, cycles, banned }, "immediate (momentum confirmed)");
    if (r.ok) { freeSlots--; c -= r.usd; invested += r.usd; }
    else if (r.park) await park(e, r.park);
  }
  for (const e of ok.filter(e => e.score >= WATCH_MIN && e.score < MIN_SCORE && !handled.has(e.p.baseToken.address))) {
    await park(e, `score ${e.score}/100, needs more time. ${e.note}`);
  }
}

// ---- manage open positions (every POLL_SEC) ----
const mem = new Map();   // tokenId -> { key, peak, last, lastSnap, missSince, liqHist }
let lastManageAt = 0;
async function manage(S) {
  const t0 = Date.now();
  if (lastManageAt && t0 - lastManageAt > Math.max(90e3, POLL_SEC * 4e3)) log(`WARNING: positions were not checked for ${Math.round((t0 - lastManageAt) / 1000)}s`);
  lastManageAt = t0;
  const pos = positions(S);
  const toks = openOf(pos).map(([id]) => S.tokens.find(t => t.id === id)).filter(Boolean);
  if (!toks.length) return false;
  let changed = false;
  const best = bestPair(await pairsFor(toks.map(t => t.mint_address)));
  for (const t of toks) {
    const pr = best[t.mint_address], p = pos[t.id];
    const havePrice = !!pr && +pr.priceUsd > 0;

    const key = p.firstAt.getTime();
    let m = mem.get(t.id);
    if (!m || m.key !== key) {
      const base = havePrice ? +pr.priceUsd : p.entry;
      m = { key, peak: Math.max(base, await peakSince(t.id, p.firstAt)), last: base, lastSnap: 0, missSince: 0, liqHist: [] };
      mem.set(t.id, m);
    }

    let price, liq;
    if (havePrice) {
      price = +pr.priceUsd; liq = pr.liquidity?.usd || 0; m.missSince = 0;
    } else {
      if (!m.missSince) m.missSince = Date.now();
      const mins = (Date.now() - m.missSince) / 6e4;
      log("no price for", t.ticker, `(${mins.toFixed(1)} min)`);
      if (mins < NOPRICE_MIN) continue;
      price = m.last * NOPRICE_RECOVERY; liq = 0;
    }
    const x = price / p.entry;
    const prev = m.last;
    let liqDrop = 0;
    if (havePrice) {
      m.last = price; m.peak = Math.max(m.peak, price);
      if (Date.now() - m.lastSnap >= SNAP_SEC * 1000) { await snapshot(t.id, pr); m.lastSnap = Date.now(); }
      const tn = Date.now();
      m.liqHist = m.liqHist.filter(h => tn - h.t <= LIQ_WINDOW_MIN * 60e3);
      m.liqHist.push({ t: tn, liq });
      const winMax = Math.max(...m.liqHist.map(h => h.liq));
      liqDrop = winMax > 0 ? (winMax - liq) / winMax * 100 : 0;
    }
    const peakX = m.peak / p.entry;
    const dropNow = havePrice && prev > 0 ? (prev - price) / prev * 100 : 0;

    // o.bl = blacklist the token, o.ban = also ban its creator
    const exitAll = async (why, o = {}) => {
      await paperSell(t.id, t.ticker, price, p.qty, why, liq);
      const bl = o.bl || x <= BL_LOSS;
      await decide(t.id, "WYJŚĆ", `exit all (${why}) at ${x.toFixed(2)}x, peak ${peakX.toFixed(2)}x${bl ? " [BLACKLIST]" : ""}${o.ban ? " [CREATORBAN]" : ""}`);
      log("EXIT", t.ticker, why, x.toFixed(4) + "x", "peak", peakX.toFixed(4) + "x", bl ? "-> BLACKLISTED" : "");
      await notify(`EXIT ${t.ticker}: ${why} at ${x.toFixed(2)}x (peak ${peakX.toFixed(2)}x)`);
      mem.delete(t.id); changed = true;
    };

    if (!havePrice) { await exitAll(`no price data for ${NOPRICE_MIN} min, pair dead`, { bl: true, ban: true }); continue; }
    if (liq < RUG_LIQ || x <= 0.2) { await exitAll(`rug pull suspected, liquidity $${Math.round(liq)}`, { bl: true, ban: true }); continue; }
    if (LIQ_DROP > 0 && liqDrop >= LIQ_DROP) {
      await exitAll(`liquidity dropped ${liqDrop.toFixed(0)}% within ${LIQ_WINDOW_MIN} min`, { bl: true, ban: liqDrop >= 50 });
      continue;
    }

    const rule = exitRule({ x, peakX, dropNow, soldFrac: p.bought > 0 ? p.sold / p.bought : 0 }, PARAMS);
    for (const pt of rule.partials) {
      const q = Math.min(p.qty, p.bought * pt.pct);
      if (q <= 1e-8) continue;
      await paperSell(t.id, t.ticker, price, q, `partial take-profit ${Math.round(pt.pct * 100)}% at ${x.toFixed(2)}x`, liq);
      p.qty -= q; p.sold += q; changed = true;
      log("PARTIAL", t.ticker, `sold ${Math.round(pt.pct * 100)}% of position at ${x.toFixed(4)}x`);
      await notify(`PARTIAL ${t.ticker}: sold ${Math.round(pt.pct * 100)}% at ${x.toFixed(2)}x`);
    }
    if (rule.exit && p.qty > 1e-8) { await exitAll(rule.exit); continue; }
    if (rule.trailPct) log("HOLD", t.ticker, x.toFixed(4) + "x", "peak", peakX.toFixed(4) + "x", `(trail ${rule.trailPct}%${rule.locked ? ", profit locked" : ""})`);
    else log("HOLD (not armed)", t.ticker, x.toFixed(4) + "x");
  }
  return changed;
}

// =====================================================================================
// BACKTEST: replays saved price snapshots of past entries with many exit settings
// =====================================================================================
function entriesOf(S) {
  const sorted = S.trades.slice().sort((a, b) => new Date(a.executed_at) - new Date(b.executed_at));
  const byTok = {};
  for (const t of sorted) (byTok[t.token_id] || (byTok[t.token_id] = [])).push(t);
  const out = [];
  for (const [tid, list] of Object.entries(byTok)) {
    let qty = 0, cur = null;
    for (const t of list) {
      const q = +t.quantity;
      if (t.side === "BUY") {
        if (qty <= 1e-8) { cur = { tid, at: +new Date(t.executed_at), entry: +t.price, end: null }; out.push(cur); }
        qty += q;
      } else { qty -= q; if (qty <= 1e-8 && cur) cur.end = +new Date(t.executed_at); }
    }
  }
  return out;
}
function simulate(series, entry, P) {
  const cst = 1 - FEE - SLIP;
  const q0 = cst; let q = cst, got = 0, peak = entry, prev = entry;
  for (const pt of series) {
    const x = pt.price / entry;
    peak = Math.max(peak, pt.price);
    const dropNow = prev > 0 ? (prev - pt.price) / prev * 100 : 0;
    prev = pt.price;
    const rule = exitRule({ x, peakX: peak / entry, dropNow, soldFrac: (q0 - q) / q0 }, P);
    for (const w of rule.partials) { const s = Math.min(q, q0 * w.pct); got += s * x * cst; q -= s; }
    if (rule.exit) { got += q * x * cst; q = 0; break; }
  }
  if (q > 1e-9) got += q * (series[series.length - 1].price / entry) * cst;
  return got - 1;
}
async function backtest() {
  step = "backtest: load";
  const S = await load();
  const snaps = await fetchAll("token_snapshots", "observed_at", "token_id,price,observed_at");
  const by = {};
  for (const r of snaps) { const pr = +r.price; if (pr > 0) (by[r.token_id] || (by[r.token_id] = [])).push({ t: +new Date(r.observed_at), price: pr }); }
  const trades = [];
  for (const e of entriesOf(S)) {
    const series = (by[e.tid] || []).filter(s => s.t > e.at && (!e.end || s.t <= e.end + 5000));
    if (series.length >= 3 && e.entry > 0) trades.push({ entry: e.entry, series });
  }
  log("BACKTEST", `${trades.length} past entries with enough snapshots (of ${entriesOf(S).length})`);
  if (!trades.length) return log("BACKTEST", "nothing to replay yet, let the bot collect more data");
  if (trades.length < 30) log("BACKTEST", "WARNING: under 30 trades, the best settings may just be luck (overfitting)");

  const evalP = P => {
    const r = trades.map(t => simulate(t.series, t.entry, P));
    const sum = r.reduce((s, v) => s + v, 0);
    return { sum, avg: sum / r.length, win: r.filter(v => v > 0).length / r.length, worst: Math.min(...r) };
  };
  const fmt = v => `total ${(v.sum * 100).toFixed(0)}%, avg ${(v.avg * 100).toFixed(1)}%/trade, win rate ${(v.win * 100).toFixed(0)}%, worst ${(v.worst * 100).toFixed(0)}%`;
  log("BACKTEST", "CURRENT SETTINGS ->", fmt(evalP(PARAMS)));
  const actual = closedCycles(S);
  if (actual.length) log("BACKTEST", `ACTUAL closed trades (${actual.length}) -> total ${(actual.reduce((s, c) => s + c.ret, 0) * 100).toFixed(0)}%, avg ${(actual.reduce((s, c) => s + c.ret, 0) / actual.length * 100).toFixed(1)}%/trade`);

  const grid = { STOP: [0.70, 0.75, 0.80, 0.85], TRAIL_WIDE: [5, 8, 12], TRAIL_PCT: [4, 5, 7], PARTIAL_X: [1.3, 1.5, 2], FAST_DROP: [3, 4, 6], LOCK_FLOOR: [1.03, 1.06, 1.10] };
  let combos = [{}];
  for (const k of Object.keys(grid)) { const next = []; for (const c of combos) for (const v of grid[k]) next.push({ ...c, [k]: v }); combos = next; }
  const res = combos.map(c => ({ c, ...evalP({ ...PARAMS, ...c }) })).sort((a, b) => b.sum - a.sum).slice(0, 10);
  log("BACKTEST", `TOP 10 of ${combos.length} combinations (env vars you can set):`);
  res.forEach((r, i) => log("BACKTEST", `#${i + 1} ${Object.entries(r.c).map(([k, v]) => k + "=" + v).join(" ")}  ->  ${fmt(r)}`));
  log("BACKTEST", "note: snapshots are ~60s apart and end at the real exit, so treat this as a rough guide, not a promise");
}

async function main() {
  if (!BOT_EMAIL || !BOT_PASSWORD) throw new Error("secret BOT_EMAIL or BOT_PASSWORD is empty");
  step = "login";
  const r = await db.auth.signInWithPassword({ email: BOT_EMAIL, password: BOT_PASSWORD });
  if (r.error) throw new Error(r.error.message);
  USER = r.data.user.id;
  if (process.argv.includes("--backtest")) { await backtest(); return; }
  const minArg = process.argv.find(a => a.startsWith("--minutes="));
  const minutes = minArg ? +minArg.split("=")[1] : 0;
  const deadline = minutes > 0 ? Date.now() + minutes * 60e3 : Infinity;
  log("bot v8 started (paper trading only) | mode", ONCE ? "once" : minutes ? minutes + " min loop" : "loop forever",
    `| pullback ${pullbackOn ? `on (${PULL_MIN}-${PULL_MAX}%, bounce ${BOUNCE}%)` : "off"} | liquidity exit ${LIQ_DROP}%/${LIQ_WINDOW_MIN}min | stop -${Math.round((1 - STOP) * 100)}% | poll ${POLL_SEC}s | scan ${SCAN_SEC}s | gecko ${GECKO ? "on" : "off"} | search ${SEARCH_ON ? "on" : "off"}`);
  if (ONCE) {
    step = "load data";
    const S1 = await load();
    step = "manage positions";
    await manage(S1);
    step = "load data (scan)";
    const S2 = await load();
    step = "scan";
    await scan(S2);
    step = "stats";
    const S3 = await load();
    stats(S3);
    await report(S3);
    log("run finished");
    return;
  }
  const today0 = new Date().toISOString().slice(0, 10);
  let S = null, lastLoad = 0, lastScan = 0, lastTick = 0;
  let lastReportDay = new Date().getUTCHours() >= REPORT_HOUR ? today0 : "";
  const reload = async () => {                              // mutates S in place, so a running scan sees fresh data too
    const fresh = await load();
    if (S) Object.assign(S, fresh); else S = fresh;
    lastLoad = Date.now();
  };
  // called between requests during a scan, so open positions and pullback signals are still watched
  const tick = async () => {
    if (!S || Date.now() - lastTick < POLL_SEC * 1000) return;
    lastTick = Date.now();
    try {
      if (await manage(S)) await reload();
      if (await checkSignals(S)) await reload();
    } catch (e) { log("tick error:", e.message); }
  };
  while (Date.now() < deadline) {
    try {
      if (!S || Date.now() - lastLoad > 5 * 60e3) await reload();
      lastTick = Date.now();
      if (await manage(S)) await reload();
      if (await checkSignals(S)) await reload();
      if (Date.now() - lastScan > SCAN_SEC * 1000 && Date.now() < deadline - 90e3) {
        await reload();
        await scan(S, tick); lastScan = Date.now();
        await reload();
        stats(S);
      }
      const d = new Date(), day = d.toISOString().slice(0, 10);
      if (d.getUTCHours() >= REPORT_HOUR && lastReportDay !== day) { await report(S); lastReportDay = day; }
    } catch (e) { log("cycle error:", e.message); }
    await sleep(Math.max(0, Math.min(POLL_SEC * 1000, deadline - Date.now())));
  }
  log("time window finished, exiting (open positions stay in the database and are picked up by the next run)");
}
main().catch(e => {
  console.log("::error::[" + step + "] " + String(e?.message || e).replace(/\s+/g, " "));
  process.exit(1);
});
