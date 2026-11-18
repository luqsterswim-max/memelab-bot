// MemeLab AI — paper trading bot v11.1 "desk + learning + profit lock" (NO real money, NO wallet, NO private keys)
// Agents: Scout -> Filter -> Mood -> Learner gate -> RugCheck -> Analyst -> Executor -> Risk -> Logger
//   * OBSERVATIONS: every coin the bot sees is saved in the database (bot_observations) with its features,
//     and its price is followed for HORIZON_H hours, also for coins that were REJECTED (so we learn if the filters help)
//   * LEARNER (every LEARN_SEC): learns from those outcomes (simulated with the bot's own exit rules)
//       - entry gate: expected return of a coin from its features/hour/source/market mood ("is it worth it / good moment")
//       - exit tuning: picks better stop/trailing/partial settings, only if they also win on NEWER data
//       - reports: kill value of every filter, best/worst buckets, by hour, by source, MFE/MAE of real trades
//   * MARKET MOOD filter: no entries when the scanned market is clearly falling
//   * MFE/MAE of every real trade is saved
//   * PROFIT LOCK (v11.1): once the price has been +10% above entry, a 3.5% fall from the peak closes the position
//   Learning code is wrapped in try/catch: if it fails, trading continues as before.
// Needs the SQL for bot_observations and bot_learning. Without it the bot runs without learning.
// Run:  npm i @supabase/supabase-js
//   node Bot.mjs --minutes=345   (loop for N minutes, then exit; GitHub Actions 24/7)
//   node Bot.mjs                 (loop forever)
//   node Bot.mjs --once          (one pass)
//   node Bot.mjs --backtest      (replays saved trade snapshots with many exit settings)
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
const MAX_LIQ_PCT = num("MAX_LIQ_PCT", 0.02);
const MIN_USD = num("MIN_USD", 5);
const MAX_USD = num("MAX_USD", 0);
const MAX_OPEN = num("MAX_OPEN", 8);

// -- protection against repeating mistakes --
const LOSS_BAN_H = num("LOSS_BAN_H", 168);
const PAUSE_LOSSES = num("PAUSE_LOSSES", 4);
const PAUSE_MIN = num("PAUSE_MIN", 30);
const TIME_STOP_H = num("TIME_STOP_H", 3);

// -- SCOUT --
const SCAN_SEC = num("SCAN_SEC", 300);
const MAX_CAND = num("MAX_CAND", 300);
const GECKO = num("GECKO", 1);
const SEARCH_ON = num("SEARCH_ON", 1);
const SEARCH_QUERIES = (process.env.SEARCH_QUERIES || "pump,pumpswap,raydium,meme,ai,cat,dog,pepe,trump,sol")
  .split(",").map(s => s.trim()).filter(Boolean);
const AGE_MIN_H = num("AGE_MIN_H", 0.5);
const AGE_MAX_H = num("AGE_MAX_H", 72);
const MC_MIN = num("MC_MIN", 300000);
const MC_MAX = num("MC_MAX", 20000000);

// -- FILTER (DexScreener data) --
const LIQ_MIN = num("LIQ_MIN", 40000);
const VOL1H_MIN = num("VOL1H_MIN", 50000);
const CH1_MAX = num("CH1_MAX", 80);
const CH5_MAX = num("CH5_MAX", 25);

// -- FILTER (RugCheck data) --
const RUGCHECK = num("RUGCHECK", 1);
const RUGCHECK_STRICT = num("RUGCHECK_STRICT", 1);
const MAX_RC = num("MAX_RC", 25);
const LP_LOCK_MIN = num("LP_LOCK_MIN", 70);
const LP_STRICT = num("LP_STRICT", 0);
const MAX_TOP10 = num("MAX_TOP10", 25);
const MAX_DEV = num("MAX_DEV", 3);
const MAX_BUNDLED = num("MAX_BUNDLED", 10);
const CREATOR_BAN = num("CREATOR_BAN", 1);
const RC_DEBUG = num("RC_DEBUG", 1);

// -- ANALYST --
const MIN_SCORE = num("MIN_SCORE", 70);
const WATCH_MIN = num("WATCH_MIN", 55);
const MOM_M5_MIN = num("MOM_M5_MIN", 0);
const SMART = new Set((process.env.SMART_WALLETS || "").split(",").map(s => s.trim()).filter(Boolean));

// -- MARKET MOOD (computed from the coins scanned in each scan) --
const MOOD_ON = num("MOOD_ON", 1);
const MOOD_BLOCK_MEDIAN = num("MOOD_BLOCK_MEDIAN", -8);
const MOOD_BLOCK_BREADTH = num("MOOD_BLOCK_BREADTH", 0.25);
const MOOD_MIN_PAIRS = num("MOOD_MIN_PAIRS", 15);

// -- OBSERVATIONS (every coin seen is saved and followed) --
const OBS_ON = num("OBS_ON", 1);
const HORIZON_H = num("HORIZON_H", 3);
const FOLLOW_SEC = num("FOLLOW_SEC", 300);
const PERSIST_SEC = num("PERSIST_SEC", 900);
const OBS_DEDUPE_H = num("OBS_DEDUPE_H", 3);
const OBS_MAX_PER_SCAN = num("OBS_MAX_PER_SCAN", 400);
const MAX_FOLLOW = num("MAX_FOLLOW", 500);
const MISSING_N = num("MISSING_N", 3);

// -- LEARNER --
const LEARN_ON = num("LEARN", 1);
const LEARN_SEC = num("LEARN_SEC", 1800);
const LEARN_DAYS = num("LEARN_DAYS", 14);
const LEARN_MIN_OBS = num("LEARN_MIN_OBS", 120);
const LEARN_MIN_EXIT = num("LEARN_MIN_EXIT", 100);
const LEARN_K = num("LEARN_K", 15);
const LEARN_MIN_EDGE = num("LEARN_MIN_EDGE", 0);
const LEARN_GATE = (process.env.LEARN_GATE || "auto").toLowerCase();   // auto = block when validated | shadow = only log | off
const LEARN_EXITS = num("LEARN_EXITS", 1);
const LEARN_EXIT_COOLDOWN_H = num("LEARN_EXIT_COOLDOWN_H", 6);

// -- optional pullback entry (off by default) --
const PULLBACK = num("PULLBACK", 0);
const PULL_MIN = num("PULL_MIN", 3);
const PULL_MAX = num("PULL_MAX", 12);
const BOUNCE = num("BOUNCE", 1);
const SIGNAL_MIN = num("SIGNAL_MIN", 60);
const MAX_SIGNALS = num("MAX_SIGNALS", 20);

// -- RISK --
const STOP = num("STOP", 0.94);
const ARM_X = num("ARM_X", 1.12);
const TRAIL_WIDE = num("TRAIL_WIDE", 6);
const TRAIL_LOCK = num("TRAIL_LOCK", 6);
const TRAIL_PCT = num("TRAIL_PCT", 5);
const TRAIL_TIGHT = num("TRAIL_TIGHT", 3);
const TIER_LO_X = num("TIER_LO_X", 1.5);
const TIER_HI_X = num("TIER_HI_X", 3);
const LOCK_X = num("LOCK_X", 1.30);
const LOCK_FLOOR = num("LOCK_FLOOR", 1.06);
const FAST_DROP = num("FAST_DROP", 4);
const PL_X = num("PL_X", 1.10);          // once the price has been +10% above entry...
const PL_DROP = num("PL_DROP", 3.5);     // ...sell everything when it falls this % below the peak (0 = off)
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
const VERBOSE = num("LOG_KILLS_VERBOSE", 0);

// -- simulated costs --
const FEE = num("FEE", 0.005), SLIP = num("SLIP", 0.015);

// -- 24/7 hardening --
const HTTP_TIMEOUT_MS = num("HTTP_TIMEOUT_MS", 15000);
const WATCHDOG_MIN = num("WATCHDOG_MIN", 10);
// ========================================================================================

// EP = the exit parameters that are really used (start = settings above, the learner may move some of them within BOUNDS)
const EP = { STOP, ARM_X, TRAIL_WIDE, TRAIL_LOCK, TRAIL_PCT, TRAIL_TIGHT, TIER_LO_X, TIER_HI_X, LOCK_X, LOCK_FLOOR, FAST_DROP, PL_X, PL_DROP, PARTIAL_X, PARTIAL_PCT, PARTIAL2_X, PARTIAL2_PCT };
const BOUNDS = { STOP: [0.85, 0.97], TRAIL_WIDE: [3, 12], TRAIL_PCT: [3, 8], PARTIAL_X: [1.2, 2.5], FAST_DROP: [2, 8], LOCK_FLOOR: [1.02, 1.12] };
const GRID = { STOP: [0.88, 0.92, 0.94, 0.96], TRAIL_WIDE: [4, 6, 8], TRAIL_PCT: [4, 5, 7], PARTIAL_X: [1.3, 1.5, 2], FAST_DROP: [3, 4, 6], LOCK_FLOOR: [1.03, 1.06, 1.10] };
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
const pc = v => (v === null || v === undefined || !isFinite(v) ? "n/a" : (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%");
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
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
// tick (optional) runs between requests, so open positions keep being checked during long jobs
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
  for (const stage of ["scout", "filter", "mood", "pause", "learner", "rugcheck", "analyst"]) {
    if (!by[stage]) continue;
    const list = by[stage].sort((a, b) => b[1] - a[1]);
    log("KILLS", stage, `${list.reduce((s, [, n]) => s + n, 0)} total:`, list.slice(0, 6).map(([r, n]) => `${r} (${n})`).join("; "));
  }
  for (const k of Object.keys(killCount)) delete killCount[k];
}

// =====================================================================================
// SCOUT: token sources (DexScreener lists + keyword search + GeckoTerminal pools), every coin keeps its source tag
// =====================================================================================
const STABLE = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);
const GECKO_URLS = [
  ["gecko-new", "https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1"],
  ["gecko-new", "https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=2"],
  ["gecko-trending", "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=1h"],
  ["gecko-volume", "https://api.geckoterminal.com/api/v2/networks/solana/pools?page=1&sort=h24_volume_usd_desc"],
  ["gecko-volume", "https://api.geckoterminal.com/api/v2/networks/solana/pools?page=2&sort=h24_volume_usd_desc"],
];
const srcOf = new Map();   // mint -> source tag (first source that found it)
async function discover(tick) {
  const set = new Set();
  const add = (a, tag) => { if (typeof a === "string" && a && !STABLE.has(a)) { set.add(a); if (!srcOf.has(a)) srcOf.set(a, tag); } };
  const run = async (label, fn, gap) => {
    const before = set.size;
    try { await fn(); } catch (e) { log(`discover ${label} failed:`, e.message); }
    log(`discover ${label}: +${set.size - before}`);
    await sleep(gap);
    if (tick) await tick();
  };
  const dexLists = [["token-profiles/latest/v1", "dex-profiles"], ["token-boosts/latest/v1", "dex-boosts"], ["token-boosts/top/v1", "dex-top"], ["community-takeovers/latest/v1", "dex-community"], ["ads/latest/v1", "dex-ads"]];
  for (const [path, tag] of dexLists) {
    await run("dex " + path.split("/")[0], async () => {
      const j = await api("https://api.dexscreener.com/" + path);
      (Array.isArray(j) ? j : []).forEach(x => x?.chainId === "solana" && add(x.tokenAddress, tag));
    }, 1100);
  }
  if (SEARCH_ON) {
    for (const q of SEARCH_QUERIES) {
      await run("search " + q, async () => {
        const j = await api("https://api.dexscreener.com/latest/dex/search?q=" + encodeURIComponent(q));
        (j?.pairs || []).forEach(p => p?.chainId === "solana" && add(p.baseToken?.address, "search"));
      }, 450);
    }
  }
  if (GECKO) {
    for (const [tag, u] of GECKO_URLS) {
      await run("gecko " + u.split("/").pop().split("?")[0], async () => {
        const j = await api(u);
        (j?.data || []).forEach(d => {
          const id = d?.relationships?.base_token?.data?.id;
          if (typeof id === "string" && id.startsWith("solana_")) add(id.slice(7), tag);
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
// MARKET MOOD: median 1h change and share of rising coins among the active coins of a scan
// =====================================================================================
let MOOD = { median: 0, breadth: 0.5, n: 0 };
function computeMood(pairs) {
  const act = pairs.filter(p => (p.liquidity?.usd || 0) >= 10000 && ((p.txns?.h1?.buys || 0) + (p.txns?.h1?.sells || 0)) >= 20 && typeof p.priceChange?.h1 === "number");
  if (!act.length) return { median: 0, breadth: 0.5, n: 0 };
  const ch = act.map(p => p.priceChange.h1).sort((a, b) => a - b);
  const med = ch.length % 2 ? ch[(ch.length - 1) / 2] : (ch[ch.length / 2 - 1] + ch[ch.length / 2]) / 2;
  return { median: med, breadth: ch.filter(v => v > 0).length / ch.length, n: ch.length };
}

// =====================================================================================
// FILTER (RugCheck part): mint/freeze, LP, top10, dev, bundled, past rugs
// =====================================================================================
const rcCache = new Map();
const holderHist = new Map();
let rcDebugged = false;
const rcFresh = m => { const h = rcCache.get(m); return !!h && Date.now() - h.t < h.ttl; };
const rcPeek = m => rcCache.get(m)?.res || null;
function holderGrowth(mint) {
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

    const markets = Array.isArray(j?.markets) ? j.markets : [];
    const lpVals = markets.map(m => m?.lp?.lpLockedPct).filter(v => typeof v === "number" && isFinite(v));
    const lpPct = lpVals.length ? Math.max(...lpVals) : null;
    if (lpPct !== null && lpPct < LP_LOCK_MIN) kills.push({ key: `LP burned/locked under ${LP_LOCK_MIN}%`, detail: `LP burned/locked only ${lpPct.toFixed(0)}%` });
    else if (lpPct === null && LP_STRICT) kills.push({ key: "LP lock data missing", detail: "no LP lock data" });

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
      else if (th.length) dev = 0;
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
// ANALYST: score 0-100. Weights: momentum 25, buyers 15, buy/sell 20, holder growth 15, liq/mcap 15, smart wallets 10
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
  parts.holders = g === null ? 7 : clamp(g / 5, 0, 1) * 15;
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
  if (/profit lock/i.test(r)) return "profit lock";
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

// ---- real trades by hour of entry (UTC, 4h blocks) ----
function hourStats(cycles) {
  const agg = {};
  for (const c of cycles) {
    const h = Math.floor(new Date(c.at).getUTCHours() / 4) * 4;
    const a = agg[h] || (agg[h] = { n: 0, wins: 0, pnl: 0 });
    a.n++; a.pnl += c.pnl; if (c.pnl > 0) a.wins++;
  }
  return Object.keys(agg).map(Number).sort((a, b) => a - b).map(h => `h${h}-${h + 3}: ${agg[h].n} trades, wins ${agg[h].wins}, P&L $${agg[h].pnl.toFixed(2)}`);
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
  const hs = hourStats(cycles);
  if (hs.length) log("HOURS", hs.join(" | "));
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
    `market mood now: median 1h ${fmt1(MOOD.median)}%, ${(MOOD.breadth * 100).toFixed(0)}% of ${MOOD.n} active coins up`,
    "exit reasons (all time):",
    ...exitStats(S, all).map(l => "  " + l),
    ...(LEARN.lines.length ? ["learning:", ...LEARN.lines.slice(0, 12).map(l => "  " + l.slice(0, 260))] : []),
  ];
  lines.forEach(l => log("REPORT", l));
  await notify(lines.join("\n"));
}

// =====================================================================================
// RISK: exit rules — one pure function used by the live bot, the backtest AND the learner
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
  if (P.PL_DROP > 0 && peakX >= P.PL_X && x <= peakX * (1 - P.PL_DROP / 100)) return { exit: `profit lock ${P.PL_DROP}% below peak ${peakX.toFixed(4)}x`, partials, locked };
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
function gridCombos(grid) {
  let combos = [{}];
  for (const k of Object.keys(grid)) { const next = []; for (const c of combos) for (const v of grid[k]) next.push({ ...c, [k]: v }); combos = next; }
  return combos;
}

// =====================================================================================
// OBSERVATIONS: every coin seen is saved (bot_observations) and its price is followed for HORIZON_H hours
// stage ranks: a coin is saved again within the dedupe window only if it got further in the pipeline
// =====================================================================================
const RANK = { scout: 1, filter: 2, mood: 3, pause: 3, learner: 3, rugcheck: 4, analyst: 5, executor: 6 };
const POP = new Set(["mood", "pause", "learner", "rugcheck", "analyst"]);   // coins that passed the DexScreener filters
const OBS = { ok: false, pending: new Map(), seen: new Map(), queue: [] };

function featsOf(p) {
  const addr = p.baseToken.address;
  const liq = p.liquidity?.usd || 0, mc = p.marketCap || p.fdv || 0, vol1 = p.volume?.h1 || 0, vol24 = p.volume?.h24 || 0;
  const age = (Date.now() - (p.pairCreatedAt || Date.now())) / 36e5;
  const b1 = p.txns?.h1?.buys || 0, s1 = p.txns?.h1?.sells || 0;
  const ch5 = typeof p.priceChange?.m5 === "number" ? p.priceChange.m5 : null;
  return {
    age: round(age, 2), liq: Math.round(liq), mcap: Math.round(mc), vol1h: Math.round(vol1), vol24h: Math.round(vol24),
    ch5, ch1: p.priceChange?.h1 ?? null, ch6: p.priceChange?.h6 ?? null, b1, s1,
    bsr1: b1 + s1 ? round(b1 / (b1 + s1), 3) : null, liqmc: mc ? round(liq / mc, 4) : null,
    mood: MOOD.n ? round(MOOD.median, 1) : null, src: srcOf.get(addr) || "?", hour: new Date().getUTCHours(),
  };
}
function rec(p, stage, verdict, reason, f) {
  if (!OBS.ok) return;
  const price = +p.priceUsd;
  if (!(price > 0)) return;
  const mint = p.baseToken.address, rank = RANK[stage] || 1;
  const s = OBS.seen.get(mint);
  if (s && Date.now() - s.t < OBS_DEDUPE_H * 36e5 && rank <= s.rank) return;
  OBS.seen.set(mint, { t: Date.now(), rank });
  const feats = f || featsOf(p);
  OBS.queue.push({ rank, row: { user_id: USER, mint, ticker: tickerOf(p), source: feats.src, stage, verdict, reason: String(reason).slice(0, 120), price, features: feats, path: [[0, 0]], done: false, stale: false, entered: false } });
}
async function obsInit() {
  if (!OBS_ON) return;
  const t = await db.from("bot_observations").select("id").limit(1);
  if (t.error) { log("OBSERVATIONS DISABLED (run the SQL for bot_observations and bot_learning first):", t.error.message); return; }
  OBS.ok = true;
  const since = new Date(Date.now() - (HORIZON_H * 60 + 15) * 6e4).toISOString();
  await db.from("bot_observations").update({ done: true, stale: true }).eq("user_id", USER).eq("done", false).lt("seen_at", since);
  const pr = await db.from("bot_observations").select("id,mint,seen_at,price,path").eq("user_id", USER).eq("done", false).gte("seen_at", since).order("seen_at", { ascending: false }).limit(MAX_FOLLOW);
  if (!pr.error) for (const x of pr.data) OBS.pending.set(x.id, { id: x.id, mint: x.mint, price0: +x.price, t0: +new Date(x.seen_at), path: Array.isArray(x.path) && x.path.length ? x.path : [[0, 0]], miss: 0, dirty: false, finish: false, dead: false });
  const sn = await db.from("bot_observations").select("mint,stage,seen_at").eq("user_id", USER).gte("seen_at", new Date(Date.now() - OBS_DEDUPE_H * 36e5).toISOString()).limit(5000);
  if (!sn.error) for (const x of sn.data) { const rk = RANK[x.stage] || 1, cur = OBS.seen.get(x.mint); if (!cur || rk > cur.rank) OBS.seen.set(x.mint, { t: +new Date(x.seen_at), rank: rk }); }
  log(`observations ON: following ${OBS.pending.size} coins, dedupe memory ${OBS.seen.size}`);
}
async function obsFlush() {
  if (!OBS.ok || !OBS.queue.length) return;
  let q = OBS.queue; OBS.queue = [];
  q.sort((a, b) => b.rank - a.rank);
  if (q.length > OBS_MAX_PER_SCAN) q = q.slice(0, OBS_MAX_PER_SCAN);
  let room = Math.max(0, MAX_FOLLOW - OBS.pending.size);
  for (const it of q) {                                         // coins beyond the follow limit are still saved, but not followed
    if (room > 0) room--; else { it.row.done = true; it.row.stale = true; }
  }
  let saved = 0;
  for (let i = 0; i < q.length; i += 100) {
    const chunk = q.slice(i, i + 100).map(x => x.row);
    const r = await db.from("bot_observations").insert(chunk).select("id,mint,price,done");
    if (r.error) { log("obs insert failed:", r.error.message); continue; }
    saved += r.data.length;
    for (const row of r.data) if (!row.done) OBS.pending.set(row.id, { id: row.id, mint: row.mint, price0: +row.price, t0: Date.now(), path: [[0, 0]], miss: 0, dirty: false, finish: false, dead: false });
  }
  const cut = Date.now() - OBS_DEDUPE_H * 36e5;
  for (const [k, v] of OBS.seen) if (v.t < cut) OBS.seen.delete(k);
  log(`observations: saved ${saved} coins, following ${OBS.pending.size}`);
}
async function obsEntered(p, f, usd) {
  if (!OBS.ok) return;
  try {
    const feats = { ...(f || featsOf(p)), usd: round(usd, 2) };
    await must(db.from("bot_observations").insert({ user_id: USER, mint: p.baseToken.address, ticker: tickerOf(p), source: feats.src, stage: "executor", verdict: "entered", reason: "entered", price: +p.priceUsd, features: feats, path: [[0, 0]], done: true, stale: false, entered: true }));
  } catch (e) { log("obs entered failed:", e.message); }
}
async function obsTradeClosed(mint, o) {
  if (!OBS.ok) return;
  try {
    const r = await db.from("bot_observations").select("id").eq("user_id", USER).eq("mint", mint).eq("entered", true).is("closed_at", null).order("seen_at", { ascending: false }).limit(1);
    const id = r.data?.[0]?.id;
    if (!id) return;
    await must(db.from("bot_observations").update({ trade_ret: o.ret, mfe: o.mfe, mae: o.mae, exit_reason: String(o.why).slice(0, 80), closed_at: now() }).eq("id", id));
  } catch (e) { log("obs trade update failed:", e.message); }
}
const nearest = (path, min) => { let b = null, d = 1e9; for (const [m, r] of path) { const x = Math.abs(m - min); if (x < d) { d = x; b = r; } } return d <= 15 ? b : null; };
async function obsPersist(force) {
  if (!OBS.ok) return;
  const list = [...OBS.pending.values()];
  const fin = list.filter(o => o.finish), dirty = list.filter(o => !o.finish && force && o.dirty);
  for (let i = 0; i < fin.length; i += 100) {
    const part = fin.slice(i, i + 100);
    const rows = part.map(o => {
      const rets = o.path.map(q => q[1]);
      return { id: o.id, user_id: USER, mint: o.mint, path: o.path, done: true, resolved_at: now(), ret_1h: nearest(o.path, 60), ret_3h: nearest(o.path, 180), max_up: Math.max(...rets), max_dd: Math.min(...rets) };
    });
    const r = await db.from("bot_observations").upsert(rows, { onConflict: "id" });
    if (r.error) { log("obs persist failed:", r.error.message); break; }
    for (const o of part) OBS.pending.delete(o.id);
  }
  for (let i = 0; i < dirty.length; i += 100) {
    const part = dirty.slice(i, i + 100);
    const r = await db.from("bot_observations").upsert(part.map(o => ({ id: o.id, user_id: USER, mint: o.mint, path: o.path })), { onConflict: "id" });
    if (r.error) { log("obs persist failed:", r.error.message); break; }
    for (const o of part) o.dirty = false;
  }
}
async function obsFollow(tick) {
  if (!OBS.ok || !OBS.pending.size) return;
  const list = [...OBS.pending.values()];
  const best = bestPair(await pairsFor([...new Set(list.map(o => o.mint))], tick));
  const t = Date.now();
  let dead = 0, done = 0;
  for (const o of list) {
    const ageMin = (t - o.t0) / 6e4;
    const pr = best[o.mint];
    if (pr && +pr.priceUsd > 0) {
      o.miss = 0;
      o.path.push([round(ageMin, 1), round((+pr.priceUsd / o.price0 - 1) * 100, 2)]);
      o.dirty = true;
    } else {
      o.miss++;
      if (o.miss >= MISSING_N) { o.path.push([round(ageMin, 1), -95]); o.dead = true; o.dirty = true; dead++; }
    }
    if (o.dead || ageMin >= HORIZON_H * 60) { o.finish = true; done++; }
  }
  await obsPersist(false);
  log(`observations: checked ${list.length} followed coins, finished ${done} (dead ${dead}), still following ${OBS.pending.size}`);
}

// =====================================================================================
// LEARNER: learns from the resolved observations (what each coin would have earned with the bot's exit rules)
// =====================================================================================
const LEARN = { pop: [], ids: new Set(), last: null, model: null, gate: { active: false }, exitAt: 0, lines: [] };
const FEATS = ["age", "liq", "mcap", "vol1h", "ch5", "ch1", "bsr1", "liqmc", "hour", "src", "mood"];
const EDGES = {
  age: [1, 2, 6, 24, 48], liq: [20000, 40000, 80000, 200000, 500000], mcap: [300000, 1000000, 3000000, 10000000],
  vol1h: [20000, 50000, 150000, 500000], ch5: [-2, 0, 1, 3, 8], ch1: [-5, 0, 10, 30, 80],
  bsr1: [0.45, 0.5, 0.55, 0.6], liqmc: [0.03, 0.06, 0.1, 0.2], mood: [-8, -3, 0, 3],
};
const kfmt = v => (Math.abs(v) >= 1e6 ? v / 1e6 + "M" : Math.abs(v) >= 1e3 ? v / 1e3 + "k" : String(v));
function bkt(name, f) {
  if (name === "hour") { const h = Math.floor((f.hour ?? 0) / 4) * 4; return `hour ${h}-${h + 3}`; }
  if (name === "src") return "src " + (f.src || "?");
  const v = f[name];
  if (v === null || v === undefined || !isFinite(v)) return name + " n/a";
  const e = EDGES[name]; let i = 0;
  while (i < e.length && v >= e[i]) i++;
  return name + " " + (i === 0 ? "<" + kfmt(e[0]) : i === e.length ? ">=" + kfmt(e[e.length - 1]) : kfmt(e[i - 1]) + ".." + kfmt(e[i]));
}
const simRet = (o, P) => simulate(o.series, 1, P);

function trainRows(rows, K) {                       // rows: [{f, r}]
  const mAll = rows.reduce((s, o) => s + o.r, 0) / rows.length;
  const tab = {};
  for (const ft of FEATS) {
    const agg = {};
    for (const o of rows) { const b = bkt(ft, o.f); const a = agg[b] || (agg[b] = { n: 0, s: 0, w: 0 }); a.n++; a.s += o.r; if (o.r > 0) a.w++; }
    tab[ft] = {};
    for (const [b, a] of Object.entries(agg)) tab[ft][b] = { n: a.n, m: (a.s + K * mAll) / (a.n + K), raw: a.s / a.n, w: a.w / a.n };
  }
  return { mAll, n: rows.length, tab };
}
function edgeOf(model, f) {
  let s = 0;
  for (const ft of FEATS) { const e = model.tab[ft]?.[bkt(ft, f)]; s += e ? e.m : model.mAll; }
  return s / FEATS.length;
}
function validateGate(rows, K, T) {                 // train on the older 70%, test on the newest 30%
  rows = rows.slice().sort((a, b) => a.t - b.t);
  const cut = Math.floor(rows.length * 0.7), train = rows.slice(0, cut), test = rows.slice(cut);
  const mean = a => (a.length ? a.reduce((s, o) => s + o.r, 0) / a.length : null);
  if (train.length < 60 || test.length < 25) return { ok: false, why: "not enough data", accN: 0, testN: test.length, accMean: null, rejMean: null, allMean: mean(test) };
  const m = trainRows(train, K);
  const acc = test.filter(o => edgeOf(m, o.f) >= T), rej = test.filter(o => edgeOf(m, o.f) < T);
  const accMean = mean(acc), rejMean = mean(rej), allMean = mean(test);
  const ok = acc.length >= 15 && accMean !== null && accMean > allMean + 0.002 && (rejMean === null || accMean > rejMean);
  return { ok, accN: acc.length, rejN: rej.length, testN: test.length, accMean, rejMean, allMean };
}

const lsGet = async key => {
  const r = await db.from("bot_learning").select("value").eq("user_id", USER).eq("key", key).maybeSingle();
  if (r.error) throw new Error("bot_learning: " + r.error.message);
  return r.data?.value ?? null;
};
const lsSet = async (key, value) => must(db.from("bot_learning").upsert({ user_id: USER, key, value, updated_at: now() }, { onConflict: "user_id,key" }));
function applyExitParams(o) {
  for (const k of Object.keys(BOUNDS)) if (typeof o[k] === "number" && o[k] >= BOUNDS[k][0] && o[k] <= BOUNDS[k][1]) EP[k] = o[k];
}
async function learnInit() {
  if (!LEARN_ON || !OBS.ok) return;
  try {
    const ex = await lsGet("exit_params");
    if (ex?.params) { applyExitParams(ex.params); LEARN.exitAt = ex.at ? +new Date(ex.at) : 0; log("LEARN loaded exit params:", Object.keys(BOUNDS).map(k => k + "=" + EP[k]).join(" ")); }
    const md = await lsGet("model");
    if (md?.model?.tab) {
      LEARN.model = md.model; LEARN.gate = md.gate || { active: false };
      if (LEARN_GATE !== "auto") LEARN.gate.active = false;
      log(`LEARN loaded entry model (${md.model.n} coins), gate ${LEARN.gate.active ? "ACTIVE" : "inactive"}`);
    }
  } catch (e) { log("learn init failed:", e.message); }
}
async function learnLoad() {
  const since = LEARN.last ? new Date(+new Date(LEARN.last) - 5000).toISOString() : new Date(Date.now() - LEARN_DAYS * 864e5).toISOString();
  let maxR = LEARN.last;
  for (let from = 0; ; from += 1000) {
    const r = await db.from("bot_observations").select("id,seen_at,stage,verdict,reason,features,path,resolved_at")
      .eq("user_id", USER).eq("done", true).eq("stale", false).eq("entered", false).gte("resolved_at", since)
      .order("resolved_at", { ascending: true }).range(from, from + 999);
    if (r.error) throw new Error("bot_observations: " + r.error.message);
    for (const x of r.data) {
      if (LEARN.ids.has(x.id)) continue;
      LEARN.ids.add(x.id);
      const path = Array.isArray(x.path) ? x.path : [];
      if (path.length >= 2) LEARN.pop.push({ id: x.id, t: +new Date(x.seen_at), f: x.features || {}, stage: x.stage, reason: x.reason, series: path.slice(1).map(q => ({ price: Math.max(0.0001, 1 + (+q[1]) / 100) })) });
      if (!maxR || x.resolved_at > maxR) maxR = x.resolved_at;
    }
    if (r.data.length < 1000) break;
  }
  LEARN.last = maxR;
  const cutoff = Date.now() - LEARN_DAYS * 864e5;
  LEARN.pop = LEARN.pop.filter(o => o.t >= cutoff).sort((a, b) => a.t - b.t).slice(-6000);
}
async function tuneExits(pop, tick) {
  const rows = pop.slice(-1000);
  const cut = Math.floor(rows.length * 0.7), tr = rows.slice(0, cut), te = rows.slice(cut);
  const avg = (list, P) => list.reduce((s, o) => s + simRet(o, P), 0) / list.length;
  const curTr = avg(tr, EP), curTe = avg(te, EP);
  let best = null, bestTr = -Infinity, i = 0;
  for (const c of gridCombos(GRID)) {
    const a = avg(tr, { ...EP, ...c });
    if (a > bestTr) { bestTr = a; best = c; }
    if (++i % 60 === 0) { await sleep(0); if (tick) await tick(); }
  }
  const bestTe = avg(te, { ...EP, ...best });
  const diff = Object.keys(best).filter(k => Math.abs(best[k] - EP[k]) > 1e-9);
  const sum = `exits: current train ${pc(curTr)} / test ${pc(curTe)} | best train ${pc(bestTr)} / test ${pc(bestTe)} (${diff.map(k => k + "=" + best[k]).join(" ") || "same as current"})`;
  const cooled = Date.now() - LEARN.exitAt >= LEARN_EXIT_COOLDOWN_H * 36e5;
  if (diff.length && bestTr > curTr && bestTe > curTe + 0.003 && te.length >= 25 && cooled) {
    Object.assign(EP, best);
    LEARN.exitAt = Date.now();
    await lsSet("exit_params", { params: Object.fromEntries(Object.keys(BOUNDS).map(k => [k, EP[k]])), at: now(), n: rows.length, trainAvg: bestTr, testAvg: bestTe });
    return sum + " -> ADOPTED";
  }
  return sum + (diff.length ? (cooled ? " -> not adopted (no clear gain on newer data)" : " -> cooldown") : "");
}
function groupStats(items, keyFn, minN) {
  const g = {};
  for (const o of items) { const k = keyFn(o); const a = g[k] || (g[k] = { n: 0, s: 0, w: 0 }); const r = simRet(o, EP); a.n++; a.s += r; if (r > 0) a.w++; }
  return Object.entries(g).filter(([, a]) => a.n >= minN).map(([k, a]) => ({ k, n: a.n, avg: a.s / a.n, win: a.w / a.n }));
}
async function tradeStats() {
  const r = await db.from("bot_observations").select("trade_ret,mfe,mae").eq("user_id", USER).eq("entered", true).not("trade_ret", "is", null).order("seen_at", { ascending: false }).limit(500);
  if (r.error || !r.data || r.data.length < 5) return null;
  const rows = r.data, w = rows.filter(x => x.trade_ret > 0), l = rows.filter(x => x.trade_ret <= 0);
  const avgOf = (a, k) => (a.length ? a.reduce((s, x) => s + (+x[k] || 0), 0) / a.length : null);
  const armPct = (ARM_X - 1) * 100;
  const lMfe = l.filter(x => x.mfe >= armPct).length;
  return `real trades (${rows.length}): losers avg best point ${fmt1(avgOf(l, "mfe"))}% (${l.length ? Math.round(lMfe / l.length * 100) : 0}% of losers had been above +${armPct.toFixed(0)}% first), winners avg worst dip ${fmt1(avgOf(w, "mae"))}%`;
}
async function learnCycle(tick) {
  if (!LEARN_ON || !OBS.ok) return;
  step = "learn";
  await learnLoad();
  const pop = LEARN.pop.filter(o => POP.has(o.stage));
  const lines = [`data: ${LEARN.pop.length} resolved coins (${pop.length} passed the DexScreener filters), still following ${OBS.pending.size}`];

  if (LEARN_EXITS && pop.length >= LEARN_MIN_EXIT) lines.push(await tuneExits(pop, tick));
  else lines.push(`exits: collecting data (${pop.length}/${LEARN_MIN_EXIT})${LEARN_EXITS ? "" : ", tuning switched off"}`);

  if (pop.length >= LEARN_MIN_OBS) {
    const rows = pop.map(o => ({ t: o.t, f: o.f, r: simRet(o, EP) }));
    const val = validateGate(rows, LEARN_K, LEARN_MIN_EDGE);
    LEARN.model = trainRows(rows, LEARN_K);
    LEARN.gate = { active: LEARN_GATE === "auto" && val.ok, val, at: now() };
    await lsSet("model", { model: LEARN.model, gate: LEARN.gate });
    lines.push(`entry gate: ${LEARN.gate.active ? "ACTIVE" : LEARN_GATE === "auto" ? "inactive (not validated yet)" : LEARN_GATE} | test: accepted ${val.accN ?? 0} of ${val.testN ?? 0}, avg ${pc(val.accMean)} vs all ${pc(val.allMean)}${val.why ? " (" + val.why + ")" : ""} | avg simulated trade of all ${pc(LEARN.model.mAll)}`);
    const all = [];
    for (const ft of FEATS) if (ft !== "hour" && ft !== "src") for (const [b, e] of Object.entries(LEARN.model.tab[ft])) if (e.n >= 15) all.push({ b, ...e });
    all.sort((a, b) => b.raw - a.raw);
    const fmtB = e => `${e.b} n=${e.n} avg ${pc(e.raw)} win ${(e.w * 100).toFixed(0)}%`;
    if (all.length >= 6) {
      lines.push("best buckets: " + all.slice(0, 3).map(fmtB).join(" | "));
      lines.push("worst buckets: " + all.slice(-3).reverse().map(fmtB).join(" | "));
    }
    for (const [ft, label] of [["hour", "by hour (UTC)"], ["src", "by source"]]) {
      const e = Object.entries(LEARN.model.tab[ft]).filter(([, v]) => v.n >= 10).sort((a, b) => b[1].raw - a[1].raw);
      if (e.length) lines.push(`${label}: ` + e.map(([b, v]) => `${b.replace(/^(hour|src) /, "")} n=${v.n} ${pc(v.raw)}`).join(" | "));
    }
  } else lines.push(`entry model: collecting data (${pop.length}/${LEARN_MIN_OBS})`);

  const kv = groupStats(LEARN.pop, o => o.stage + ": " + o.reason, 12).sort((a, b) => b.avg - a.avg);
  if (kv.length) {
    const f = e => `${e.k} n=${e.n} avg ${pc(e.avg)} win ${(e.win * 100).toFixed(0)}%`;
    lines.push("filters that kill profitable coins (avg > 0 = filter costs money): " + kv.slice(0, 3).map(f).join(" | "));
    lines.push("filters that protect (avg < 0 = filter helps): " + kv.slice(-3).reverse().map(f).join(" | "));
  }
  try { const ts = await tradeStats(); if (ts) lines.push(ts); } catch { /* optional */ }

  LEARN.lines = lines;
  lines.forEach(l => log("LEARN", l));
}

// =====================================================================================
// EXECUTOR: opens one paper position (the stop is defined before the entry)
// returns { ok:true, usd } | { ok:false, park:"reason" } | { ok:false }
// =====================================================================================
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
    `score ${e.score}/100, tier ${e.tier}, size $${usd.toFixed(2)} (${(usd / ctx.equity * 100).toFixed(1)}% of portfolio, base ${(pct * 100).toFixed(1)}%). entry: ${how}. stop set before entry at $${(price * EP.STOP).toPrecision(5)} (-${Math.round((1 - EP.STOP) * 100)}%). learned edge ${e.edge === null || e.edge === undefined ? "n/a" : pc(e.edge)}, mood ${fmt1(MOOD.median)}%. rugcheck: ${e.rc?.note || "n/a"}. creator:${e.rc?.creator || "unknown"}. ${e.note}`,
    `Stop -${Math.round((1 - EP.STOP) * 100)}%; profit lock: after +${Math.round((EP.PL_X - 1) * 100)}% sell on a ${EP.PL_DROP}% drop from the peak; trailing after +${Math.round((EP.ARM_X - 1) * 100)}% (${EP.TRAIL_WIDE}/${EP.TRAIL_LOCK}/${EP.TRAIL_PCT}/${EP.TRAIL_TIGHT}%); sell ${Math.round(EP.PARTIAL_PCT * 100)}% at ${EP.PARTIAL_X}x and ${Math.round(EP.PARTIAL2_PCT * 100)}% at ${EP.PARTIAL2_X}x; floor ${EP.LOCK_FLOOR}x from +${Math.round((EP.LOCK_X - 1) * 100)}%; liquidity drop ${LIQ_DROP}%/${LIQ_WINDOW_MIN}min; time stop ${TIME_STOP_H}h`,
    `Tier ${e.tier}. Memecoin: can go to zero.`);
  await obsEntered(e.p, e.f, usd);
  log("ENTER", tok.ticker, "score", e.score, "tier", e.tier, "size $" + usd.toFixed(2), "edge", e.edge === null || e.edge === undefined ? "n/a" : pc(e.edge), "|", how);
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
    const r = await enter(S, { p, rc, ...a, f: featsOf(p), edge: null }, ctx, `pullback ${dd.toFixed(1)}% below the high, bounce from the low`);
    if (r.ok) changed = true;
  }
  return changed;
}

// =====================================================================================
// SCAN: Scout -> Filter -> Mood -> Learner gate -> RugCheck -> Analyst -> Executor
// Every coin that is seen is recorded (rec) with the stage that stopped it.
// =====================================================================================
async function scan(S, tick, refresh) {
  const cycles = closedCycles(S);
  const pl = pauseLeftMin(cycles);
  const canTrade = pl <= 0;
  if (!canTrade) log(`ENTRY PAUSE: ${PAUSE_LOSSES} losing trades in a row, ${pl.toFixed(0)} min left, no new entries (coins are still recorded)`);
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
  srcOf.clear();
  const found = (await discover(tick)).filter(a => !known.has(a));
  for (const a of reentry) if (!srcOf.has(a)) srcOf.set(a, "reentry");
  for (const a of watch) if (!srcOf.has(a)) srcOf.set(a, "watch");
  const addrs = [...new Set([...reentry, ...watch, ...found])].slice(0, MAX_CAND);
  log(`scan: ${addrs.length} candidates (${found.length} new, ${reentry.length} re-entry, ${watch.length} waiting), banned creators ${banned.size}, signals ${signals.size}`);
  step = "fetch pair data";
  const pairs = Object.values(bestPair(await pairsFor(addrs, tick)));

  // ---- market mood ----
  MOOD = computeMood(pairs);
  const moodBlock = !!MOOD_ON && MOOD.n >= MOOD_MIN_PAIRS && (MOOD.median < MOOD_BLOCK_MEDIAN || MOOD.breadth < MOOD_BLOCK_BREADTH);
  log(`MOOD: median 1h ${fmt1(MOOD.median)}%, ${(MOOD.breadth * 100).toFixed(0)}% of ${MOOD.n} active coins up -> ${MOOD_ON ? (moodBlock ? "BLOCK entries" : "OK") : "off"}`);

  const fcache = new Map();
  const F = p => { const k = p.baseToken.address; let f = fcache.get(k); if (!f) { f = featsOf(p); fcache.set(k, f); } return f; };

  const scouted = [];
  for (const p of pairs) {
    const r = scoutKills(p);
    if (r.length) { r.forEach(x => { tally("scout", x); if (VERBOSE) killLine("scout", tickerOf(p), x); }); rec(p, "scout", "killed", r[0], F(p)); }
    else scouted.push(p);
  }

  // ---- 2) FILTER (DexScreener) ----
  const filtered = [];
  for (const p of scouted) {
    const r = filterKills(p);
    if (r.length) { r.forEach(x => { tally("filter", x); if (VERBOSE) killLine("filter", tickerOf(p), x); }); rec(p, "filter", "killed", r[0], F(p)); }
    else filtered.push(p);
  }
  log(`desk: ${pairs.length} pairs -> scout ${scouted.length} -> filter ${filtered.length}`);
  filtered.sort((a, b) => (b.volume?.h1 || 0) - (a.volume?.h1 || 0));

  // ---- 3) MOOD + PAUSE + LEARNER GATE ----
  const gateActive = LEARN_GATE === "auto" && !!LEARN.model && !!LEARN.gate?.active;
  let shadowRej = 0, gated = 0;
  const toRug = [];
  for (const p of filtered) {
    const f = F(p);
    if (moodBlock) { tally("mood", "market mood blocked"); rec(p, "mood", "killed", "market mood blocked", f); continue; }
    if (!canTrade) { tally("pause", "entry pause after losing streak"); rec(p, "pause", "killed", "entry pause after losing streak", f); continue; }
    const edge = LEARN.model ? edgeOf(LEARN.model, f) : null;
    f.edge = edge === null ? null : round(edge, 4);
    if (edge !== null && edge < LEARN_MIN_EDGE) {
      if (gateActive) { gated++; tally("learner", "learned edge below threshold"); rec(p, "learner", "killed", "learned edge below threshold", f); continue; }
      shadowRej++;
    }
    toRug.push({ p, f, edge });
  }
  if (LEARN.model) log(`LEARN gate: ${gateActive ? "ACTIVE, blocked " + gated : "not blocking, would have blocked " + shadowRej} of ${filtered.length} filtered coins`);

  const handled = new Set();
  const park = async (e, reason) => {
    handled.add(e.p.baseToken.address);
    const tok = await tokenFor(S, e.p);
    if (tok.status === "POCZEKAĆ") return;
    await snapshot(tok.id, e.p);
    await decide(tok.id, "POCZEKAĆ", reason, "Re-check score and filters");
    log("WAIT", tok.ticker, "-", reason.slice(0, 90));
  };

  // ---- 4) FILTER (RugCheck) + 5) ANALYST ----
  step = "filter + analyst";
  let fetched = 0;
  const passed = [];
  for (const { p, f, edge } of toRug) {
    const addr = p.baseToken.address, tk = tickerOf(p);
    const fresh = rcFresh(addr);
    if (!fresh && RUGCHECK && fetched >= MAX_RC) { tally("rugcheck", "skipped (RugCheck budget per scan)"); rec(p, "rugcheck", "killed", "skipped (RugCheck budget per scan)", f); continue; }
    const rc = await rugCheck(addr);
    if (!fresh && RUGCHECK) { fetched++; if (tick) await tick(); }
    if (rc.unavailable && RUGCHECK_STRICT) { tally("rugcheck", "RugCheck unavailable"); killLine("rugcheck", tk, rc.why); rec(p, "rugcheck", "killed", "RugCheck unavailable", f); continue; }
    const kills = rc.unavailable ? [] : rc.kills.slice();
    if (CREATOR_BAN && rc.creator && banned.has(rc.creator)) kills.push({ key: "creator banned (earlier rug)", detail: "creator banned (earlier rug)", hard: true });
    if (kills.length) {
      kills.forEach(k => tally("rugcheck", k.key));
      killLine("rugcheck", tk, kills.map(k => k.detail).join("; "));
      rec(p, "rugcheck", "killed", kills[0].key, f);
      if (kills.some(k => k.hard)) {
        const ban = kills.some(k => k.ban);
        if (ban && rc.creator) banned.add(rc.creator);
        const tok = await tokenFor(S, p);
        await decide(tok.id, "POCZEKAĆ", `KILL[rugcheck] ${kills.map(k => k.detail).join("; ")} | ${rc.note} creator:${rc.creator || "unknown"} [BLACKLIST]${ban ? " [CREATORBAN]" : ""}`);
        handled.add(addr);
      }
      continue;
    }
    const a = analyst(p, rc);
    const e = { p, rc, ...a, f, edge };
    if (a.veto.length) { a.veto.forEach(v => tally("analyst", "veto: " + v)); killLine("analyst", tk, "veto: " + a.veto.join("; ")); rec(p, "analyst", "killed", "veto: " + a.veto[0], f); continue; }
    if (a.score < MIN_SCORE) {
      tally("analyst", `score below ${MIN_SCORE}`);
      killLine("analyst", tk, `score ${a.score} (< ${MIN_SCORE})`);
      rec(p, "analyst", "killed", `score below ${MIN_SCORE}`, { ...f, score: a.score });
      if (a.score >= WATCH_MIN) await park(e, `score ${a.score}/100 below ${MIN_SCORE}, waiting. rugcheck: ${rc.note}. ${a.note}`);
      continue;
    }
    rec(p, "analyst", "passed", "score ok", { ...f, score: a.score });
    passed.push(e);
  }
  passed.sort((a, b) => b.score - a.score);
  log(`desk: analyst passed ${passed.length} (score ${MIN_SCORE}+), fresh RugCheck reports ${fetched}`);

  // ---- 6) EXECUTOR ----
  step = "executor";
  for (const e of passed) {
    const ctx = liveCtx(S, cycles, banned);
    if (ctx.freeSlots <= 0) { await park(e, `score ${e.score}/100 passed, but no free slot. ${e.note}`); continue; }
    if (pullbackOn) { addSignal(e); continue; }
    const r = await enter(S, e, ctx, `immediate (analyst score ${e.score})`);
    if (r.ok) await refresh();
    else if (r.park) await park(e, r.park);
  }
  try { await obsFlush(); } catch (e) { log("obs flush failed:", e.message); }
  killSummary();
}

// =====================================================================================
// RISK: manage open positions (every POLL_SEC)
// =====================================================================================
const mem = new Map();   // tokenId -> { key, peak, low, last, lastSnap, missSince, liqHist }
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
      m = { key, peak: Math.max(base, await peakSince(t.id, p.firstAt)), low: Math.min(base, p.entry), last: base, lastSnap: 0, missSince: 0, liqHist: [] };
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
      m.last = price; m.peak = Math.max(m.peak, price); m.low = Math.min(m.low, price);
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
      const mfe = (m.peak / p.entry - 1) * 100, mae = (Math.min(m.low, price) / p.entry - 1) * 100;
      await paperSell(t.id, t.ticker, price, p.qty, why, liq);
      const bl = o.bl || x <= BL_LOSS;
      await decide(t.id, "WYJŚĆ", `exit all (${why}) at ${x.toFixed(2)}x, peak ${peakX.toFixed(2)}x, mfe=${mfe.toFixed(1)}% mae=${mae.toFixed(1)}%${bl ? " [BLACKLIST]" : ""}${o.ban ? " [CREATORBAN]" : ""}`);
      log("EXIT", t.ticker, why, x.toFixed(4) + "x", "peak", peakX.toFixed(4) + "x", `mfe ${mfe.toFixed(1)}% mae ${mae.toFixed(1)}%`, bl ? "-> BLACKLISTED" : "");
      await notify(`EXIT ${t.ticker}: ${why} at ${x.toFixed(2)}x (peak ${peakX.toFixed(2)}x)`);
      await obsTradeClosed(t.mint_address, { ret: round((x - 1) * 100, 2), mfe: round(mfe, 2), mae: round(mae, 2), why });
      mem.delete(t.id); changed = true;
    };

    if (!havePrice) { await exitAll(`no price data for ${NOPRICE_MIN} min, pair dead`, { bl: true, ban: true }); continue; }
    if (liq < RUG_LIQ || x <= 0.2) { await exitAll(`rug pull suspected, liquidity $${Math.round(liq)}`, { bl: true, ban: true }); continue; }
    if (LIQ_DROP > 0 && liqDrop >= LIQ_DROP) {
      await exitAll(`liquidity dropped ${liqDrop.toFixed(0)}% within ${LIQ_WINDOW_MIN} min`, { bl: true, ban: liqDrop >= 50 });
      continue;
    }

    const rule = exitRule({ x, peakX, dropNow, soldFrac: p.bought > 0 ? p.sold / p.bought : 0 }, EP);
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
    if (TIME_STOP_H > 0 && ageH >= TIME_STOP_H && peakX < EP.ARM_X && p.qty > 1e-8) {
      await exitAll(`time stop: ${ageH.toFixed(1)}h without reaching +${Math.round((EP.ARM_X - 1) * 100)}%`);
      continue;
    }

    if (rule.trailPct) log("HOLD", t.ticker, x.toFixed(4) + "x", "peak", peakX.toFixed(4) + "x", `(trail ${rule.trailPct}%${rule.locked ? ", profit locked" : ""})`);
    else log("HOLD", t.ticker, x.toFixed(4) + "x", "peak", peakX.toFixed(4) + "x", `age ${ageH.toFixed(1)}h${peakX >= EP.PL_X ? ", profit lock armed" : ""}`);
  }
  return changed;
}

// =====================================================================================
// BACKTEST: replays saved price snapshots of past real entries with many exit settings
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
  log("BACKTEST", "CURRENT SETTINGS ->", f(evalP(EP)));
  log("BACKTEST", "WITHOUT profit lock ->", f(evalP({ ...EP, PL_DROP: 0 })));
  const actual = closedCycles(S);
  if (actual.length) log("BACKTEST", `ACTUAL closed trades (${actual.length}) -> total ${(actual.reduce((s, c) => s + c.ret, 0) * 100).toFixed(0)}%, avg ${(actual.reduce((s, c) => s + c.ret, 0) / actual.length * 100).toFixed(1)}%/trade`);

  const combos = gridCombos(GRID);
  const res = combos.map(c => ({ c, ...evalP({ ...EP, ...c }) })).sort((a, b) => b.sum - a.sum).slice(0, 10);
  log("BACKTEST", `TOP 10 of ${combos.length} combinations (env vars you can set):`);
  res.forEach((r, i) => log("BACKTEST", `#${i + 1} ${Object.entries(r.c).map(([k, v]) => k + "=" + v).join(" ")}  ->  ${f(r)}`));
  log("BACKTEST", "note: snapshots are ~60s apart and end at the real exit, so treat this as a rough guide, not a promise");
}

async function main() {
  if (!BOT_EMAIL || !BOT_PASSWORD) throw new Error("secret BOT_EMAIL or BOT_PASSWORD is empty");
  step = "login";
  await login();
  if (process.argv.includes("--backtest")) { await backtest(); return; }
  step = "init observations";
  try { await obsInit(); await learnInit(); } catch (e) { OBS.ok = false; log("observations/learning init failed, running without learning:", e.message); }
  const minArg = process.argv.find(a => a.startsWith("--minutes="));
  const minutes = minArg ? +minArg.split("=")[1] : 0;
  const deadline = minutes > 0 ? Date.now() + minutes * 60e3 : Infinity;
  log("bot v11.1 started (paper trading only) | mode", ONCE ? "once" : minutes ? minutes + " min loop" : "loop forever",
    `| learning ${OBS.ok && LEARN_ON ? "ON (gate " + LEARN_GATE + ", exits " + (LEARN_EXITS ? "on" : "off") + ")" : "OFF"} | mood filter ${MOOD_ON ? "on" : "off"} | profit lock ${EP.PL_DROP > 0 ? `after +${Math.round((EP.PL_X - 1) * 100)}%, ${EP.PL_DROP}% drop from peak` : "off"} | scout age ${Math.round(AGE_MIN_H * 60)}min-${AGE_MAX_H}h, mcap $${MC_MIN}-$${MC_MAX} | filter liq $${LIQ_MIN}, vol1h $${VOL1H_MIN}, top10 ${MAX_TOP10}%, dev ${MAX_DEV}%, bundled ${MAX_BUNDLED}% | analyst ${MIN_SCORE}+ | size ${MIN_TRADE_PCT * 100}-${MAX_TRADE_PCT * 100}% | stop -${Math.round((1 - EP.STOP) * 100)}%, trail after +${Math.round((EP.ARM_X - 1) * 100)}% | poll ${POLL_SEC}s | scan ${SCAN_SEC}s`);
  if (ONCE) {
    step = "load data";
    const S1 = await load();
    step = "manage positions";
    await manage(S1);
    step = "load data (scan)";
    const S2 = await load();
    step = "scan";
    await scan(S2, null, async () => { Object.assign(S2, await load()); });
    try { await obsPersist(true); await learnCycle(null); } catch (e) { log("learning step failed:", e.message); }
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
  let S = null, lastLoad = 0, lastScan = 0, lastTick = 0, lastFollow = 0, lastPersist = Date.now(), lastLearn = 0;
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
  const safe = async (label, fn) => { try { await fn(); } catch (e) { await onErr(label + " error:", e); } };
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
    } catch (e) { await onErr("cycle error:", e); }
    // learning jobs run separately, so a failure here never stops trading
    if (OBS.ok && Date.now() - lastFollow > FOLLOW_SEC * 1000 && Date.now() < deadline - 90e3) { lastFollow = Date.now(); await safe("follow", () => obsFollow(tick)); }
    if (OBS.ok && Date.now() - lastPersist > PERSIST_SEC * 1000) { lastPersist = Date.now(); await safe("persist", () => obsPersist(true)); }
    if (OBS.ok && LEARN_ON && Date.now() - lastLearn > LEARN_SEC * 1000 && Date.now() < deadline - 120e3) { lastLearn = Date.now(); beat = Date.now(); await safe("learn", () => learnCycle(tick)); }
    try {
      const d = new Date(), day = d.toISOString().slice(0, 10);
      if (S && d.getUTCHours() >= REPORT_HOUR && lastReportDay !== day) { await report(S); lastReportDay = day; }
    } catch (e) { await onErr("report error:", e); }
    await sleep(Math.max(0, Math.min(POLL_SEC * 1000, deadline - Date.now())));
  }
  await safe("final persist", () => obsPersist(true));
  log("time window finished, exiting (open positions stay in the database and are picked up by the next run)");
}
main().catch(e => {
  console.log("::error::[" + step + "] " + String(e?.message || e).replace(/\s+/g, " "));
  process.exit(1);
});
