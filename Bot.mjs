// MemeLab AI — paper trading bot v10 "desk" (NO real money, NO wallet, NO private keys)
// 6 agents with hard handoffs:
//   Scout    : DexScreener + GeckoTerminal, pairs 30m-72h old, mcap $300k-$20M
//   Filter   : liq >= $40k, 1h vol >= $50k, not +80% in 1h  |  RugCheck: mint/freeze revoked, LP burned/locked,
//              top10 <= 25%, dev <= 3%, bundled/insiders <= 10%, no past rugs
//   Analyst  : score 0-100 (momentum, buyers, buy/sell ratio, holder growth, liq/mcap, smart wallets), only 70+ pass
//   Executor : max 8% of equity per trade (paper)
//   Risk     : stop -6% set at entry, trailing after +12%, partial sells, liquidity-drop / dead-pair / time stop
//   Logger   : every kill is counted and logged, hard kills are saved in the database
// Kept from v9: loss re-entry ban, pause after losing streak, creator ban, backtest, daily report, 24/7 hardening.
// Run:  npm i @supabase/supabase-js
//   node Bot.mjs --minutes=345   (loop for N minutes, then exit; GitHub Actions 24/7)
//   node Bot.mjs                 (loop forever)
//   node Bot.mjs --once          (one pass)
//   node Bot.mjs --backtest      (replays saved snapshots with many exit settings)
import { createClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_URL || "https://wduflmaakgoemxsegnbp.supabase.co";
const KEY = process.env.SUPABASE_KEY || "sb_publishable_muU19iaA6GTGNIvX6orqDg_ZO-50q5e";
const { BOT_EMAIL, BOT_PASSWORD } = process.env;
const WEBHOOK = process.env.DISCORD_WEBHOOK || "";
const ONCE = process.argv.includes("--once");

// ================= SETTINGS (change freely, or override with env vars) =================
const num = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" ? +process.env[k] : d);

// -- EXECUTOR: position size = 4%..8% of equity depending on the analyst score --
const MAX_TRADE_PCT = num("MAX_TRADE_PCT", 0.08);
const MIN_TRADE_PCT = num("MIN_TRADE_PCT", 0.04);
const MAX_EXPOSURE = num("MAX_EXPOSURE", 0.80);
const MAX_LIQ_PCT = num("MAX_LIQ_PCT", 0.02);   // one position never exceeds this share of token liquidity (0 = off)
const MIN_USD = num("MIN_USD", 5);
const MAX_USD = num("MAX_USD", 0);
const MAX_OPEN = num("MAX_OPEN", 8);

// -- protection against repeating mistakes --
const LOSS_BAN_H = num("LOSS_BAN_H", 168);      // token closed at a loss is not bought again for this many hours (0 = off)
const PAUSE_LOSSES = num("PAUSE_LOSSES", 4);    // after this many losing trades in a row...
const PAUSE_MIN = num("PAUSE_MIN", 30);         // ...no new entries for this many minutes (0 = off)
const TIME_STOP_H = num("TIME_STOP_H", 3);      // exit a position that never reached the trailing level within this many hours (0 = off)

// -- SCOUT --
const SCAN_SEC = num("SCAN_SEC", 300);
const MAX_CAND = num("MAX_CAND", 300);
const GECKO = num("GECKO", 1);
const SEARCH_ON = num("SEARCH_ON", 1);
const SEARCH_QUERIES = (process.env.SEARCH_QUERIES || "pump,pumpswap,raydium,meme,ai,cat,dog,pepe,trump,sol")
  .split(",").map(s => s.trim()).filter(Boolean);
const AGE_MIN_H = num("AGE_MIN_H", 0.5);        // 30 min
const AGE_MAX_H = num("AGE_MAX_H", 72);
const MC_MIN = num("MC_MIN", 300000);
const MC_MAX = num("MC_MAX", 20000000);

// -- FILTER (DexScreener data) --
const LIQ_MIN = num("LIQ_MIN", 40000);
const VOL1H_MIN = num("VOL1H_MIN", 50000);      // 1 hour volume
const CH1_MAX = num("CH1_MAX", 80);             // already pumped over this % in 1h = kill
const CH5_MAX = num("CH5_MAX", 25);             // 5 minute spike over this % = kill

// -- FILTER (RugCheck data) --
const RUGCHECK = num("RUGCHECK", 1);
const RUGCHECK_STRICT = num("RUGCHECK_STRICT", 1);   // 1 = if RugCheck is unreachable, do NOT enter
const MAX_RC = num("MAX_RC", 25);               // max fresh RugCheck reports per scan
const LP_LOCK_MIN = num("LP_LOCK_MIN", 70);     // % of LP that must be burned or locked
const LP_STRICT = num("LP_STRICT", 0);          // 1 = kill when RugCheck gives no LP data at all
const MAX_TOP10 = num("MAX_TOP10", 25);
const MAX_DEV = num("MAX_DEV", 3);
const MAX_BUNDLED = num("MAX_BUNDLED", 10);
const CREATOR_BAN = num("CREATOR_BAN", 1);
const RC_DEBUG = num("RC_DEBUG", 1);            // print RugCheck field names once, to check the data is read correctly

// -- ANALYST --
const MIN_SCORE = num("MIN_SCORE", 70);
const WATCH_MIN = num("WATCH_MIN", 55);
const MOM_M5_MIN = num("MOM_M5_MIN", 0);        // 5m change must be at least this % (analyst veto)
const SMART = new Set((process.env.SMART_WALLETS || "").split(",").map(s => s.trim()).filter(Boolean));

// -- optional pullback entry (off by default) --
const PULLBACK = num("PULLBACK", 0);
const PULL_MIN = num("PULL_MIN", 3);
const PULL_MAX = num("PULL_MAX", 12);
const BOUNCE = num("BOUNCE", 1);
const SIGNAL_MIN = num("SIGNAL_MIN", 60);
const MAX_SIGNALS = num("MAX_SIGNALS", 20);

// -- RISK --
const STOP = num("STOP", 0.94);                 // stop -6%, fixed at entry
const ARM_X = num("ARM_X", 1.12);               // trailing starts after +12%
const TRAIL_WIDE = num("TRAIL_WIDE", 6);
const TRAIL_LOCK = num("TRAIL_LOCK", 6);
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
const LIQ_DROP = num("LIQ_DROP", 30);
const LIQ_WINDOW_MIN = num("LIQ_WINDOW_MIN", 10);
const POLL_SEC = num("POLL_SEC", 20);
const SNAP_SEC = num("SNAP_SEC", 60);
const NOPRICE_MIN = num("NOPRICE_MIN", 3);
const NOPRICE_RECOVERY = num("NOPRICE_RECOVERY", 0.05);

// -- report / waiting list / cooldown --
const REPORT_HOUR = num("REPORT_HOUR", 21);
const WATCH_HOURS = num("WATCH_HOURS", 24);
const COOLDOWN_MIN = num("COOLDOWN_MIN", 30);
const COOLDOWN_STOP_MIN = num("COOLDOWN_STOP_MIN", 60);
const BL_LOSS = num("BL_LOSS", 0.40);

// -- LOGGER --
const VERBOSE = num("LOG_KILLS_VERBOSE", 0);    // 1 = print every single kill, also the cheap ones

// -- simulated costs --
const FEE = num("FEE", 0.005), SLIP = num("SLIP", 0.015);

// -- 24/7 hardening --
const HTTP_TIMEOUT_MS = num("HTTP_TIMEOUT_MS", 15000);
const WATCHDOG_MIN = num("WATCHDOG_MIN", 10);
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
const fmt1 = v => (v === null || v === undefined || !isFinite(v) ? "n/a" : (+v).toFixed(1));
const tickerOf = p => (p.baseToken?.symbol || "?").toUpperCase();
let USER = null;
process.on("unhandledRejection", e => log("unhandled rejection:", String(e?.message || e)));

async function login() {
  const r = await db.auth.signInWithPassword({ email: BOT_EMAIL, password: BOT_PASSWORD });
  if (r.error) throw new Error(r.error.message);
  USER = r.data.user.id;
  return r.data.user;
}

async function notify(text) {
  if (!WEBHOOK) return;
  try {
    await fetch(WEBHOOK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text.slice(0, 1900) }), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (e) { log("notify failed:", e.message); }
}

async function api(url) {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!r.ok) throw new Error(r.status + " " + url);
  return r.json();
}
// tick (optional) runs between requests, so open positions keep being checked during long scans
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

// =====================================================================================
// LOGGER: every kill is counted; RugCheck/Analyst kills get a line; hard kills are saved in the DB
// =====================================================================================
const killCount = {};
const killSeen = new Set();
function tally(stage, reason) { const k = stage + "|" + reason; killCount[k] = (killCount[k] || 0) + 1; }
function killLine(stage, ticker, reason) {
  const k = `${stage}|${ticker}|${reason}`;
  if (killSeen.has(k)) return;
  if (killSeen.size > 5000) killSeen.clear();
  killSeen.add(k);
  log("KILL", stage, ticker, "-", reason);
}
function killSummary() {
  const by = {};
  for (const [k, n] of Object.entries(killCount)) { const [stage, ...r] = k.split("|"); (by[stage] = by[stage] || []).push([r.join("|"), n]); }
  for (const stage of ["scout", "filter", "rugcheck", "analyst"]) {
    if (!by[stage]) continue;
    const list = by[stage].sort((a, b) => b[1] - a[1]);
    log("KILLS", stage, `${list.reduce((s, [, n]) => s + n, 0)} total:`, list.slice(0, 6).map(([r, n]) => `${r} (${n})`).join("; "));
  }
  for (const k of Object.keys(killCount)) delete killCount[k];
}

// =====================================================================================
// SCOUT: token sources (DexScreener lists + keyword search + GeckoTerminal pools)
// =====================================================================================
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

// ---- SCOUT filter: age 30m-72h, market cap $300k-$20M ----
function scoutKills(p) {
  const r = [];
  const age = (Date.now() - (p.pairCreatedAt || Date.now())) / 36e5;
  const mc = p.marketCap || p.fdv || 0;
  if (age < AGE_MIN_H) r.push(`pair younger than ${Math.round(AGE_MIN_H * 60)} min`);
  if (age > AGE_MAX_H) r.push(`pair older than ${AGE_MAX_H}h`);
  if (mc < MC_MIN) r.push(`market cap under $${MC_MIN}`);
  if (mc > MC_MAX) r.push(`market cap over $${MC_MAX}`);
  return r;
}
// ---- FILTER (DexScreener part): liquidity, 1h volume, already pumped ----
function filterKills(p) {
  const r = [];
  const liq = p.liquidity?.usd || 0, vol1 = p.volume?.h1 || 0;
  const ch1 = p.priceChange?.h1 || 0, ch5 = p.priceChange?.m5;
  if (liq < LIQ_MIN) r.push(`liquidity under $${LIQ_MIN}`);
  if (vol1 < VOL1H_MIN) r.push(`1h volume under $${VOL1H_MIN}`);
  if (ch1 > CH1_MAX) r.push(`already +${CH1_MAX}% in 1h`);
  if (ch5 > CH5_MAX) r.push(`5m spike over +${CH5_MAX}%`);
  return r;
}

// =====================================================================================
// FILTER (RugCheck part): mint/freeze, LP, top10, dev, bundled, past rugs
// =====================================================================================
const rcCache = new Map();
const holderHist = new Map();     // mint -> [{t, n}] holder counts seen over time
let rcDebugged = false;
const rcFresh = m => { const h = rcCache.get(m); return !!h && Date.now() - h.t < h.ttl; };
const rcPeek = m => rcCache.get(m)?.res || null;
function holderGrowth(mint) {     // % growth of the holder count, null when there is not enough history yet
  const h = holderHist.get(mint) || [];
  if (h.length < 2) return null;
  const a = h[0], b = h[h.length - 1];
  if (b.t - a.t < 10 * 60e3 || a.n <= 0) return null;
  return (b.n - a.n) / a.n * 100;
}
function collectStrings(o, set, depth = 0) {
  if (depth > 3 || o === null || o === undefined) return;
  if (typeof o === "string") { if (o.length >= 32) set.add(o); return; }
  if (Array.isArray(o)) { o.forEach(x => collectStrings(x, set, depth + 1)); return; }
  if (typeof o === "object") Object.values(o).forEach(x => collectStrings(x, set, depth + 1));
}
const EMPTY_RC = (why, unavailable) => ({ unavailable: !!unavailable, why, creator: null, kills: [], holders: 0, topAddrs: [], note: why });

async function rugCheck(mint) {
  if (!RUGCHECK) return EMPTY_RC("rugcheck off", false);
  if (rcFresh(mint)) return rcCache.get(mint).res;
  let res, ttl = 30 * 60e3;
  try {
    const j = await api(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`);
    if (RC_DEBUG && !rcDebugged) {
      rcDebugged = true;
      const lp = (j?.markets || []).find(m => m?.lp)?.lp;
      log("RUGCHECK fields:", Object.keys(j || {}).join(","), "| lp fields:", lp ? Object.keys(lp).join(",") : "none");
    }
    const str = v => (typeof v === "string" && v ? v : null);
    const creator = str(j?.creator);
    const risks = Array.isArray(j?.risks) ? j.risks : [];
    const rn = risks.map(r => String(r?.name || ""));
    const kills = [];

    if (!!(j?.mintAuthority || j?.token?.mintAuthority) || rn.some(n => /mint authority/i.test(n)))
      kills.push({ key: "mint authority not revoked", detail: "mint authority still enabled", hard: true });
    if (!!(j?.freezeAuthority || j?.token?.freezeAuthority) || rn.some(n => /freeze authority/i.test(n)))
      kills.push({ key: "freeze authority not revoked", detail: "freeze authority still enabled", hard: true });
    if (j?.rugged === true) kills.push({ key: "marked as rugged", detail: "marked as rugged", hard: true, ban: true });
    if (rn.some(n => /honeypot/i.test(n))) kills.push({ key: "honeypot", detail: "honeypot risk", hard: true, ban: true });
    const otherDanger = risks.filter(r => r?.level === "danger" && !/mint authority|freeze authority|honeypot|holder|liquidity|lp/i.test(String(r?.name || "")));
    if (otherDanger.length) kills.push({ key: "RugCheck danger risk", detail: otherDanger.map(r => r.name).join(", "), hard: true });
    const prev = Array.isArray(j?.creatorTokens) ? j.creatorTokens : [];
    if (prev.some(t => t?.rugged === true || /rug/i.test(String(t?.status || ""))))
      kills.push({ key: "creator has past rugs", detail: "creator has past rugged tokens", hard: true, ban: true });

    // LP burned / locked
    const markets = Array.isArray(j?.markets) ? j.markets : [];
    const lpVals = markets.map(m => m?.lp?.lpLockedPct).filter(v => typeof v === "number" && isFinite(v));
    const lpPct = lpVals.length ? Math.max(...lpVals) : null;
    if (lpPct !== null && lpPct < LP_LOCK_MIN) kills.push({ key: `LP burned/locked under ${LP_LOCK_MIN}%`, detail: `LP burned/locked only ${lpPct.toFixed(0)}%` });
    else if (lpPct === null && LP_STRICT) kills.push({ key: "LP lock data missing", detail: "no LP lock data" });

    // holders (pool accounts are excluded when they can be recognised)
    const pool = new Set();
    collectStrings(markets, pool);
    const th = (Array.isArray(j?.topHolders) ? j.topHolders : []).filter(h => !pool.has(h?.address) && !pool.has(h?.owner));
    let top10 = null, dev = null, bundled = null;
    if (th.length) {
      const sorted = th.slice().sort((a, b) => (+b?.pct || 0) - (+a?.pct || 0));
      top10 = sorted.slice(0, 10).reduce((s, h) => s + (+h?.pct || 0), 0);
      bundled = th.filter(h => h?.insider === true).reduce((s, h) => s + (+h?.pct || 0), 0);
      if (creator) {
        const ch = th.find(h => h?.address === creator || h?.owner === creator);
        dev = ch ? (+ch.pct || 0) : null;
      }
    }
    if (dev === null && creator) {
      const bal = +j?.creatorBalance, sup = +j?.token?.supply;
      if (isFinite(bal) && isFinite(sup) && sup > 0) dev = bal / sup * 100;
      else if (th.length) dev = 0;                           // creator is not among the biggest holders
    }
    if (top10 !== null && top10 > MAX_TOP10) kills.push({ key: `top 10 holders over ${MAX_TOP10}%`, detail: `top 10 holders ${top10.toFixed(1)}%` });
    if (dev !== null && dev > MAX_DEV) kills.push({ key: `dev holds over ${MAX_DEV}%`, detail: `dev holds ${dev.toFixed(1)}%` });
    if (bundled !== null && bundled > MAX_BUNDLED) kills.push({ key: `bundled/insider holders over ${MAX_BUNDLED}%`, detail: `bundled/insiders ${bundled.toFixed(1)}%` });

    const total = +j?.totalHolders || 0;
    if (total > 0) {
      const h = holderHist.get(mint) || [];
      h.push({ t: Date.now(), n: total });
      holderHist.set(mint, h.slice(-12));
    }
    res = {
      unavailable: false, creator, kills, holders: total,
      topAddrs: th.flatMap(h => [h?.address, h?.owner]).filter(Boolean),
      note: `top10 ${fmt1(top10)}%, dev ${fmt1(dev)}%, bundled ${fmt1(bundled)}%, LP ${lpPct === null ? "n/a" : lpPct.toFixed(0) + "%"}, holders ${total || "n/a"}${rn.length ? ", warnings: " + rn.slice(0, 4).join("; ") : ""}`,
    };
  } catch (e) {
    ttl = 2 * 60e3;
    res = EMPTY_RC("RugCheck unavailable (" + e.message + ")", true);
  }
  await sleep(600);
  rcCache.set(mint, { t: Date.now(), ttl, res });
  return res;
}

// =====================================================================================
// ANALYST: score 0-100. Weights: momentum 25, buyers 15, buy/sell 20, holder growth 15, liq/mcap 15, smart wallets 10 (only if SMART_WALLETS is set)
// "buyers" = number of buy transactions in 1h (DexScreener has no unique-buyer count)
// =====================================================================================
function analyst(p, rc) {
  const addr = p.baseToken.address;
  const liq = p.liquidity?.usd || 0, mc = p.marketCap || p.fdv || 0, vol1 = p.volume?.h1 || 0;
  const age = (Date.now() - (p.pairCreatedAt || Date.now())) / 36e5;
  const b1 = p.txns?.h1?.buys || 0, s1 = p.txns?.h1?.sells || 0, b5 = p.txns?.m5?.buys || 0, s5 = p.txns?.m5?.sells || 0;
  const ch5 = p.priceChange?.m5, ch1 = p.priceChange?.h1 || 0, ch6 = p.priceChange?.h6 || 0;
  const veto = [];
  if (ch5 === undefined || ch5 === null) veto.push("no 5m data");
  else if (ch5 < MOM_M5_MIN) veto.push(`5m change below ${MOM_M5_MIN}%`);
  if (!(ch1 > 0)) veto.push("1h change not positive");

  const m5 = typeof ch5 === "number" ? ch5 : 0;
  const parts = {};
  parts.momentum = clamp(m5 / 5, 0, 1) * 10 + (ch1 > 60 ? 5 : clamp(ch1 / 20, 0, 1) * 10) + (ch6 > 0 ? 5 : 0);
  parts.buyers = clamp(b1 / 150, 0, 1) * 15;
  const r1 = b1 + s1 ? b1 / (b1 + s1) : 0.5;
  const r5 = b5 + s5 >= 5 ? b5 / (b5 + s5) : r1;
  parts.ratio = clamp((r1 - 0.45) / 0.2, 0, 1) * 10 + clamp((r5 - 0.45) / 0.2, 0, 1) * 10;
  const g = holderGrowth(addr);
  parts.holders = g === null ? 7 : clamp(g / 5, 0, 1) * 15;      // no history yet = neutral 7 of 15
  parts.liqmc = mc > 0 ? clamp((liq / mc - 0.02) / 0.08, 0, 1) * 15 : 0;
  let max = 90;
  if (SMART.size) {
    const n = rc ? rc.topAddrs.filter(a => SMART.has(a)).length : 0;
    parts.smart = Math.min(10, n * 5); max = 100;
  }
  const raw = Object.values(parts).reduce((s, v) => s + v, 0);
  const score = Math.round(raw / max * 100);
  const tier = score >= 85 ? "A" : "B";
  const note = `tier ${tier}, parts mom ${parts.momentum.toFixed(0)}/buy ${parts.buyers.toFixed(0)}/ratio ${parts.ratio.toFixed(0)}/holders ${parts.holders.toFixed(0)}${g === null ? "*" : ""}/liqmc ${parts.liqmc.toFixed(0)}${SMART.size ? "/smart " + parts.smart.toFixed(0) : ""}, liq $${Math.round(liq)}, vol1h $${Math.round(vol1)}, mcap $${Math.round(mc)}, age ${age.toFixed(1)}h, buys/sells 1h ${b1}/${s1}, 5m ${m5}%, 1h ${ch1}%`;
  return { score, tier, veto, parts, note, growth: g };
}

// =====================================================================================
// EXECUTOR: size 4%-8% of equity by score, capped by exposure, cash and token liquidity
// =====================================================================================
function sizeFor(e, ctx) {
  const pct = clamp(MIN_TRADE_PCT + (e.score - MIN_SCORE) / Math.max(1, 100 - MIN_SCORE) * (MAX_TRADE_PCT - MIN_TRADE_PCT), MIN_TRADE_PCT, MAX_TRADE_PCT);
  let usd = ctx.equity * pct;
  if (MAX_USD > 0) usd = Math.min(usd, MAX_USD);
  if (MAX_LIQ_PCT > 0) usd = Math.min(usd, (e.p.liquidity?.usd || 0) * MAX_LIQ_PCT);
  usd = Math.min(usd, ctx.equity * MAX_EXPOSURE - ctx.invested, ctx.cash);
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

// live view of cash / exposure / free slots (invested valued at cost)
function liveCtx(S, cycles, banned) {
  const open = openOf(positions(S));
  const invested = open.reduce((s, [, p]) => s + p.qty * p.entry, 0);
  const c = cash(S);
  return { equity: c + invested, invested, cash: c, cycles, banned, freeSlots: MAX_OPEN - open.length };
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
async function tokenFor(S, p) {
  return S.tokens.find(t => t.mint_address === p.baseToken.address) || addToken(p);
}

// ---- blacklist, creator blacklist, loss ban, cooldown, pause (all derived from the database) ----
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
function lossBans(cycles) {
  const m = {};
  for (const c of cycles.slice().sort((a, b) => a.closedAt - b.closedAt)) m[c.tid] = c.pnl <= 0 ? +c.closedAt : 0;
  return m;
}
const lossBanned = (bans, tid) => LOSS_BAN_H > 0 && !!bans[tid] && Date.now() - bans[tid] < LOSS_BAN_H * 36e5;
function pauseLeftMin(cycles) {
  if (PAUSE_LOSSES <= 0 || PAUSE_MIN <= 0) return 0;
  const last = cycles.slice().sort((a, b) => a.closedAt - b.closedAt).slice(-PAUSE_LOSSES);
  if (last.length < PAUSE_LOSSES || !last.every(c => c.pnl <= 0)) return 0;
  return Math.max(0, PAUSE_MIN - (Date.now() - last[last.length - 1].closedAt) / 6e4);
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
  const entries = S.decisions.filter(d => d.decision === "WEJŚĆ" && /tier (A|B)/.test(d.reason || ""));
  for (const c of cycles) {
    c.pnl = c.proceeds - c.cost; c.ret = c.cost > 0 ? c.proceeds / c.cost - 1 : 0;
    const e = entries.filter(d => d.token_id === c.tid && new Date(d.created_at) <= new Date(c.at.getTime() + 120000))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    c.level = e ? e.reason.match(/tier (A|B)/)[1] : "?";
  }
  return cycles;
}

// ---- exit-reason statistics ----
function exitCategory(reason) {
  const r = reason || "";
  if (/stop-loss/i.test(r)) return "stop-loss";
  if (/rug pull/i.test(r)) return "rug pull";
  if (/liquidity dropped/i.test(r)) return "liquidity drop";
  if (/no price data/i.test(r)) return "dead pair";
  if (/sudden drop/i.test(r)) return "sudden drop";
  if (/profit floor/i.test(r)) return "profit floor";
  if (/trailing stop/i.test(r)) return "trailing stop";
  if (/time stop/i.test(r)) return "time stop";
  return "other";
}
function exitStats(S, cycles) {
  const exits = S.decisions.filter(d => d.decision === "WYJŚĆ").sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const agg = {};
  for (const c of cycles) {
    const d = exits.find(x => x.token_id === c.tid && +new Date(x.created_at) >= +c.closedAt - 3000);
    const cat = d ? exitCategory(d.reason) : "manual/unknown";
    const a = agg[cat] || (agg[cat] = { n: 0, wins: 0, pnl: 0, ret: 0 });
    a.n++; a.pnl += c.pnl; a.ret += c.ret; if (c.pnl > 0) a.wins++;
  }
  return Object.entries(agg).sort((a, b) => a[1].pnl - b[1].pnl)
    .map(([k, a]) => `${k}: ${a.n} trades, wins ${a.wins}, P&L $${a.pnl.toFixed(2)}, avg ${(a.ret / a.n * 100).toFixed(1)}%`);
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
  for (const t of ["A", "B"]) { const ln = line("tier " + t, cycles.filter(c => c.level === t)); if (ln) log("STATS", ln); }
  for (const l of exitStats(S, cycles)) log("EXITS", l);
}

// ---- daily report (UTC day) ----
async function report(S) {
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const all = closedCycles(S);
  const today = all.filter(c => c.closedAt >= dayStart);
  const buys = S.trades.filter(t => t.side === "BUY" && new Date(t.executed_at) >= dayStart).length;
  const wins = today.filter(c => c.pnl > 0);
  const pnl = today.reduce((s, c) => s + c.pnl, 0);
  const name = c => (S.tokens.find(t => t.id === c.tid)?.ticker || "?");
  const best = today.slice().sort((a, b) => b.pnl - a.pnl)[0], worst = today.slice().sort((a, b) => a.pnl - b.pnl)[0];
  const mtm = await markToMarket(S);
  const equity = cash(S) + mtm.value;
  const kills = {};
  for (const d of S.decisions) {
    if (new Date(d.created_at) < dayStart) continue;
    const m = (d.reason || "").match(/KILL\[(\w+)\]/);
    if (m) kills[m[1]] = (kills[m[1]] || 0) + 1;
  }
  const lines = [
    `DAILY REPORT ${dayStart.toISOString().slice(0, 10)}`,
    `entries today: ${buys} | closed today: ${today.length} (wins ${wins.length}, losses ${today.length - wins.length}, win rate ${today.length ? (wins.length / today.length * 100).toFixed(0) : 0}%)`,
    `realized P&L today: $${pnl.toFixed(2)}`,
    best ? `best: ${name(best)} $${best.pnl.toFixed(2)} (${(best.ret * 100).toFixed(1)}%) | worst: ${name(worst)} $${worst.pnl.toFixed(2)} (${(worst.ret * 100).toFixed(1)}%)` : "no closed trades today",
    `open positions: ${mtm.count}, unrealized P&L $${(mtm.value - mtm.cost).toFixed(2)}`,
    `equity (mark-to-market): $${equity.toFixed(2)} (cash $${cash(S).toFixed(2)})`,
    `hard kills saved today: ${Object.entries(kills).map(([k, n]) => k + " " + n).join(", ") || "none"}`,
    "exit reasons (all time):",
    ...exitStats(S, all).map(l => "  " + l),
  ];
  lines.forEach(l => log("REPORT", l));
  await notify(lines.join("\n"));
}

// =====================================================================================
// RISK: exit rules — one pure function used by the live bot AND by the backtest
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

// ---- EXECUTOR: opens one paper position (stop is defined before the entry) ----
// returns { ok:true, usd } | { ok:false, park:"reason" } | { ok:false }
async function enter(S, e, ctx, how) {
  const addr = e.p.baseToken.address;
  const known = S.tokens.find(t => t.mint_address === addr);
  if (known && positions(S)[known.id]?.qty > 1e-8) return { ok: false };
  if (known && lossBanned(lossBans(ctx.cycles), known.id)) return { ok: false };
  const { usd, pct } = sizeFor(e, ctx);
  if (!usd) return { ok: false, park: `score ${e.score}/100 passed, but no cash, exposure or liquidity room. ${e.note}` };
  const price = +e.p.priceUsd;
  const tok = await tokenFor(S, e.p);
  await snapshot(tok.id, e.p);
  await paperBuy(tok.id, tok.ticker, price, usd, e.p.liquidity?.usd || 0);
  await decide(tok.id, "WEJŚĆ",
    `score ${e.score}/100, tier ${e.tier}, size $${usd.toFixed(2)} (${(usd / ctx.equity * 100).toFixed(1)}% of portfolio, base ${(pct * 100).toFixed(1)}%). entry: ${how}. stop set before entry at $${(price * STOP).toPrecision(5)} (-${Math.round((1 - STOP) * 100)}%). rugcheck: ${e.rc?.note || "n/a"}. creator:${e.rc?.creator || "unknown"}. ${e.note}`,
    `Stop -${Math.round((1 - STOP) * 100)}%; trailing after +${Math.round((ARM_X - 1) * 100)}% (${TRAIL_WIDE}/${TRAIL_LOCK}/${TRAIL_PCT}/${TRAIL_TIGHT}%); sell ${Math.round(PARTIAL_PCT * 100)}% at ${PARTIAL_X}x and ${Math.round(PARTIAL2_PCT * 100)}% at ${PARTIAL2_X}x; floor ${LOCK_FLOOR}x from +${Math.round((LOCK_X - 1) * 100)}%; liquidity drop ${LIQ_DROP}%/${LIQ_WINDOW_MIN}min; time stop ${TIME_STOP_H}h`,
    `Tier ${e.tier}. Memecoin: can go to zero.`);
  log("ENTER", tok.ticker, "score", e.score, "tier", e.tier, "size $" + usd.toFixed(2), "|", how);
  await notify(`ENTER ${tok.ticker} $${usd.toFixed(2)} (score ${e.score}, tier ${e.tier}) ${how}`);
  return { ok: true, usd };
}

// ---- optional pullback signals ----
const signals = new Map();
function addSignal(e) {
  const mint = e.p.baseToken.address;
  if (signals.has(mint) || signals.size >= MAX_SIGNALS) return false;
  signals.set(mint, { t0: Date.now(), high: +e.p.priceUsd, low: Infinity, reached: false, ticker: tickerOf(e.p) });
  log("SIGNAL", tickerOf(e.p), `waiting for a ${PULL_MIN}-${PULL_MAX}% pullback and a ${BOUNCE}% bounce`);
  return true;
}
async function checkSignals(S) {
  if (!signals.size) return false;
  const cycles = closedCycles(S);
  if (pauseLeftMin(cycles) > 0) return false;
  const bans = lossBans(cycles);
  const pos = positions(S);
  const best = bestPair(await pairsFor([...signals.keys()]));
  const banned = bannedCreators(S);
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
    if (price < sg.low * (1 + BOUNCE / 100) || dd < PULL_MIN / 2) continue;
    const ctx = liveCtx(S, cycles, banned);
    if (ctx.freeSlots <= 0) continue;
    const tk = S.tokens.find(t => t.mint_address === mint);
    if (tk && (isBlacklisted(S, tk.id) || lossBanned(bans, tk.id) || pos[tk.id]?.qty > 1e-8 || cooldownLeftMin(S, tk.id) > 0)) { signals.delete(mint); continue; }
    signals.delete(mint);
    const rc = rcPeek(mint);
    const bad = [...scoutKills(p), ...filterKills(p)];
    const a = analyst(p, rc);
    if (bad.length || a.veto.length || a.score < MIN_SCORE - 10) { log("SIGNAL cancelled", sg.ticker, "-", bad[0] || a.veto[0] || `score ${a.score}`); continue; }
    const r = await enter(S, { p, rc, ...a }, ctx, `pullback ${dd.toFixed(1)}% below the high, bounce from the low`);
    if (r.ok) changed = true;
  }
  return changed;
}

// =====================================================================================
// SCAN: Scout -> Filter -> Analyst -> Executor (hard handoffs)
// =====================================================================================
async function scan(S, tick, refresh) {
  const cycles = closedCycles(S);
  const pl = pauseLeftMin(cycles);
  if (pl > 0) return log(`ENTRY PAUSE: ${PAUSE_LOSSES} losing trades in a row, ${pl.toFixed(0)} min left, no new entries`);
  const pos = positions(S);
  const known = new Set(S.tokens.map(t => t.mint_address));
  const banned = bannedCreators(S);
  const bans = lossBans(cycles);
  const notHeld = t => !(pos[t.id]?.qty > 1e-8) && !isBlacklisted(S, t.id) && !lossBanned(bans, t.id) && cooldownLeftMin(S, t.id) <= 0;
  const lastDec = {};
  for (const d of S.decisions) { const ts = +new Date(d.created_at); if (!(lastDec[d.token_id] >= ts)) lastDec[d.token_id] = ts; }
  const reentry = S.tokens.filter(t => t.status === "WYJŚĆ" && notHeld(t)).map(t => t.mint_address);
  const watch = S.tokens.filter(t => (t.status === "POCZEKAĆ" || t.status === "ANALIZUJE") && notHeld(t) && Date.now() - (lastDec[t.id] || 0) <= WATCH_HOURS * 36e5).map(t => t.mint_address);

  // ---- 1) SCOUT ----
  step = "scout";
  const found = (await discover(tick)).filter(a => !known.has(a));
  const addrs = [...new Set([...reentry, ...watch, ...found])].slice(0, MAX_CAND);
  log(`scan: ${addrs.length} candidates (${found.length} new, ${reentry.length} re-entry, ${watch.length} waiting), banned creators ${banned.size}, signals ${signals.size}`);
  step = "fetch pair data";
  const pairs = Object.values(bestPair(await pairsFor(addrs, tick)));
  const scouted = [];
  for (const p of pairs) {
    const r = scoutKills(p);
    if (r.length) r.forEach(x => { tally("scout", x); if (VERBOSE) killLine("scout", tickerOf(p), x); });
    else scouted.push(p);
  }

  // ---- 2) FILTER (DexScreener) ----
  const filtered = [];
  for (const p of scouted) {
    const r = filterKills(p);
    if (r.length) r.forEach(x => { tally("filter", x); if (VERBOSE) killLine("filter", tickerOf(p), x); });
    else filtered.push(p);
  }
  log(`desk: ${pairs.length} pairs -> scout ${scouted.length} -> filter ${filtered.length}`);
  filtered.sort((a, b) => (b.volume?.h1 || 0) - (a.volume?.h1 || 0));

  const handled = new Set();
  const park = async (e, reason) => {
    handled.add(e.p.baseToken.address);
    const tok = await tokenFor(S, e.p);
    if (tok.status === "POCZEKAĆ") return;
    await snapshot(tok.id, e.p);
    await decide(tok.id, "POCZEKAĆ", reason, "Re-check score and filters");
    log("WAIT", tok.ticker, "-", reason.slice(0, 90));
  };

  // ---- 3) FILTER (RugCheck) + 4) ANALYST ----
  step = "filter + analyst";
  let fetched = 0;
  const passed = [];
  for (const p of filtered) {
    const addr = p.baseToken.address, tk = tickerOf(p);
    const fresh = rcFresh(addr);
    if (!fresh && RUGCHECK && fetched >= MAX_RC) { tally("rugcheck", "skipped (RugCheck budget per scan)"); continue; }
    const rc = await rugCheck(addr);
    if (!fresh && RUGCHECK) { fetched++; if (tick) await tick(); }
    if (rc.unavailable && RUGCHECK_STRICT) { tally("rugcheck", "RugCheck unavailable"); killLine("rugcheck", tk, rc.why); continue; }
    const kills = rc.unavailable ? [] : rc.kills.slice();
    if (CREATOR_BAN && rc.creator && banned.has(rc.creator)) kills.push({ key: "creator banned (earlier rug)", detail: "creator banned (earlier rug)", hard: true });
    if (kills.length) {
      kills.forEach(k => tally("rugcheck", k.key));
      killLine("rugcheck", tk, kills.map(k => k.detail).join("; "));
      if (kills.some(k => k.hard)) {                         // structural kill: remembered in the database, never looked at again
        const ban = kills.some(k => k.ban);
        if (ban && rc.creator) banned.add(rc.creator);
        const tok = await tokenFor(S, p);
        await decide(tok.id, "POCZEKAĆ", `KILL[rugcheck] ${kills.map(k => k.detail).join("; ")} | ${rc.note} creator:${rc.creator || "unknown"} [BLACKLIST]${ban ? " [CREATORBAN]" : ""}`);
        handled.add(addr);
      }
      continue;
    }
    const a = analyst(p, rc);
    const e = { p, rc, ...a };
    if (a.veto.length) { a.veto.forEach(v => tally("analyst", "veto: " + v)); killLine("analyst", tk, "veto: " + a.veto.join("; ")); continue; }
    if (a.score < MIN_SCORE) {
      tally("analyst", `score below ${MIN_SCORE}`);
      killLine("analyst", tk, `score ${a.score} (< ${MIN_SCORE})`);
      if (a.score >= WATCH_MIN) await park(e, `score ${a.score}/100 below ${MIN_SCORE}, waiting. rugcheck: ${rc.note}. ${a.note}`);
      continue;
    }
    passed.push(e);
  }
  passed.sort((a, b) => b.score - a.score);
  log(`desk: analyst passed ${passed.length} (score ${MIN_SCORE}+), fresh RugCheck reports ${fetched}`);

  // ---- 5) EXECUTOR ----
  step = "executor";
  for (const e of passed) {
    const ctx = liveCtx(S, cycles, banned);
    if (ctx.freeSlots <= 0) { await park(e, `score ${e.score}/100 passed, but no free slot. ${e.note}`); continue; }
    if (pullbackOn) { addSignal(e); continue; }
    const r = await enter(S, e, ctx, `immediate (analyst score ${e.score})`);
    if (r.ok) await refresh();
    else if (r.park) await park(e, r.park);
  }
  killSummary();
}

// =====================================================================================
// RISK: manage open positions (every POLL_SEC)
// =====================================================================================
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

    const ageH = (Date.now() - p.firstAt) / 36e5;
    if (TIME_STOP_H > 0 && ageH >= TIME_STOP_H && peakX < ARM_X && p.qty > 1e-8) {
      await exitAll(`time stop: ${ageH.toFixed(1)}h without reaching +${Math.round((ARM_X - 1) * 100)}%`);
      continue;
    }

    if (rule.trailPct) log("HOLD", t.ticker, x.toFixed(4) + "x", "peak", peakX.toFixed(4) + "x", `(trail ${rule.trailPct}%${rule.locked ? ", profit locked" : ""})`);
    else log("HOLD (not armed)", t.ticker, x.toFixed(4) + "x", `age ${ageH.toFixed(1)}h`);
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
  const f = v => `total ${(v.sum * 100).toFixed(0)}%, avg ${(v.avg * 100).toFixed(1)}%/trade, win rate ${(v.win * 100).toFixed(0)}%, worst ${(v.worst * 100).toFixed(0)}%`;
  log("BACKTEST", "CURRENT SETTINGS ->", f(evalP(PARAMS)));
  const actual = closedCycles(S);
  if (actual.length) log("BACKTEST", `ACTUAL closed trades (${actual.length}) -> total ${(actual.reduce((s, c) => s + c.ret, 0) * 100).toFixed(0)}%, avg ${(actual.reduce((s, c) => s + c.ret, 0) / actual.length * 100).toFixed(1)}%/trade`);

  const grid = { STOP: [0.90, 0.92, 0.94, 0.96], TRAIL_WIDE: [4, 6, 8], TRAIL_PCT: [4, 5, 7], PARTIAL_X: [1.3, 1.5, 2], FAST_DROP: [3, 4, 6], LOCK_FLOOR: [1.03, 1.06, 1.10] };
  let combos = [{}];
  for (const k of Object.keys(grid)) { const next = []; for (const c of combos) for (const v of grid[k]) next.push({ ...c, [k]: v }); combos = next; }
  const res = combos.map(c => ({ c, ...evalP({ ...PARAMS, ...c }) })).sort((a, b) => b.sum - a.sum).slice(0, 10);
  log("BACKTEST", `TOP 10 of ${combos.length} combinations (env vars you can set):`);
  res.forEach((r, i) => log("BACKTEST", `#${i + 1} ${Object.entries(r.c).map(([k, v]) => k + "=" + v).join(" ")}  ->  ${f(r)}`));
  log("BACKTEST", "note: snapshots are ~60s apart and end at the real exit, so treat this as a rough guide, not a promise");
}

async function main() {
  if (!BOT_EMAIL || !BOT_PASSWORD) throw new Error("secret BOT_EMAIL or BOT_PASSWORD is empty");
  step = "login";
  await login();
  if (process.argv.includes("--backtest")) { await backtest(); return; }
  const minArg = process.argv.find(a => a.startsWith("--minutes="));
  const minutes = minArg ? +minArg.split("=")[1] : 0;
  const deadline = minutes > 0 ? Date.now() + minutes * 60e3 : Infinity;
  log("bot v10 desk started (paper trading only) | mode", ONCE ? "once" : minutes ? minutes + " min loop" : "loop forever",
    `| scout age ${Math.round(AGE_MIN_H * 60)}min-${AGE_MAX_H}h, mcap $${MC_MIN}-$${MC_MAX} | filter liq $${LIQ_MIN}, vol1h $${VOL1H_MIN}, top10 ${MAX_TOP10}%, dev ${MAX_DEV}%, bundled ${MAX_BUNDLED}% | analyst ${MIN_SCORE}+ | size ${MIN_TRADE_PCT * 100}-${MAX_TRADE_PCT * 100}% | stop -${Math.round((1 - STOP) * 100)}%, trail after +${Math.round((ARM_X - 1) * 100)}% | pullback ${pullbackOn ? "on" : "off"} | poll ${POLL_SEC}s | scan ${SCAN_SEC}s`);
  if (ONCE) {
    step = "load data";
    const S1 = await load();
    step = "manage positions";
    await manage(S1);
    step = "load data (scan)";
    const S2 = await load();
    step = "scan";
    await scan(S2, null, async () => { Object.assign(S2, await load()); });
    step = "stats";
    const S3 = await load();
    stats(S3);
    await report(S3);
    log("run finished");
    return;
  }

  // ---- 24/7 loop ----
  let beat = Date.now();
  if (WATCHDOG_MIN > 0) {
    setInterval(() => {
      if (Date.now() - beat > WATCHDOG_MIN * 60e3) {
        console.log("::error::watchdog: no progress for " + WATCHDOG_MIN + " min, exiting so the next scheduled run takes over");
        process.exit(1);
      }
    }, 60e3).unref();
  }
  const today0 = new Date().toISOString().slice(0, 10);
  let S = null, lastLoad = 0, lastScan = 0, lastTick = 0;
  let lastReportDay = new Date().getUTCHours() >= REPORT_HOUR ? today0 : "";
  const reload = async () => {
    const fresh = await load();
    if (S) Object.assign(S, fresh); else S = fresh;
    lastLoad = Date.now();
  };
  const onErr = async (label, e) => {
    log(label, e.message);
    if (/jwt|expired|401|not authenticated|invalid.*token/i.test(String(e.message))) {
      try { await login(); log("re-login ok"); } catch (e2) { log("re-login failed:", e2.message); }
    }
  };
  const tick = async () => {
    beat = Date.now();
    if (!S || Date.now() - lastTick < POLL_SEC * 1000) return;
    lastTick = Date.now();
    try {
      if (await manage(S)) await reload();
      if (await checkSignals(S)) await reload();
    } catch (e) { await onErr("tick error:", e); }
  };
  while (Date.now() < deadline) {
    try {
      beat = Date.now();
      if (!S || Date.now() - lastLoad > 5 * 60e3) await reload();
      lastTick = Date.now();
      if (await manage(S)) await reload();
      if (await checkSignals(S)) await reload();
      if (Date.now() - lastScan > SCAN_SEC * 1000 && Date.now() < deadline - 90e3) {
        await reload();
        await scan(S, tick, reload); lastScan = Date.now();
        await reload();
        stats(S);
      }
      const d = new Date(), day = d.toISOString().slice(0, 10);
      if (d.getUTCHours() >= REPORT_HOUR && lastReportDay !== day) { await report(S); lastReportDay = day; }
    } catch (e) { await onErr("cycle error:", e); }
    await sleep(Math.max(0, Math.min(POLL_SEC * 1000, deadline - Date.now())));
  }
  log("time window finished, exiting (open positions stay in the database and are picked up by the next run)");
}
main().catch(e => {
  console.log("::error::[" + step + "] " + String(e?.message || e).replace(/\s+/g, " "));
  process.exit(1);
});
