// MemeLab AI — paper trading bot v12 (NO real money, NO wallet, NO private keys)
// Clean rewrite built around YOUR rules:
//   ENTRY : rug/fake filters -> risk score 0-100 -> learned win-probability gate -> position size by risk
//   EXIT  : stop at -20% | after +10% keep holding while it rises, sell all on a 4.5% fall from the peak
//           | rug exits (liquidity drop / dead pair) | time stop for coins that go nowhere
//   LEARN : follows every coin that passed the filters, simulates your exit rules on it, learns P(win) from those
//           and from the bot's own real trades (its mistakes weigh 3x). Once a model is validated on newer data it
//           trades only coins with P(win) >= WIN_TARGET (0.75). Before that: explore mode (safest coins).
// Needs the Supabase tables bot_observations and bot_learning (same SQL as before). Without them: explore mode only.
// Run:  npm i @supabase/supabase-js
//   node Bot.mjs --minutes=345   loop for N minutes (GitHub Actions, 24/7)
//   node Bot.mjs                 loop forever
//   node Bot.mjs --once          single pass
//   node Bot.mjs --selftest      offline self test (no network, no database)
import { createClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_URL || "https://wduflmaakgoemxsegnbp.supabase.co";
const KEY = process.env.SUPABASE_KEY || "sb_publishable_muU19iaA6GTGNIvX6orqDg_ZO-50q5e";
const { BOT_EMAIL, BOT_PASSWORD } = process.env;
const WEBHOOK = process.env.DISCORD_WEBHOOK || "";
const ONCE = process.argv.includes("--once");
const SELFTEST = process.argv.includes("--selftest");

// ================= SETTINGS (change freely, or override with env vars) =================
const num = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" ? +process.env[k] : d);
const str = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" ? String(process.env[k]) : d);

// -- YOUR EXIT RULES --
const STOP = num("STOP", 0.80);                   // hard stop: sell all at -20% from the entry price
const ARM_X = num("ARM_X", 1.10);                 // once the price has been +10% above entry...
const TRAIL_DROP = num("TRAIL_DROP", 4.5);        // ...keep holding while it rises, sell all on this % fall from the peak
const TIME_STOP_H = num("TIME_STOP_H", 24);       // coin that never reached +10% after this many hours is closed (0 = off)
// -- rug exits (always on) --
const RUG_LIQ = num("RUG_LIQ", 2500);             // liquidity under this on an open position = rug
const LIQ_DROP = num("LIQ_DROP", 30);             // liquidity fell this % within LIQ_WINDOW_MIN = rug (0 = off)
const LIQ_WINDOW_MIN = num("LIQ_WINDOW_MIN", 10);
const NOPRICE_MIN = num("NOPRICE_MIN", 3);        // no price for this many minutes = dead pair
const NOPRICE_RECOVERY = num("NOPRICE_RECOVERY", 0.05);   // simulated sell price of a dead pair = last price x this
const POLL_SEC = num("POLL_SEC", 20);             // how often open positions are checked
const SNAP_SEC = num("SNAP_SEC", 60);             // how often a price snapshot of an open position is saved

// -- POSITION SIZE: by risk bands, linear inside every band --
//    risk 0-15  -> $300 down to $150
//    risk 16-35 -> $100 down to $60
//    risk 36-65 -> $50 down to $40
//    risk 66+   -> $30 down to $10 (max $30)
const SIZE_PTS = [[0, 300], [15, 150], [16, 100], [35, 60], [36, 50], [65, 40], [66, 30], [100, 10]];   // [risk, USD]
const RISK_CUT = num("RISK_CUT", 85);             // risk above this = never buy
const MIN_USD = num("MIN_USD", 10);
const MAX_POS_PCT = num("MAX_POS_PCT", 0.35);     // one position never exceeds this share of CURRENT equity (cash + open positions), so it grows and shrinks with the account
const MAX_EXPOSURE = num("MAX_EXPOSURE", 0.60);   // all positions together never exceed this share of equity
const MAX_LIQ_PCT = num("MAX_LIQ_PCT", 0.02);     // one position never exceeds this share of the token's liquidity
const MAX_OPEN = num("MAX_OPEN", 10);

// -- SCOUT --
const SCAN_SEC = num("SCAN_SEC", 300);
const MAX_CAND = num("MAX_CAND", 300);
const GECKO = num("GECKO", 1);
const SEARCH_ON = num("SEARCH_ON", 1);
const SEARCH_QUERIES = str("SEARCH_QUERIES", "pump,pumpswap,raydium,meme,ai,cat,dog,pepe,trump,sol").split(",").map(s => s.trim()).filter(Boolean);
const AGE_MIN_H = num("AGE_MIN_H", 0.5), AGE_MAX_H = num("AGE_MAX_H", 72);
const MC_MIN = num("MC_MIN", 300000), MC_MAX = num("MC_MAX", 20000000);

// -- FILTERS (DexScreener data) --
const LIQ_MIN = num("LIQ_MIN", 40000);
const VOL1H_MIN = num("VOL1H_MIN", 50000);
const TRADES_MIN = num("TRADES_MIN", 30);         // min buys+sells in 1h
const LIQ_MC_MIN = num("LIQ_MC_MIN", 0.03);       // liquidity under this share of market cap = thin, easy to rug
const CH1_MAX = num("CH1_MAX", 80);               // already pumped this % in 1h
const CH5_MAX = num("CH5_MAX", 25);               // 5 minute spike
const TURNOVER_MAX = num("TURNOVER_MAX", 25);     // 1h volume / liquidity above this = wash trading
const BUY_SHARE_MAX = num("BUY_SHARE_MAX", 0.95); // almost only buys (with many trades) = fake demand
const MOM_M5_MIN = num("MOM_M5_MIN", 0);          // 5m change must be at least this %; 1h change must be positive

// -- FILTERS (RugCheck + fake coin check) --
const RUGCHECK = num("RUGCHECK", 1);
const RUGCHECK_STRICT = num("RUGCHECK_STRICT", 1);   // 1 = if RugCheck is unreachable do NOT enter
const MAX_RC = num("MAX_RC", 25);                 // max fresh RugCheck reports per scan
const LP_LOCK_MIN = num("LP_LOCK_MIN", 70);       // % of LP that must be burned or locked
const LP_STRICT = num("LP_STRICT", 0);            // 1 = kill when RugCheck gives no LP data
const MAX_TOP10 = num("MAX_TOP10", 25);
const MAX_DEV = num("MAX_DEV", 3);
const MAX_BUNDLED = num("MAX_BUNDLED", 10);
const MAX_TRANSFER_FEE = num("MAX_TRANSFER_FEE", 1);
const CREATOR_BAN = num("CREATOR_BAN", 1);
const FAKE_CHECK = num("FAKE_CHECK", 1);          // 1 = kill coins that copy the symbol of an older, bigger token
const RC_DEBUG = num("RC_DEBUG", 1);

// -- LEARNING --
const GATE_MODE = str("GATE_MODE", "explore").toLowerCase();   // explore | strict | off
const WIN_TARGET = num("WIN_TARGET", 0.75);       // wanted win rate: the model must reach it on newer data
const GATE_TOL = num("GATE_TOL", 0.05);           // validation passes at WIN_TARGET minus this
const GATE_MIN_N = num("GATE_MIN_N", 12);         // min accepted coins in the validation set
const EXPLORE_MAX_RISK = num("EXPLORE_MAX_RISK", 40);   // explore mode: only coins up to this risk...
const EXPLORE_SIZE_MULT = num("EXPLORE_SIZE_MULT", 1);  // ...with this share of the normal size (1 = full size from the risk curve)
const LEARN_ON = num("LEARN", 1);
const LEARN_SEC = num("LEARN_SEC", 1800);
const LEARN_DAYS = num("LEARN_DAYS", 14);
const LEARN_MIN = num("LEARN_MIN", 100);          // examples needed before a model is built
const REAL_W = num("REAL_W", 3);                  // weight of the bot's own real trades (its mistakes) in the learning
const LOGIT_ITERS = num("LOGIT_ITERS", 300);
// -- OBSERVATIONS (coins that passed the filters are saved and followed) --
const OBS_ON = num("OBS_ON", 1);
const HORIZON_H = num("HORIZON_H", 6);
const FOLLOW_SEC = num("FOLLOW_SEC", 180);
const PERSIST_SEC = num("PERSIST_SEC", 900);
const OBS_DEDUPE_H = num("OBS_DEDUPE_H", 6);
const OBS_MAX_PER_SCAN = num("OBS_MAX_PER_SCAN", 300);
const MAX_FOLLOW = num("MAX_FOLLOW", 400);
const MISSING_N = num("MISSING_N", 3);

// -- protection against repeating mistakes --
const LOSS_BAN_H = num("LOSS_BAN_H", 168);        // a token closed at a loss is not bought again for this many hours
const PAUSE_LOSSES = num("PAUSE_LOSSES", 4);      // after this many losing trades in a row...
const PAUSE_MIN = num("PAUSE_MIN", 30);           // ...no new entries for this many minutes after the last loss
const COOLDOWN_MIN = num("COOLDOWN_MIN", 30);
const COOLDOWN_STOP_MIN = num("COOLDOWN_STOP_MIN", 60);
const BL_LOSS = num("BL_LOSS", 0.40);             // closed at or below this x entry = token blacklisted

// -- costs of the simulation, report, 24/7 --
const FEE = num("FEE", 0.005), SLIP = num("SLIP", 0.015);
const REPORT_HOUR = num("REPORT_HOUR", 21);
const HTTP_TIMEOUT_MS = num("HTTP_TIMEOUT_MS", 15000);
const WATCHDOG_MIN = num("WATCHDOG_MIN", 10);
// ========================================================================================

const RULES = { STOP, ARM_X, TRAIL_DROP, TIME_STOP_H };
const C = FEE + SLIP;                              // one-way cost used by the learner (the live bot adds size impact)

// ---------------------------------------------------------------- helpers
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const fmt1 = v => (v === null || v === undefined || !isFinite(v) ? "n/a" : (+v).toFixed(1));
const pc = v => (v === null || v === undefined || !isFinite(v) ? "n/a" : (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%");
const tickerOf = p => (p.baseToken?.symbol || "?").toUpperCase();
const slipRate = (usd, liq) => clamp(SLIP + (liq > 0 ? usd / liq : 0.1), SLIP, 0.20);
let step = "start";
let USER = null;
let pace = async () => {};                         // called between slow requests, runs the position check when it is due
process.on("unhandledRejection", e => log("unhandled rejection:", String(e?.message || e)));

let db;
try {
  db = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: true } });
} catch (e) {
  console.log("::error::[createClient] " + String(e?.message || e).replace(/\s+/g, " "));
  process.exit(1);
}
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
async function pairsFor(addrs) {
  const out = [];
  for (let i = 0; i < addrs.length; i += 30) {
    const j = await api(`https://api.dexscreener.com/tokens/v1/solana/${addrs.slice(i, i + 30).join(",")}`);
    if (Array.isArray(j)) out.push(...j);
    if (i + 30 < addrs.length) { await sleep(1100); await pace(); }
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

// ---------------------------------------------------------------- log of kills (why coins were rejected)
const killCount = {};
const tally = (stage, reason) => { const k = stage + "|" + reason; killCount[k] = (killCount[k] || 0) + 1; };
function killSummary() {
  const by = {};
  for (const [k, n] of Object.entries(killCount)) { const [stage, ...r] = k.split("|"); (by[stage] = by[stage] || []).push([r.join("|"), n]); }
  for (const stage of ["filter", "rugcheck", "fake", "risk", "gate"]) {
    if (!by[stage]) continue;
    const list = by[stage].sort((a, b) => b[1] - a[1]);
    log("KILLS", stage, `${list.reduce((s, [, n]) => s + n, 0)} total:`, list.slice(0, 6).map(([r, n]) => `${r} (${n})`).join("; "));
  }
  for (const k of Object.keys(killCount)) delete killCount[k];
}

// ================================================================ SCOUT: where the coins come from
const STABLE = new Set(["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);
const GECKO_URLS = [
  ["gecko-new", "https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1"],
  ["gecko-new", "https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=2"],
  ["gecko-trending", "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=1h"],
  ["gecko-volume", "https://api.geckoterminal.com/api/v2/networks/solana/pools?page=1&sort=h24_volume_usd_desc"],
  ["gecko-volume", "https://api.geckoterminal.com/api/v2/networks/solana/pools?page=2&sort=h24_volume_usd_desc"],
];
const srcOf = new Map();                           // mint -> source that found it first
async function discover() {
  const set = new Set();
  const add = (a, tag) => { if (typeof a === "string" && a && !STABLE.has(a)) { set.add(a); if (!srcOf.has(a)) srcOf.set(a, tag); } };
  const run = async (label, fn, gap) => {
    const before = set.size;
    try { await fn(); } catch (e) { log(`discover ${label} failed:`, e.message); }
    log(`discover ${label}: +${set.size - before}`);
    await sleep(gap); await pace();
  };
  for (const [path, tag] of [["token-profiles/latest/v1", "dex-profiles"], ["token-boosts/latest/v1", "dex-boosts"], ["token-boosts/top/v1", "dex-top"], ["community-takeovers/latest/v1", "dex-community"], ["ads/latest/v1", "dex-ads"]]) {
    await run("dex " + path.split("/")[0], async () => {
      const j = await api("https://api.dexscreener.com/" + path);
      (Array.isArray(j) ? j : []).forEach(x => x?.chainId === "solana" && add(x.tokenAddress, tag));
    }, 1100);
  }
  if (SEARCH_ON) for (const q of SEARCH_QUERIES) {
    await run("search " + q, async () => {
      const j = await api("https://api.dexscreener.com/latest/dex/search?q=" + encodeURIComponent(q));
      (j?.pairs || []).forEach(p => p?.chainId === "solana" && add(p.baseToken?.address, "search"));
    }, 450);
  }
  if (GECKO) for (const [tag, u] of GECKO_URLS) {
    await run("gecko " + u.split("/").pop().split("?")[0], async () => {
      const j = await api(u);
      (j?.data || []).forEach(d => {
        const id = d?.relationships?.base_token?.data?.id;
        if (typeof id === "string" && id.startsWith("solana_")) add(id.slice(7), tag);
      });
    }, 2200);
  }
  log(`discover: ${set.size} unique tokens from all sources`);
  return [...set];
}

// ================================================================ FILTERS (DexScreener data)
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
function filterKills(p) {
  const r = [];
  const liq = p.liquidity?.usd || 0, vol1 = p.volume?.h1 || 0, mc = p.marketCap || p.fdv || 0;
  const b1 = p.txns?.h1?.buys || 0, s1 = p.txns?.h1?.sells || 0;
  const ch1 = p.priceChange?.h1, ch5 = p.priceChange?.m5;
  if (liq < LIQ_MIN) r.push(`liquidity under $${LIQ_MIN}`);
  if (vol1 < VOL1H_MIN) r.push(`1h volume under $${VOL1H_MIN}`);
  if (b1 + s1 < TRADES_MIN) r.push(`under ${TRADES_MIN} trades in 1h`);
  if (mc && liq / mc < LIQ_MC_MIN) r.push(`liquidity under ${LIQ_MC_MIN * 100}% of market cap (thin)`);
  if (liq > 0 && vol1 / liq > TURNOVER_MAX) r.push(`1h volume over ${TURNOVER_MAX}x liquidity (wash trading?)`);
  if (b1 + s1 >= 100 && b1 / (b1 + s1) > BUY_SHARE_MAX) r.push("almost only buys (fake demand?)");
  if (typeof ch1 === "number" && ch1 > CH1_MAX) r.push(`already +${CH1_MAX}% in 1h`);
  if (typeof ch5 === "number" && ch5 > CH5_MAX) r.push(`5m spike over +${CH5_MAX}%`);
  if (typeof ch5 !== "number") r.push("no 5m data");
  else if (ch5 < MOM_M5_MIN) r.push(`5m change below ${MOM_M5_MIN}%`);
  if (!(ch1 > 0)) r.push("1h change not positive");
  return r;
}

// market mood: median 1h change and share of rising coins among the active coins of a scan (a learning feature)
let MOOD = { median: 0, breadth: 0.5, n: 0 };
function computeMood(pairs) {
  const act = pairs.filter(p => (p.liquidity?.usd || 0) >= 10000 && ((p.txns?.h1?.buys || 0) + (p.txns?.h1?.sells || 0)) >= 20 && typeof p.priceChange?.h1 === "number");
  if (!act.length) return { median: 0, breadth: 0.5, n: 0 };
  const ch = act.map(p => p.priceChange.h1).sort((a, b) => a - b);
  const med = ch.length % 2 ? ch[(ch.length - 1) / 2] : (ch[ch.length / 2 - 1] + ch[ch.length / 2]) / 2;
  return { median: med, breadth: ch.filter(v => v > 0).length / ch.length, n: ch.length };
}

// ================================================================ FILTERS (RugCheck: rug pull and honeypot protection)
const rcCache = new Map();
let rcDebugged = false;
const rcFresh = m => { const h = rcCache.get(m); return !!h && Date.now() - h.t < h.ttl; };
function collectStrings(o, set, depth = 0) {
  if (depth > 3 || o === null || o === undefined) return;
  if (typeof o === "string") { if (o.length >= 32) set.add(o); return; }
  if (Array.isArray(o)) { o.forEach(x => collectStrings(x, set, depth + 1)); return; }
  if (typeof o === "object") Object.values(o).forEach(x => collectStrings(x, set, depth + 1));
}
const NO_METRICS = { top10: null, dev: null, bundled: null, lp: null, holders: 0, creatorTokens: null };
async function rugCheck(mint) {
  if (!RUGCHECK) return { unavailable: false, creator: null, kills: [], m: NO_METRICS, note: "rugcheck off" };
  if (rcFresh(mint)) return rcCache.get(mint).res;
  let res, ttl = 30 * 60e3;
  try {
    const j = await api(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`);
    if (RC_DEBUG && !rcDebugged) {
      rcDebugged = true;
      const lp = (j?.markets || []).find(x => x?.lp)?.lp;
      log("RUGCHECK fields:", Object.keys(j || {}).join(","), "| lp fields:", lp ? Object.keys(lp).join(",") : "none");
    }
    const creator = typeof j?.creator === "string" && j.creator ? j.creator : null;
    const risks = Array.isArray(j?.risks) ? j.risks : [];
    const rn = risks.map(r => String(r?.name || ""));
    const kills = [];                              // hard = structural (remember 24h), ban = rug/scam (blacklist + ban the creator)
    if (!!(j?.mintAuthority || j?.token?.mintAuthority) || rn.some(n => /mint authority/i.test(n))) kills.push({ key: "mint authority not revoked", detail: "mint authority still enabled", hard: true });
    if (!!(j?.freezeAuthority || j?.token?.freezeAuthority) || rn.some(n => /freeze authority/i.test(n))) kills.push({ key: "freeze authority not revoked", detail: "freeze authority still enabled", hard: true });
    if (j?.rugged === true) kills.push({ key: "marked as rugged", detail: "marked as rugged", hard: true, ban: true });
    if (rn.some(n => /honeypot/i.test(n))) kills.push({ key: "honeypot", detail: "honeypot risk", hard: true, ban: true });
    const otherDanger = risks.filter(r => r?.level === "danger" && !/mint authority|freeze authority|honeypot|holder|liquidity|lp/i.test(String(r?.name || "")));
    if (otherDanger.length) kills.push({ key: "RugCheck danger risk", detail: otherDanger.map(r => r.name).join(", "), hard: true });
    const prev = Array.isArray(j?.creatorTokens) ? j.creatorTokens : null;
    if (prev && prev.some(t => t?.rugged === true || /rug/i.test(String(t?.status || "")))) kills.push({ key: "creator has past rugs", detail: "creator has past rugged tokens", hard: true, ban: true });
    const tf = +j?.transferFee?.pct;
    if (isFinite(tf) && tf > MAX_TRANSFER_FEE) kills.push({ key: "transfer fee on token", detail: `transfer fee ${tf}%`, hard: true });

    const markets = Array.isArray(j?.markets) ? j.markets : [];
    const lpVals = markets.map(x => x?.lp?.lpLockedPct).filter(v => typeof v === "number" && isFinite(v));
    const lp = lpVals.length ? Math.max(...lpVals) : null;
    if (lp !== null && lp < LP_LOCK_MIN) kills.push({ key: `LP burned/locked under ${LP_LOCK_MIN}%`, detail: `LP burned/locked only ${lp.toFixed(0)}%` });
    else if (lp === null && LP_STRICT) kills.push({ key: "LP lock data missing", detail: "no LP lock data" });

    const pool = new Set();
    collectStrings(markets, pool);
    const th = (Array.isArray(j?.topHolders) ? j.topHolders : []).filter(h => !pool.has(h?.address) && !pool.has(h?.owner));
    let top10 = null, dev = null, bundled = null;
    if (th.length) {
      top10 = th.slice().sort((a, b) => (+b?.pct || 0) - (+a?.pct || 0)).slice(0, 10).reduce((s, h) => s + (+h?.pct || 0), 0);
      bundled = th.filter(h => h?.insider === true).reduce((s, h) => s + (+h?.pct || 0), 0);
      if (creator) { const ch = th.find(h => h?.address === creator || h?.owner === creator); dev = ch ? (+ch.pct || 0) : null; }
    }
    if (dev === null && creator) {
      const bal = +j?.creatorBalance, sup = +j?.token?.supply;
      if (isFinite(bal) && isFinite(sup) && sup > 0) dev = bal / sup * 100; else if (th.length) dev = 0;
    }
    if (top10 !== null && top10 > MAX_TOP10) kills.push({ key: `top 10 holders over ${MAX_TOP10}%`, detail: `top 10 holders ${top10.toFixed(1)}%` });
    if (dev !== null && dev > MAX_DEV) kills.push({ key: `dev holds over ${MAX_DEV}%`, detail: `dev holds ${dev.toFixed(1)}%` });
    if (bundled !== null && bundled > MAX_BUNDLED) kills.push({ key: `bundled/insider holders over ${MAX_BUNDLED}%`, detail: `bundled/insiders ${bundled.toFixed(1)}%` });

    const holders = +j?.totalHolders || 0;
    const m = { top10, dev, bundled, lp, holders, creatorTokens: prev ? prev.length : null };
    res = { unavailable: false, creator, kills, m, note: `top10 ${fmt1(top10)}%, dev ${fmt1(dev)}%, bundled ${fmt1(bundled)}%, LP ${lp === null ? "n/a" : lp.toFixed(0) + "%"}, holders ${holders || "n/a"}${rn.length ? ", warnings: " + rn.slice(0, 4).join("; ") : ""}` };
  } catch (e) {
    ttl = 2 * 60e3;
    res = { unavailable: true, creator: null, kills: [], m: NO_METRICS, note: "RugCheck unavailable (" + e.message + ")" };
  }
  await sleep(600);
  rcCache.set(mint, { t: Date.now(), ttl, res });
  return res;
}

// fake coin check: a coin that copies the symbol of an OLDER token with much more liquidity is probably an impersonation
const symCache = new Map();
async function impersonation(p) {
  const sym = String(p.baseToken?.symbol || "").trim();
  if (!sym) return { kill: null, same: 0 };
  const key = sym.toUpperCase();
  let hit = symCache.get(key);
  if (!hit || Date.now() - hit.t > 6 * 36e5) {
    let list = null;
    try {
      const j = await api("https://api.dexscreener.com/latest/dex/search?q=" + encodeURIComponent(sym));
      list = (j?.pairs || []).filter(x => x?.chainId === "solana" && String(x.baseToken?.symbol || "").toUpperCase() === key)
        .map(x => ({ addr: x.baseToken.address, liq: x.liquidity?.usd || 0, created: x.pairCreatedAt || 0 }));
    } catch { list = null; }
    hit = { t: Date.now(), list };
    symCache.set(key, hit);
    await sleep(450);
  }
  if (!hit.list) return { kill: null, same: 0 };                // search failed: do not guess
  const me = p.baseToken.address, mine = p.liquidity?.usd || 0, myCreated = p.pairCreatedAt || 0;
  const others = hit.list.filter(o => o.addr !== me);
  const older = others.filter(o => o.liq >= Math.max(mine * 3, 100000) && o.created && myCreated && o.created < myCreated);
  if (older.length) return { kill: `symbol ${sym} is also used by an older token with $${Math.round(Math.max(...older.map(o => o.liq)))} liquidity (copy?)`, same: others.length };
  return { kill: null, same: others.filter(o => o.liq >= 20000).length };
}

// ================================================================ RISK SCORE 0-100 (lower = safer) and position size
const RISK_MAX_SUM = 108;
function riskScore(p, rc, same) {
  const liq = p.liquidity?.usd || 0, mc = p.marketCap || p.fdv || 0, vol1 = p.volume?.h1 || 0;
  const age = (Date.now() - (p.pairCreatedAt || Date.now())) / 36e5;
  const b1 = p.txns?.h1?.buys || 0, s1 = p.txns?.h1?.sells || 0;
  const ch1 = Math.abs(p.priceChange?.h1 || 0);
  const m = rc?.m || NO_METRICS;
  const lm = mc ? liq / mc : 0, turn = liq ? vol1 / liq : 0, sellShare = b1 + s1 ? s1 / (b1 + s1) : 0.5;
  const parts = {
    liquidity: liq < 80e3 ? 10 : liq < 150e3 ? 6 : liq < 300e3 ? 3 : 0,
    liqmc: lm < 0.06 ? 8 : lm < 0.10 ? 4 : 0,
    lp: m.lp === null ? 8 : m.lp >= 99 ? 0 : m.lp >= 90 ? 3 : 8,
    top10: m.top10 === null ? 6 : clamp(m.top10 / MAX_TOP10, 0, 1) * 10,
    dev: m.dev === null ? 3 : clamp(m.dev / MAX_DEV, 0, 1) * 6,
    bundled: m.bundled === null ? 4 : clamp(m.bundled / MAX_BUNDLED, 0, 1) * 8,
    holders: !m.holders ? 4 : m.holders < 100 ? 8 : m.holders < 300 ? 5 : m.holders < 1000 ? 2 : 0,
    age: age < 1 ? 8 : age < 3 ? 5 : age < 12 ? 2 : 0,
    swings: clamp(ch1 / CH1_MAX, 0, 1) * 6,
    turnover: turn > 15 ? 6 : turn > 8 ? 3 : 0,
    sells: sellShare > 0.55 ? 4 : 0,
    socials: (p.info?.socials?.length || p.info?.websites?.length) ? 0 : 4,
    creator: m.creatorTokens === null ? 2 : m.creatorTokens > 3 ? 6 : m.creatorTokens > 1 ? 3 : 0,
    mcap: mc < 500e3 ? 6 : mc < 1e6 ? 3 : 0,
  };
  if (same >= 3) parts.socials += 2;               // many lookalike symbols around
  const sum = Object.values(parts).reduce((s, v) => s + v, 0);
  return { risk: clamp(Math.round(sum / RISK_MAX_SUM * 100), 0, 100), parts };
}
function sizeUsd(risk) {                            // size by risk bands (SIZE_PTS), linear inside a band, never below MIN_USD
  const r = clamp(risk, 0, 100);
  let raw = SIZE_PTS[SIZE_PTS.length - 1][1];
  for (let i = 0; i < SIZE_PTS.length - 1; i++) {
    const [r1, v1] = SIZE_PTS[i], [r2, v2] = SIZE_PTS[i + 1];
    if (r >= r1 && r <= r2) { raw = v1 + (v2 - v1) * (r - r1) / (r2 - r1); break; }
  }
  return clamp(raw, MIN_USD, SIZE_PTS[0][1]);
}
function sizeFor(risk, liq, ctx, mult) {            // ctx.equity = CURRENT cash + open positions, so the % cap follows the account
  let usd = sizeUsd(risk) * mult;
  usd = Math.min(usd, ctx.equity * MAX_POS_PCT, liq * MAX_LIQ_PCT, ctx.equity * MAX_EXPOSURE - ctx.invested, ctx.cash);
  usd = Math.floor(usd * 100) / 100;
  return usd >= MIN_USD ? usd : 0;
}

// ================================================================ EXIT RULE (one function: live bot AND the learner)
function exitCheck(x, peakX, ageH, P = RULES) {
  if (x <= P.STOP) return `stop-loss at ${round((x - 1) * 100, 1)}%`;
  if (peakX >= P.ARM_X && x <= peakX * (1 - P.TRAIL_DROP / 100)) return `profit trail ${P.TRAIL_DROP}% below peak ${peakX.toFixed(3)}x`;
  if (P.TIME_STOP_H > 0 && ageH >= P.TIME_STOP_H && peakX < P.ARM_X) return `time stop ${ageH.toFixed(1)}h`;
  return null;
}
function simPath(path, P = RULES) {                // path = [[minutes, % change], ...] starting at [0, 0]; returns the net return
  let peakX = 1, exitX = null;
  for (let i = 1; i < path.length; i++) {
    const x = Math.max(0.0001, 1 + (+path[i][1]) / 100);
    peakX = Math.max(peakX, x);
    if (exitCheck(x, peakX, (+path[i][0]) / 60, P) || (+path[i][1]) <= -90) { exitX = x; break; }
  }
  if (exitX === null) exitX = Math.max(0.0001, 1 + (+path[path.length - 1][1]) / 100);
  return exitX * (1 - C) * (1 - C) - 1;
}

// ================================================================ DATABASE
async function must(q) { const r = await q; if (r.error) throw new Error(r.error.message); return r.data; }
const now = () => new Date().toISOString();
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
  const [tokens, trades, decisions, ledger] = await Promise.all([fetchAll("tokens", "id"), fetchAll("paper_trades", "executed_at"), fetchAll("token_decisions", "created_at"), fetchAll("portfolio_ledger", "created_at")]);
  return { tokens, trades, decisions, ledger };
}
async function peakSince(tokenId, since) {
  const r = await db.from("token_snapshots").select("price").eq("user_id", USER).eq("token_id", tokenId).gte("observed_at", since.toISOString()).order("price", { ascending: false }).limit(1);
  if (r.error) throw new Error("token_snapshots: " + r.error.message);
  return r.data?.[0] ? +r.data[0].price : 0;
}
const legacy = r => r.event_type === "INITIAL_CAPITAL" || (r.event_type === "DEPOSIT" && r.description === "PIERWSZY_PRZELEW_PAPER_TRADING");
const cash = S => S.ledger.reduce((s, r) => {
  if (legacy(r)) return s;
  const a = Math.abs(+r.amount_usd || 0);
  return ["DEPOSIT", "TRADE_SELL"].includes(r.event_type) ? s + a : ["TRADE_BUY", "WITHDRAWAL"].includes(r.event_type) ? s - a : s;
}, 0);

let _posKey = null, _posVal = null;
function positions(S) {                             // open positions, rebuilt from the trade list
  if (_posKey === S.trades && _posVal) return _posVal;
  const m = {};
  for (const t of S.trades.slice().sort((a, b) => new Date(a.executed_at) - new Date(b.executed_at))) {
    const p = m[t.token_id] || (m[t.token_id] = { qty: 0, entry: 0, firstAt: null, cost: 0 });
    const q = +t.quantity;
    if (t.side === "BUY") {
      if (p.qty <= 1e-8) { p.firstAt = new Date(t.executed_at); p.entry = +t.price; p.cost = 0; }
      p.qty += q; p.cost += +t.price * q + (+t.fee || 0) + (+t.slippage || 0);
    } else p.qty = Math.max(0, p.qty - q);
  }
  _posKey = S.trades; _posVal = m;
  return m;
}
const openOf = pos => Object.entries(pos).filter(([, p]) => p.qty > 1e-8);
function liveCtx(S) {
  const open = openOf(positions(S));
  const invested = open.reduce((s, [, p]) => s + p.cost, 0), c = cash(S);
  return { equity: c + invested, invested, cash: c, freeSlots: MAX_OPEN - open.length };
}

let _cycKey = null, _cycVal = null;
function cyc(S) {                                   // closed trades (a buy followed by a full sell)
  if (_cycKey === S.trades && _cycVal) return _cycVal;
  const by = {};
  for (const t of S.trades.slice().sort((a, b) => new Date(a.executed_at) - new Date(b.executed_at))) (by[t.token_id] || (by[t.token_id] = [])).push(t);
  const out = [];
  for (const [tid, list] of Object.entries(by)) {
    let cur = null, qty = 0;
    for (const t of list) {
      const q = +t.quantity, gross = +t.price * q, fee = +t.fee || 0, slip = +t.slippage || 0;
      if (t.side === "BUY") { if (!cur) cur = { tid, at: new Date(t.executed_at), cost: 0, proceeds: 0 }; cur.cost += gross + fee + slip; qty += q; }
      else if (cur) {
        cur.proceeds += gross - fee - slip; qty -= q;
        if (qty <= 1e-8) { cur.closedAt = new Date(t.executed_at); cur.pnl = cur.proceeds - cur.cost; cur.ret = cur.cost > 0 ? cur.proceeds / cur.cost - 1 : 0; out.push(cur); cur = null; qty = 0; }
      }
    }
  }
  _cycKey = S.trades; _cycVal = out;
  return out;
}
function summarize(list) {
  const w = list.filter(c => c.pnl > 0), l = list.filter(c => c.pnl <= 0);
  const avgW = w.length ? w.reduce((s, c) => s + c.ret, 0) / w.length : 0;
  const avgL = l.length ? -l.reduce((s, c) => s + c.ret, 0) / l.length : 0;
  return { n: list.length, wins: w.length, win: list.length ? w.length / list.length : null, avgW, avgL, be: avgW + avgL > 0 ? avgL / (avgW + avgL) : null, pnl: list.reduce((s, c) => s + c.pnl, 0) };
}

async function paperBuy(tokenId, ticker, price, usd, liq) {
  const fee = usd * FEE, slip = usd * slipRate(usd, liq), qty = (usd - fee - slip) / price;
  await must(db.from("paper_trades").insert({ user_id: USER, token_id: tokenId, side: "BUY", price, quantity: qty, fee, slippage: slip, executed_at: now() }));
  await must(db.from("portfolio_ledger").insert({ user_id: USER, event_type: "TRADE_BUY", amount_usd: usd, description: `[BOT] BUY ${ticker} @ ${price} ($${usd.toFixed(2)})`, created_at: now() }));
}
async function paperSell(tokenId, ticker, price, qty, why, liq) {
  const gross = price * qty, fee = gross * FEE, slip = gross * slipRate(gross, liq), net = gross - fee - slip;
  await must(db.from("paper_trades").insert({ user_id: USER, token_id: tokenId, side: "SELL", price, quantity: qty, fee, slippage: slip, executed_at: now() }));
  await must(db.from("portfolio_ledger").insert({ user_id: USER, event_type: "TRADE_SELL", amount_usd: net, description: `[BOT] SELL ${ticker}: ${why}`, created_at: now() }));
  return net;
}
async function snapshot(tokenId, p) {
  await must(db.from("token_snapshots").insert({ user_id: USER, token_id: tokenId, price: +p.priceUsd, market_cap: p.marketCap || p.fdv || 0, liquidity: p.liquidity?.usd || 0, volume_24h: p.volume?.h24 || 0, holders: 0, observed_at: now() }));
}
async function decide(tokenId, decision, reason, trigger, risk) {
  await must(db.from("token_decisions").insert({ user_id: USER, token_id: tokenId, decision, reason: "[BOT] " + reason, trigger_condition: trigger || "", risk_notes: risk || "", created_at: now() }));
  await must(db.from("tokens").update({ status: decision }).eq("id", tokenId).eq("user_id", USER));
}
async function tokenFor(S, p) {
  const known = S.tokens.find(t => t.mint_address === p.baseToken.address);
  if (known) return known;
  const t = await must(db.from("tokens").insert({ user_id: USER, mint_address: p.baseToken.address, name: p.baseToken.name || p.baseToken.symbol, ticker: tickerOf(p), status: "ANALIZUJE" }).select().single());
  S.tokens.push(t);
  return t;
}

// ---- blacklists, creator ban, loss ban, cooldown, pause (everything is derived from the database) ----
function buildBans(S) {
  const blTok = new Set(), banTok = new Set(), lastExit = new Map(), creatorOf = new Map(), creators = new Set();
  for (const d of S.decisions) {
    const r = d.reason || "";
    if (/BLACKLIST/.test(r)) blTok.add(d.token_id);
    if (/\[CREATORBAN\]/.test(r)) banTok.add(d.token_id);
    const m = r.match(/creator:([1-9A-HJ-NP-Za-km-z]{32,44})/);
    if (m) creatorOf.set(d.token_id, m[1]);
    if (d.decision === "WYJŚĆ") { const t = +new Date(d.created_at), cur = lastExit.get(d.token_id); if (!cur || t > cur.t) lastExit.set(d.token_id, { t, reason: r }); }
  }
  if (CREATOR_BAN) for (const tid of banTok) if (creatorOf.has(tid)) creators.add(creatorOf.get(tid));
  return { blTok, creators, lastExit };
}
function cooldownLeftMin(bans, tid) {
  const e = bans.lastExit.get(tid);
  if (!e) return 0;
  return Math.max(0, (/stop-loss/i.test(e.reason) ? COOLDOWN_STOP_MIN : COOLDOWN_MIN) - (Date.now() - e.t) / 6e4);
}
function lossBans(cycles) {
  const m = {};
  for (const c of cycles.slice().sort((a, b) => a.closedAt - b.closedAt)) m[c.tid] = c.pnl <= 0 ? +c.closedAt : 0;
  return m;
}
const lossBanned = (lb, tid) => LOSS_BAN_H > 0 && !!lb[tid] && Date.now() - lb[tid] < LOSS_BAN_H * 36e5;
function pauseLeftMin(cycles) {
  if (PAUSE_LOSSES <= 0 || PAUSE_MIN <= 0) return 0;
  const last = cycles.slice().sort((a, b) => a.closedAt - b.closedAt).slice(-PAUSE_LOSSES);
  if (last.length < PAUSE_LOSSES || !last.every(c => c.pnl <= 0)) return 0;
  return Math.max(0, PAUSE_MIN - (Date.now() - last[last.length - 1].closedAt) / 6e4);
}
const killedMem = new Map();                         // mint -> time of a structural RugCheck kill (skipped for 24h, no database writes)

// ================================================================ OBSERVATIONS (every coin that passed the filters is saved and followed)
const RANK = { rugcheck: 4, fake: 4, risk: 5, pass: 6, executor: 7 };
const OBS = { ok: false, pending: new Map(), seen: new Map(), queue: [] };
function featsOf(p, extra = {}) {
  const liq = p.liquidity?.usd || 0, mc = p.marketCap || p.fdv || 0, vol1 = p.volume?.h1 || 0;
  const age = (Date.now() - (p.pairCreatedAt || Date.now())) / 36e5;
  const b1 = p.txns?.h1?.buys || 0, s1 = p.txns?.h1?.sells || 0;
  return {
    age: round(age, 2), liq: Math.round(liq), mcap: Math.round(mc), vol1h: Math.round(vol1),
    ch5: typeof p.priceChange?.m5 === "number" ? p.priceChange.m5 : null, ch1: p.priceChange?.h1 ?? null,
    bsr1: b1 + s1 ? round(b1 / (b1 + s1), 3) : null, liqmc: mc ? round(liq / mc, 4) : null, turn: liq ? round(vol1 / liq, 2) : null,
    mood: MOOD.n ? round(MOOD.median, 1) : null, src: srcOf.get(p.baseToken.address) || "?", hour: new Date().getUTCHours(), ...extra,
  };
}
function rec(p, stage, verdict, reason, f) {
  if (!OBS.ok) return;
  const price = +p.priceUsd;
  if (!(price > 0)) return;
  const mint = p.baseToken.address, rank = RANK[stage] || 1, s = OBS.seen.get(mint);
  if (s && Date.now() - s.t < OBS_DEDUPE_H * 36e5 && rank <= s.rank) return;
  OBS.seen.set(mint, { t: Date.now(), rank });
  OBS.queue.push({ rank, row: { user_id: USER, mint, ticker: tickerOf(p), source: f.src, stage, verdict, reason: String(reason).slice(0, 120), price, features: f, path: [[0, 0]], done: false, stale: false, entered: false } });
}
const newFollow = (row, t0) => ({ id: row.id, mint: row.mint, price0: +row.price, t0, path: Array.isArray(row.path) && row.path.length ? row.path : [[0, 0]], miss: 0, dirty: false, finish: false, dead: false });
async function obsInit() {
  if (!OBS_ON) return;
  const t = await db.from("bot_observations").select("id").limit(1);
  if (t.error) { log("OBSERVATIONS DISABLED (run the SQL for bot_observations and bot_learning first):", t.error.message); return; }
  OBS.ok = true;
  const since = new Date(Date.now() - (HORIZON_H * 60 + 15) * 6e4).toISOString();
  await db.from("bot_observations").update({ done: true, stale: true }).eq("user_id", USER).eq("done", false).lt("seen_at", since);
  const pr = await db.from("bot_observations").select("id,mint,seen_at,price,path").eq("user_id", USER).eq("done", false).gte("seen_at", since).order("seen_at", { ascending: false }).limit(MAX_FOLLOW);
  if (!pr.error) for (const x of pr.data) OBS.pending.set(x.id, newFollow(x, +new Date(x.seen_at)));
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
  for (const it of q) { if (room > 0) room--; else { it.row.done = true; it.row.stale = true; } }   // over the follow limit: saved, not followed
  let saved = 0;
  for (let i = 0; i < q.length; i += 100) {
    const r = await db.from("bot_observations").insert(q.slice(i, i + 100).map(x => x.row)).select("id,mint,price,done");
    if (r.error) { log("obs insert failed:", r.error.message); continue; }
    saved += r.data.length;
    for (const row of r.data) if (!row.done) OBS.pending.set(row.id, newFollow(row, Date.now()));
  }
  const cut = Date.now() - OBS_DEDUPE_H * 36e5;
  for (const [k, v] of OBS.seen) if (v.t < cut) OBS.seen.delete(k);
  log(`observations: saved ${saved} coins, following ${OBS.pending.size}`);
}
async function obsEntered(p, f, usd) {
  if (!OBS.ok) return;
  try { await must(db.from("bot_observations").insert({ user_id: USER, mint: p.baseToken.address, ticker: tickerOf(p), source: f.src, stage: "executor", verdict: "entered", reason: "entered", price: +p.priceUsd, features: { ...f, usd: round(usd, 2) }, path: [[0, 0]], done: true, stale: false, entered: true })); }
  catch (e) { log("obs entered failed:", e.message); }
}
async function obsTradeClosed(mint, o) {
  if (!OBS.ok) return;
  try {
    const r = await db.from("bot_observations").select("id").eq("user_id", USER).eq("mint", mint).eq("entered", true).is("closed_at", null).order("seen_at", { ascending: false }).limit(1);
    const id = r.data?.[0]?.id;
    if (id) await must(db.from("bot_observations").update({ trade_ret: o.ret, mfe: o.mfe, mae: o.mae, exit_reason: String(o.why).slice(0, 80), closed_at: now() }).eq("id", id));
  } catch (e) { log("obs trade update failed:", e.message); }
}
const nearest = (path, min) => { let b = null, d = 1e9; for (const [m, r] of path) { const x = Math.abs(m - min); if (x < d) { d = x; b = r; } } return d <= 15 ? b : null; };
async function obsPersist(force) {
  if (!OBS.ok) return;
  const list = [...OBS.pending.values()];
  const fin = list.filter(o => o.finish), dirty = list.filter(o => !o.finish && force && o.dirty);
  for (let i = 0; i < fin.length; i += 100) {
    const part = fin.slice(i, i + 100);
    const rows = part.map(o => { const rets = o.path.map(q => q[1]); return { id: o.id, user_id: USER, mint: o.mint, path: o.path, done: true, resolved_at: now(), ret_1h: nearest(o.path, 60), ret_3h: nearest(o.path, 180), max_up: Math.max(...rets), max_dd: Math.min(...rets) }; });
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
async function obsFollow() {
  if (!OBS.ok || !OBS.pending.size) return;
  const list = [...OBS.pending.values()];
  const best = bestPair(await pairsFor([...new Set(list.map(o => o.mint))]));
  const t = Date.now();
  let dead = 0, done = 0;
  for (const o of list) {
    const ageMin = (t - o.t0) / 6e4, pr = best[o.mint];
    if (pr && +pr.priceUsd > 0) { o.miss = 0; o.path.push([round(ageMin, 1), round((+pr.priceUsd / o.price0 - 1) * 100, 2)]); o.dirty = true; }
    else if (++o.miss >= MISSING_N) { o.path.push([round(ageMin, 1), -95]); o.dead = true; o.dirty = true; dead++; }
    if (o.dead || ageMin >= HORIZON_H * 60) { o.finish = true; done++; }
  }
  await obsPersist(false);
  log(`observations: checked ${list.length} followed coins, finished ${done} (dead ${dead}), still following ${OBS.pending.size}`);
}

// ================================================================ LEARNER: win-probability model (logistic regression on bucketed features)
const LEARN = { model: null, gate: { active: false, T: null }, lines: [], simIds: new Set(), sims: [], last: null };
const FEATS = ["age", "liq", "mcap", "vol1h", "ch5", "ch1", "bsr1", "liqmc", "turn", "hour", "src", "mood", "risk"];
const EDGES = {
  age: [1, 2, 6, 24, 48], liq: [60000, 100000, 200000, 500000], mcap: [500000, 1000000, 3000000, 10000000],
  vol1h: [100000, 200000, 500000, 1500000], ch5: [-2, 0, 1, 3, 8], ch1: [5, 15, 30, 60], bsr1: [0.45, 0.5, 0.55, 0.6],
  liqmc: [0.05, 0.08, 0.12, 0.2], turn: [2, 5, 10, 15], mood: [-8, -3, 0, 3], risk: [15, 25, 35, 45, 60],
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
async function trainLogit(rows) {                  // rows: [{f, y (0/1), w}]
  const idxOf = new Map(), keys = [];
  const X = rows.map(r => FEATS.map(ft => { const k = bkt(ft, r.f); let i = idxOf.get(k); if (i === undefined) { i = keys.length; idxOf.set(k, i); keys.push(k); } return i; }));
  const D = keys.length, W = new Float64Array(D), sw = rows.reduce((s, r) => s + r.w, 0);
  const base = clamp(rows.reduce((s, r) => s + r.y * r.w, 0) / sw, 0.02, 0.98);
  let b = Math.log(base / (1 - base));
  const LR = 1, LAMBDA = 0.002;
  for (let it = 0; it < LOGIT_ITERS; it++) {
    const g = new Float64Array(D); let gb = 0;
    for (let n = 0; n < rows.length; n++) {
      let z = b; const idx = X[n];
      for (let k = 0; k < idx.length; k++) z += W[idx[k]];
      const e = (1 / (1 + Math.exp(-z)) - rows[n].y) * rows[n].w;
      for (let k = 0; k < idx.length; k++) g[idx[k]] += e;
      gb += e;
    }
    for (let j = 0; j < D; j++) W[j] -= LR * (g[j] / sw + LAMBDA * W[j]);
    b -= LR * gb / sw;
    if (it % 40 === 39) await sleep(0);
  }
  const w = {}; keys.forEach((k, j) => { w[k] = round(W[j], 4); });
  return { b: round(b, 4), w, n: rows.length, base: round(base, 4) };
}
function predict(model, f) {
  let z = model.b;
  for (const ft of FEATS) { const w = model.w[bkt(ft, f)]; if (w !== undefined) z += w; }
  return 1 / (1 + Math.exp(-z));
}
async function validate(rows) {                    // train on the older 70%, test on the newest 30%
  const s = rows.slice().sort((a, b) => a.t - b.t), cut = Math.floor(s.length * 0.7), train = s.slice(0, cut), test = s.slice(cut);
  if (train.length < 60 || test.length < 25) return { ok: false, why: `not enough data (train ${train.length}, test ${test.length})` };
  const m = await trainLogit(train);
  const preds = test.map(o => ({ p: predict(m, o.f), y: o.y, ret: o.ret }));
  const steps = [...new Set([WIN_TARGET, 0.80, 0.85, 0.90].filter(t => t >= WIN_TARGET))].sort((a, b) => a - b);
  let last = null;
  for (const T of steps) {
    const A = preds.filter(x => x.p >= T);
    const win = A.length ? A.filter(x => x.y).length / A.length : null, mean = A.length ? A.reduce((s2, x) => s2 + x.ret, 0) / A.length : null;
    last = { T, n: A.length, win, mean };
    if (A.length >= GATE_MIN_N && win >= WIN_TARGET - GATE_TOL && mean > 0) return { ok: true, ...last, testN: test.length };
    if (A.length < GATE_MIN_N) break;
  }
  return { ok: false, ...last, testN: test.length, why: "no threshold reaches the target on the newest data" };
}
const lsGet = async key => { const r = await db.from("bot_learning").select("value").eq("user_id", USER).eq("key", key).maybeSingle(); if (r.error) throw new Error("bot_learning: " + r.error.message); return r.data?.value ?? null; };
const lsSet = async (key, value) => must(db.from("bot_learning").upsert({ user_id: USER, key, value, updated_at: now() }, { onConflict: "user_id,key" }));
async function learnInit() {
  if (!LEARN_ON || !OBS.ok) return;
  try {
    const md = await lsGet("model_v12");
    if (md?.model?.w) { LEARN.model = md.model; LEARN.gate = md.gate || { active: false, T: null }; log(`LEARN loaded model (${md.model.n} examples), gate ${LEARN.gate.active ? "ACTIVE at P(win) >= " + LEARN.gate.T : "not validated"}`); }
  } catch (e) { log("learn init failed:", e.message); }
}
async function learnLoad() {
  const since = LEARN.last ? new Date(+new Date(LEARN.last) - 5000).toISOString() : new Date(Date.now() - LEARN_DAYS * 864e5).toISOString();
  let maxR = LEARN.last;
  for (let from = 0; ; from += 1000) {               // simulated examples: coins that passed all filters, followed for HORIZON_H
    const r = await db.from("bot_observations").select("id,seen_at,features,path,resolved_at").eq("user_id", USER).eq("stage", "pass").eq("done", true).eq("stale", false).eq("entered", false).gte("resolved_at", since).order("resolved_at", { ascending: true }).range(from, from + 999);
    if (r.error) throw new Error("bot_observations: " + r.error.message);
    for (const x of r.data) {
      if (LEARN.simIds.has(x.id)) continue;
      LEARN.simIds.add(x.id);
      const path = Array.isArray(x.path) ? x.path : [];
      if (path.length >= 3) { const ret = simPath(path); LEARN.sims.push({ t: +new Date(x.seen_at), f: x.features || {}, y: ret > 0 ? 1 : 0, ret, w: 1 }); }
      if (!maxR || x.resolved_at > maxR) maxR = x.resolved_at;
    }
    if (r.data.length < 1000) break;
  }
  LEARN.last = maxR;
  const cutoff = Date.now() - LEARN_DAYS * 864e5;
  LEARN.sims = LEARN.sims.filter(o => o.t >= cutoff).sort((a, b) => a.t - b.t).slice(-6000);
  const rr = await db.from("bot_observations").select("seen_at,features,trade_ret,mfe,mae,exit_reason").eq("user_id", USER).eq("entered", true).not("closed_at", "is", null).gte("seen_at", new Date(cutoff).toISOString()).order("seen_at", { ascending: false }).limit(1000);
  if (rr.error) throw new Error("bot_observations: " + rr.error.message);
  return rr.data.map(x => { const ret = (+x.trade_ret || 0) / 100; return { t: +new Date(x.seen_at), f: x.features || {}, y: ret > 0 ? 1 : 0, ret, w: REAL_W, why: x.exit_reason || "", mfe: x.mfe }; });
}
function lessons(real) {                           // what the bot's own losing trades have in common
  const out = [];
  const losses = real.filter(o => !o.y);
  if (real.length >= 5) {
    const byWhy = {};
    for (const o of losses) { const k = String(o.why).replace(/[0-9.%x-]+/g, "").replace(/\s+/g, " ").trim().slice(0, 30) || "?"; byWhy[k] = (byWhy[k] || 0) + 1; }
    out.push(`own trades: ${real.length}, losses ${losses.length}; loss reasons: ` + (Object.entries(byWhy).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} (${n})`).join(", ") || "none"));
    const agg = {};
    for (const o of real) for (const ft of FEATS) { const b = bkt(ft, o.f); const a = agg[b] || (agg[b] = { n: 0, loss: 0, sum: 0 }); a.n++; a.sum += o.ret; if (!o.y) a.loss++; }
    const worst = Object.entries(agg).filter(([, a]) => a.n >= 5 && a.loss / a.n >= 0.5).sort((a, b) => a[1].sum / a[1].n - b[1].sum / b[1].n).slice(0, 3);
    if (worst.length) out.push("repeating mistakes: " + worst.map(([k, a]) => `${k} (${a.loss}/${a.n} lost, avg ${pc(a.sum / a.n)})`).join(" | "));
  } else out.push(`own trades: ${real.length} (lessons appear after 5 closed trades)`);
  return out;
}
async function learnCycle() {
  if (!LEARN_ON || !OBS.ok) return;
  step = "learn";
  const real = await learnLoad();
  const rows = [...LEARN.sims, ...real];
  const sw = LEARN.sims.filter(o => o.y), sl = LEARN.sims.filter(o => !o.y);
  const avgW = sw.length ? sw.reduce((s, o) => s + o.ret, 0) / sw.length : 0, avgL = sl.length ? -sl.reduce((s, o) => s + o.ret, 0) / sl.length : 0;
  const lines = [`data: ${LEARN.sims.length} followed coins + ${real.length} own trades, still following ${OBS.pending.size}`];
  if (LEARN.sims.length) lines.push(`under your rules a random eligible coin wins ${(sw.length / LEARN.sims.length * 100).toFixed(0)}% (avg win ${pc(avgW)}, avg loss -${(avgL * 100).toFixed(1)}%) -> break-even win rate ${avgW + avgL > 0 ? (avgL / (avgW + avgL) * 100).toFixed(0) + "%" : "n/a"}`);
  if (rows.length >= LEARN_MIN) {
    const val = await validate(rows);
    LEARN.model = await trainLogit(rows);
    LEARN.gate = { active: val.ok, T: val.ok ? val.T : null, val, at: now() };
    await lsSet("model_v12", { model: LEARN.model, gate: LEARN.gate });
    lines.push(`model: ${rows.length} examples, ${LEARN.gate.active ? "VALIDATED: trades only coins with P(win) >= " + val.T : "NOT validated yet (" + (val.why || "target not reached") + ")"} | newest-data test: accepted ${val.n ?? 0} of ${val.testN ?? 0}, win rate ${pc(val.win)}, avg net return ${pc(val.mean)}`);
    const ws = Object.entries(LEARN.model.w).sort((a, b) => b[1] - a[1]);
    if (ws.length >= 6) { lines.push("model likes: " + ws.slice(0, 3).map(([k, v]) => `${k} (${v > 0 ? "+" : ""}${v})`).join(" | ")); lines.push("model avoids: " + ws.slice(-3).reverse().map(([k, v]) => `${k} (${v})`).join(" | ")); }
  } else lines.push(`model: collecting data (${rows.length}/${LEARN_MIN}); mode ${GATE_MODE}`);
  lines.push(...lessons(real));
  LEARN.lines = lines;
  lines.forEach(l => log("LEARN", l));
}

// ================================================================ EXECUTOR
async function enter(S, e, ctx, usd, mult, how) {
  const price = +e.p.priceUsd;
  const tok = await tokenFor(S, e.p);
  await snapshot(tok.id, e.p);
  await paperBuy(tok.id, tok.ticker, price, usd, e.p.liquidity?.usd || 0);
  await decide(tok.id, "WEJŚĆ",
    `risk ${e.risk}/100, p(win) ${e.prob === null ? "n/a" : e.prob.toFixed(2)}, size $${usd.toFixed(2)} (${(usd / ctx.equity * 100).toFixed(1)}% of portfolio${mult !== 1 ? ", explore x" + mult : ""}). entry: ${how}. stop at $${(price * STOP).toPrecision(5)} (-${Math.round((1 - STOP) * 100)}%). rugcheck: ${e.rc.note}. creator:${e.rc.creator || "unknown"}. ${e.note}`,
    `Stop -${Math.round((1 - STOP) * 100)}%; after +${Math.round((ARM_X - 1) * 100)}% hold while rising, sell all on a ${TRAIL_DROP}% fall from the peak; liquidity drop ${LIQ_DROP}%/${LIQ_WINDOW_MIN}min; time stop ${TIME_STOP_H}h`,
    `Risk ${e.risk}/100. Memecoin: can go to zero.`);
  await obsEntered(e.p, e.f, usd);
  log("ENTER", tok.ticker, "risk", e.risk, "p(win)", e.prob === null ? "n/a" : e.prob.toFixed(2), "size $" + usd.toFixed(2), "|", how);
  await notify(`ENTER ${tok.ticker} $${usd.toFixed(2)} (risk ${e.risk}, p(win) ${e.prob === null ? "n/a" : e.prob.toFixed(2)})`);
}

// ================================================================ SCAN: Scout -> filters -> RugCheck -> fake check -> risk -> gate -> executor
async function scan(S, reload) {
  const cycles = cyc(S), bans = buildBans(S), lb = lossBans(cycles), pos = positions(S);
  const byMint = new Map(S.tokens.map(t => [t.mint_address, t]));
  const blocked = mint => {
    const t = byMint.get(mint);
    if ((killedMem.get(mint) || 0) > Date.now() - 24 * 36e5) return true;
    return !!t && (pos[t.id]?.qty > 1e-8 || bans.blTok.has(t.id) || lossBanned(lb, t.id) || cooldownLeftMin(bans, t.id) > 0);
  };
  step = "scout";
  srcOf.clear();
  const addrs = (await discover()).filter(a => !blocked(a)).slice(0, MAX_CAND);
  step = "fetch pair data";
  const pairs = Object.values(bestPair(await pairsFor(addrs)));
  MOOD = computeMood(pairs);
  log(`scan: ${addrs.length} candidates, ${pairs.length} pairs | market mood: median 1h ${fmt1(MOOD.median)}%, ${(MOOD.breadth * 100).toFixed(0)}% of ${MOOD.n} active coins up | banned creators ${bans.creators.size}`);

  const cands = [];
  for (const p of pairs) {
    const r = [...scoutKills(p), ...filterKills(p)];
    if (r.length) r.forEach(x => tally("filter", x)); else cands.push(p);
  }
  cands.sort((a, b) => (b.volume?.h1 || 0) - (a.volume?.h1 || 0));

  step = "rugcheck";
  const eligible = [];
  let fetched = 0;
  for (const p of cands) {
    const addr = p.baseToken.address, tk = tickerOf(p), fresh = rcFresh(addr);
    if (!fresh && RUGCHECK && fetched >= MAX_RC) { tally("rugcheck", "skipped (RugCheck budget per scan)"); continue; }
    const rc = await rugCheck(addr);
    if (!fresh && RUGCHECK) { fetched++; await pace(); }
    if (rc.unavailable && RUGCHECK_STRICT) { tally("rugcheck", "RugCheck unavailable"); continue; }
    const kills = rc.kills.slice();
    if (CREATOR_BAN && rc.creator && bans.creators.has(rc.creator)) kills.push({ key: "creator banned (earlier rug)", detail: "creator banned (earlier rug)", hard: true });
    if (kills.length) {
      kills.forEach(k => tally("rugcheck", k.key));
      log("KILL rugcheck", tk, "-", kills.map(k => k.detail).join("; "));
      rec(p, "rugcheck", "killed", kills[0].key, featsOf(p));
      if (kills.some(k => k.hard)) killedMem.set(addr, Date.now());
      if (kills.some(k => k.ban)) {                    // rug / honeypot / past rugger: blacklist forever and ban the creator
        if (rc.creator) bans.creators.add(rc.creator);
        const tok = await tokenFor(S, p);
        await decide(tok.id, "POCZEKAĆ", `KILL[rugcheck] ${kills.map(k => k.detail).join("; ")} | ${rc.note} creator:${rc.creator || "unknown"} [BLACKLIST] [CREATORBAN]`);
      }
      continue;
    }
    let same = 0;
    if (FAKE_CHECK) {
      const fk = await impersonation(p);
      if (fk.kill) { tally("fake", "copy of an older token"); log("KILL fake", tk, "-", fk.kill); rec(p, "fake", "killed", fk.kill, featsOf(p)); killedMem.set(addr, Date.now()); continue; }
      same = fk.same;
    }
    const rs = riskScore(p, rc, same);
    const f = featsOf(p, { risk: rs.risk });
    if (rs.risk > RISK_CUT) { tally("risk", `risk above ${RISK_CUT}`); rec(p, "risk", "killed", `risk ${rs.risk}`, f); continue; }
    const prob = LEARN.model ? predict(LEARN.model, f) : null;
    if (prob !== null) f.p = round(prob, 3);
    eligible.push({ p, rc, risk: rs.risk, prob, f, note: `liq $${f.liq}, vol1h $${f.vol1h}, mcap $${f.mcap}, age ${f.age}h, 5m ${fmt1(f.ch5)}%, 1h ${fmt1(f.ch1)}%` });
  }
  eligible.sort((a, b) => a.risk - b.risk);           // safest first
  log(`desk: ${pairs.length} pairs -> filters ${cands.length} -> RugCheck+fake+risk ${eligible.length} eligible (fresh RugCheck reports ${fetched}) | gate ${GATE_MODE}${LEARN.gate.active ? " VALIDATED p>=" + LEARN.gate.T : ""}`);

  const pl = pauseLeftMin(cycles);
  if (pl > 0) {
    log(`ENTRY PAUSE: ${PAUSE_LOSSES} losing trades in a row, ${pl.toFixed(0)} min left, no new entries`);
    for (const e of eligible) rec(e.p, "pass", "entry pause", "entry pause", e.f);
    try { await obsFlush(); } catch (err) { log("obs flush failed:", err.message); }
    return killSummary();
  }

  step = "executor";
  let entered = 0;
  for (const e of eligible) {
    const ctx = liveCtx(S);
    let verdict = null, mult = 1;
    if (ctx.freeSlots <= 0) verdict = "no free slot";
    else if (GATE_MODE !== "off") {
      if (LEARN.gate.active) { if (!(e.prob !== null && e.prob >= LEARN.gate.T)) verdict = "model: P(win) below the validated threshold"; }
      else if (GATE_MODE === "strict") verdict = "strict: model not validated yet";
      else if (e.risk > EXPLORE_MAX_RISK) verdict = `explore: risk above ${EXPLORE_MAX_RISK}`;
      else mult = EXPLORE_SIZE_MULT;
    }
    let usd = 0;
    if (!verdict) { usd = sizeFor(e.risk, e.p.liquidity?.usd || 0, ctx, mult); if (!usd) verdict = "no cash, exposure or liquidity room"; }
    if (verdict) { tally("gate", verdict); rec(e.p, "pass", verdict, verdict, e.f); continue; }
    rec(e.p, "pass", "entered", "entered", e.f);
    await enter(S, e, ctx, usd, mult, LEARN.gate.active ? `validated model p(win) ${e.prob.toFixed(2)}` : GATE_MODE === "off" ? "no gate" : `explore mode (safest coins, x${mult} size)`);
    entered++;
    await reload();
  }
  try { await obsFlush(); } catch (err) { log("obs flush failed:", err.message); }
  killSummary();
  log(`desk: entered ${entered} of ${eligible.length} eligible coins`);
}

// ================================================================ RISK: manage open positions (every POLL_SEC)
const mem = new Map();                              // tokenId -> { key, peak, low, last, lastSnap, missSince, liqHist }
let lastManageAt = 0;
function exitCategory(reason) {
  const r = reason || "";
  if (/stop-loss/i.test(r)) return "stop-loss";
  if (/profit trail/i.test(r)) return "profit trail";
  if (/rug pull/i.test(r)) return "rug pull";
  if (/liquidity dropped/i.test(r)) return "liquidity drop";
  if (/no price data/i.test(r)) return "dead pair";
  if (/time stop/i.test(r)) return "time stop";
  return "other";
}
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
    if (havePrice) { price = +pr.priceUsd; liq = pr.liquidity?.usd || 0; m.missSince = 0; }
    else {
      if (!m.missSince) m.missSince = Date.now();
      const mins = (Date.now() - m.missSince) / 6e4;
      log("no price for", t.ticker, `(${mins.toFixed(1)} min)`);
      if (mins < NOPRICE_MIN) continue;
      price = m.last * NOPRICE_RECOVERY; liq = 0;      // dead pair: simulated salvage price
    }
    const x = price / p.entry;
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
    const peakX = m.peak / p.entry, ageH = (Date.now() - p.firstAt) / 36e5;

    const exitAll = async (why, o = {}) => {            // o.ban = blacklist the token and ban its creator
      const mfe = (peakX - 1) * 100, mae = (Math.min(m.low, price) / p.entry - 1) * 100;
      const net = await paperSell(t.id, t.ticker, price, p.qty, why, liq);
      const ret = net / p.cost - 1;
      const bl = !!o.ban || x <= BL_LOSS;
      await decide(t.id, "WYJŚĆ", `exit all (${why}) at ${x.toFixed(2)}x, peak ${peakX.toFixed(2)}x, net ${(ret * 100).toFixed(1)}%, mfe=${mfe.toFixed(1)}% mae=${mae.toFixed(1)}%${bl ? " [BLACKLIST]" : ""}${o.ban ? " [CREATORBAN]" : ""}`);
      log("EXIT", t.ticker, why, x.toFixed(4) + "x", "peak", peakX.toFixed(4) + "x", `net ${(ret * 100).toFixed(1)}%`, bl ? "-> BLACKLISTED" : "");
      await notify(`EXIT ${t.ticker}: ${why} at ${x.toFixed(2)}x (net ${(ret * 100).toFixed(1)}%)`);
      await obsTradeClosed(t.mint_address, { ret: round(ret * 100, 2), mfe: round(mfe, 2), mae: round(mae, 2), why });
      mem.delete(t.id); changed = true;
    };

    if (!havePrice) { await exitAll(`no price data for ${NOPRICE_MIN} min, pair dead`, { ban: true }); continue; }
    if (liq < RUG_LIQ || x <= 0.2) { await exitAll(`rug pull suspected, liquidity $${Math.round(liq)}`, { ban: true }); continue; }
    if (LIQ_DROP > 0 && liqDrop >= LIQ_DROP) { await exitAll(`liquidity dropped ${liqDrop.toFixed(0)}% within ${LIQ_WINDOW_MIN} min`, { ban: liqDrop >= 50 }); continue; }
    const why = exitCheck(x, peakX, ageH);
    if (why) { await exitAll(why); continue; }
    log("HOLD", t.ticker, x.toFixed(4) + "x", "peak", peakX.toFixed(4) + "x", peakX >= ARM_X ? `(riding: sells on a ${TRAIL_DROP}% fall from the peak)` : `(stop at ${STOP}x, age ${ageH.toFixed(1)}h)`);
  }
  return changed;
}

// ================================================================ STATS AND DAILY REPORT
function exitStats(S, cycles) {
  const exits = S.decisions.filter(d => d.decision === "WYJŚĆ").sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const agg = {};
  for (const c of cycles) {
    const d = exits.find(x => x.token_id === c.tid && +new Date(x.created_at) >= +c.closedAt - 3000);
    const a = agg[d ? exitCategory(d.reason) : "manual/unknown"] || (agg[d ? exitCategory(d.reason) : "manual/unknown"] = { n: 0, wins: 0, pnl: 0 });
    a.n++; a.pnl += c.pnl; if (c.pnl > 0) a.wins++;
  }
  return Object.entries(agg).sort((a, b) => a[1].pnl - b[1].pnl).map(([k, a]) => `${k}: ${a.n} trades, wins ${a.wins}, P&L $${a.pnl.toFixed(2)}`);
}
function statLines(S) {
  const cycles = cyc(S), all = summarize(cycles), last = summarize(cycles.slice().sort((a, b) => a.closedAt - b.closedAt).slice(-30));
  const lines = [];
  if (!all.n) return ["no closed trades yet"];
  lines.push(`ALL: ${all.n} trades, win rate ${(all.win * 100).toFixed(0)}% (last 30: ${last.win === null ? "n/a" : (last.win * 100).toFixed(0) + "%"}), avg win ${pc(all.avgW)}, avg loss -${(all.avgL * 100).toFixed(1)}%, break-even win rate ${all.be === null ? "n/a" : (all.be * 100).toFixed(0) + "%"}, P&L $${all.pnl.toFixed(2)}`);
  for (const l of exitStats(S, cycles)) lines.push("exit " + l);
  return lines;
}
async function markToMarket(S) {
  const open = openOf(positions(S));
  let value = 0, cost = 0;
  if (open.length) {
    const toks = open.map(([id]) => S.tokens.find(t => t.id === id)).filter(Boolean);
    const best = bestPair(await pairsFor(toks.map(t => t.mint_address)));
    for (const [id, p] of open) {
      const t = S.tokens.find(x => x.id === id), pr = t && best[t.mint_address];
      value += p.qty * (pr && +pr.priceUsd > 0 ? +pr.priceUsd : p.entry); cost += p.cost;
    }
  }
  return { count: open.length, value, cost };
}
async function report(S) {
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const today = cyc(S).filter(c => c.closedAt >= dayStart), td = summarize(today);
  const buys = S.trades.filter(t => t.side === "BUY" && new Date(t.executed_at) >= dayStart).length;
  const mtm = await markToMarket(S);
  const lines = [
    `DAILY REPORT ${dayStart.toISOString().slice(0, 10)}`,
    `entries today: ${buys} | closed today: ${td.n} (wins ${td.wins}, win rate ${td.win === null ? "n/a" : (td.win * 100).toFixed(0) + "%"}) | realized P&L today $${td.pnl.toFixed(2)}`,
    `open positions: ${mtm.count}, unrealized P&L $${(mtm.value - mtm.cost).toFixed(2)} | equity $${(cash(S) + mtm.value).toFixed(2)} (cash $${cash(S).toFixed(2)})`,
    `market mood: median 1h ${fmt1(MOOD.median)}%, ${(MOOD.breadth * 100).toFixed(0)}% of ${MOOD.n} active coins up`,
    ...statLines(S), ...LEARN.lines.map(l => "learn: " + l.slice(0, 300)),
  ];
  lines.forEach(l => log("REPORT", l));
  await notify(lines.join("\n"));
}

// ================================================================ SELF TEST (offline): node Bot.mjs --selftest
async function selftest() {
  let bad = 0;
  const ok = (name, cond) => { console.log((cond ? "PASS " : "FAIL ") + name); if (!cond) bad++; };
  ok("stop-loss at -20%", /stop-loss/.test(exitCheck(0.80, 1, 1) || "") && !exitCheck(0.81, 1, 1));
  ok("no sell while price rises after +10%", exitCheck(1.5, 1.5, 1) === null && exitCheck(1.2, 1.2, 1) === null);
  ok("trail sells on a 4.5% fall from the peak", /profit trail/.test(exitCheck(1.06, 1.12, 1) || "") && exitCheck(1.08, 1.12, 1) === null);
  ok("no trail before +10%", exitCheck(1.04, 1.09, 1) === null);
  ok("time stop only for coins that never reached +10%", /time stop/.test(exitCheck(1.0, 1.05, 30) || "") && exitCheck(1.2, 1.2, 30) === null);
  ok("size: risk 0 -> $300, risk 15 -> $150", Math.abs(sizeUsd(0) - 300) < 1e-6 && Math.abs(sizeUsd(15) - 150) < 1e-6);
  ok("size: risk 16 -> $100, risk 35 -> $60", Math.abs(sizeUsd(16) - 100) < 1e-6 && Math.abs(sizeUsd(35) - 60) < 1e-6);
  ok("size: risk 36 -> $50, risk 65 -> $40", Math.abs(sizeUsd(36) - 50) < 1e-6 && Math.abs(sizeUsd(65) - 40) < 1e-6);
  ok("size: risk 66 -> $30, above 65 never over $30", Math.abs(sizeUsd(66) - 30) < 1e-6 && sizeUsd(80) <= 30 && sizeUsd(85) <= 30);
  ok("size: lower risk = bigger position", sizeUsd(10) > sizeUsd(20) && sizeUsd(20) > sizeUsd(50) && sizeUsd(50) > sizeUsd(70));
  ok("size never below minimum", sizeUsd(100) === MIN_USD);
  const ctx = { equity: 10000, invested: 0, cash: 10000 };
  ok("size capped by liquidity (2%)", sizeFor(9, 5000, ctx, 1) === 100);
  ok("size capped by cash", sizeFor(9, 1e6, { equity: 10000, invested: 0, cash: 50 }, 1) === 50);
  ok("size cap follows current equity (35%)", sizeFor(0, 1e7, { equity: 400, invested: 0, cash: 400 }, 1) === 140 && sizeFor(0, 1e7, { equity: 2000, invested: 0, cash: 2000 }, 1) === 300);
  const p = { baseToken: { address: "A", symbol: "X" }, liquidity: { usd: 500000 }, marketCap: 3000000, volume: { h1: 200000 }, pairCreatedAt: Date.now() - 20 * 36e5, txns: { h1: { buys: 300, sells: 250 } }, priceChange: { h1: 5, m5: 1 }, info: { socials: [1] } };
  const good = riskScore(p, { m: { top10: 5, dev: 0, bundled: 0, lp: 100, holders: 3000, creatorTokens: 1 } }, 0);
  const badc = riskScore({ ...p, liquidity: { usd: 41000 }, marketCap: 400000, info: {}, pairCreatedAt: Date.now() - 36e5 }, { m: { top10: 24, dev: 2.9, bundled: 9, lp: 72, holders: 60, creatorTokens: 6 } }, 4);
  ok(`risk score ordering (clean ${good.risk}, dirty ${badc.risk})`, good.risk >= 0 && good.risk < 20 && badc.risk > 60 && badc.risk <= 100);
  ok("filters pass a healthy coin", filterKills(p).length === 0 && scoutKills(p).length === 0);
  ok("filters kill thin liquidity / wash trading", filterKills({ ...p, liquidity: { usd: 20000 } }).length > 0 && filterKills({ ...p, volume: { h1: 3e6 }, liquidity: { usd: 50000 } }).some(x => /wash/.test(x)));
  const r1 = simPath([[0, 0], [3, 5], [6, 12], [9, 16], [12, 10]]);
  ok(`sim: rides to +16% then sells at +10% (net ${(r1 * 100).toFixed(2)}%)`, Math.abs(r1 - (1.10 * (1 - C) * (1 - C) - 1)) < 1e-9);
  const r2 = simPath([[0, 0], [3, -10], [6, -25], [9, 30]]);
  ok(`sim: stop-loss exit is a loss (net ${(r2 * 100).toFixed(2)}%)`, r2 < -0.2);
  ok("sim: dead coin is a loss", simPath([[0, 0], [3, 2], [6, -95]]) < -0.9);
  // the learner must find a pattern that exists in the data
  const rows = [];
  for (let i = 0; i < 300; i++) { const hi = i % 2 === 0; rows.push({ t: i, f: { age: 5, liq: 100000, mcap: 1e6, vol1h: 150000, ch5: hi ? 4 : -1, ch1: 20, bsr1: 0.55, liqmc: 0.1, turn: 3, hour: 10, src: "a", mood: 0, risk: hi ? 20 : 50 }, y: hi ? (i % 10 === 0 ? 0 : 1) : (i % 10 === 1 ? 1 : 0), ret: hi ? 0.1 : -0.2, w: 1 }); }
  const mdl = await trainLogit(rows);
  const pHi = predict(mdl, rows[0].f), pLo = predict(mdl, rows[1].f);
  ok(`model learns the pattern, true win rates 0.8 vs 0.2 (p ${pHi.toFixed(2)} vs ${pLo.toFixed(2)})`, Math.abs(pHi - 0.8) < 0.08 && Math.abs(pLo - 0.2) < 0.08);
  const v = await validate(rows);
  ok(`validation accepts a real pattern (${JSON.stringify({ ok: v.ok, T: v.T, n: v.n, win: v.win && round(v.win, 2) })})`, v.ok === true);
  const noise = rows.map((r, i) => ({ ...r, y: (i * 7919) % 100 < 45 ? 1 : 0, ret: (i * 7919) % 100 < 45 ? 0.02 : -0.2 }));
  const v2 = await validate(noise);
  ok(`validation rejects noise (${JSON.stringify({ ok: v2.ok, n: v2.n })})`, v2.ok === false);
  const S = { tokens: [], trades: [], ledger: [], decisions: [{ token_id: 1, decision: "POCZEKAĆ", reason: "[BOT] KILL creator:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin [BLACKLIST] [CREATORBAN]", created_at: now() }] };
  const bans = buildBans(S);
  ok("creator ban is read from the decisions", bans.blTok.has(1) && bans.creators.has("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"));
  const losing = [1, 2, 3, 4].map(i => ({ pnl: -5, closedAt: new Date(Date.now() - i * 60e3) }));
  ok("pause after a losing streak", pauseLeftMin(losing) > 0 && pauseLeftMin([...losing.slice(0, 3), { pnl: 5, closedAt: new Date() }]) === 0);
  ok("exit categories", exitCategory("profit trail 4.5% below peak 1.2x") === "profit trail" && exitCategory("stop-loss at -20%") === "stop-loss");
  console.log(bad ? `\n${bad} TEST(S) FAILED` : "\nALL TESTS PASSED");
  process.exit(bad ? 1 : 0);
}

// ================================================================ MAIN
async function main() {
  if (!BOT_EMAIL || !BOT_PASSWORD) throw new Error("secret BOT_EMAIL or BOT_PASSWORD is empty");
  step = "login";
  await login();
  step = "init";
  try { await obsInit(); await learnInit(); } catch (e) { OBS.ok = false; log("observations/learning init failed, running without learning:", e.message); }
  const minArg = process.argv.find(a => a.startsWith("--minutes="));
  const minutes = minArg ? +minArg.split("=")[1] : 0;
  const deadline = minutes > 0 ? Date.now() + minutes * 60e3 : Infinity;
  log("bot v12 started (paper trading only) | mode", ONCE ? "once" : minutes ? minutes + " min loop" : "loop forever",
    `| exits: stop -${Math.round((1 - STOP) * 100)}%, hold after +${Math.round((ARM_X - 1) * 100)}% and sell on a ${TRAIL_DROP}% fall from the peak | size: $${SIZE_PTS[0][1]} at risk 0 down to $${SIZE_PTS[SIZE_PTS.length - 1][1]} at risk 100 (bands), max ${MAX_POS_PCT * 100}% of equity per position, cut at risk ${RISK_CUT} | gate ${GATE_MODE}, explore size x${EXPLORE_SIZE_MULT}, target win rate ${WIN_TARGET * 100}% | learning ${OBS.ok && LEARN_ON ? "ON" : "OFF"} | poll ${POLL_SEC}s, scan ${SCAN_SEC}s`);

  let S = null, lastLoad = 0, lastScan = 0, lastTick = 0, lastFollow = 0, lastPersist = Date.now(), lastLearn = 0, beat = Date.now(), busy = false;
  let lastReportDay = new Date().getUTCHours() >= REPORT_HOUR ? new Date().toISOString().slice(0, 10) : "";
  const reload = async () => { const fresh = await load(); if (S) Object.assign(S, fresh); else S = fresh; lastLoad = Date.now(); };
  const onErr = async (label, e) => {
    log(label, e.message);
    if (/jwt|expired|401|not authenticated|invalid.*token/i.test(String(e.message))) { try { await login(); log("re-login ok"); } catch (e2) { log("re-login failed:", e2.message); } }
  };
  const safe = async (label, fn) => { try { await fn(); } catch (e) { await onErr(label + " error:", e); } };
  const runManage = async () => {
    if (busy || !S) return;
    busy = true;
    try { if (await manage(S)) await reload(); } catch (e) { await onErr("manage error:", e); } finally { busy = false; }
  };
  pace = async () => { beat = Date.now(); if (Date.now() - lastTick >= POLL_SEC * 1000) { lastTick = Date.now(); await runManage(); } };

  if (ONCE) {
    await reload(); await runManage();
    step = "scan"; await reload(); await scan(S, reload);
    await safe("follow", obsFollow); await safe("persist", () => obsPersist(true)); await safe("learn", learnCycle);
    await reload();
    statLines(S).forEach(l => log("STATS", l));
    await report(S);
    log("run finished");
    return;
  }

  if (WATCHDOG_MIN > 0) setInterval(() => {
    if (Date.now() - beat > WATCHDOG_MIN * 60e3) { console.log("::error::watchdog: no progress for " + WATCHDOG_MIN + " min, exiting so the next scheduled run takes over"); process.exit(1); }
  }, 60e3).unref();

  while (Date.now() < deadline) {
    try {
      beat = Date.now();
      if (!S || Date.now() - lastLoad > 5 * 60e3) await reload();
      lastTick = Date.now(); await runManage();
      if (Date.now() - lastScan > SCAN_SEC * 1000 && Date.now() < deadline - 90e3) {
        await reload();
        await scan(S, reload); lastScan = Date.now();
        await reload();
        statLines(S).forEach(l => log("STATS", l));
      }
    } catch (e) { await onErr("cycle error:", e); }
    if (OBS.ok && Date.now() - lastFollow > FOLLOW_SEC * 1000 && Date.now() < deadline - 90e3) { lastFollow = Date.now(); await safe("follow", obsFollow); }
    if (OBS.ok && Date.now() - lastPersist > PERSIST_SEC * 1000) { lastPersist = Date.now(); await safe("persist", () => obsPersist(true)); }
    if (OBS.ok && LEARN_ON && Date.now() - lastLearn > LEARN_SEC * 1000 && Date.now() < deadline - 120e3) { lastLearn = Date.now(); beat = Date.now(); await safe("learn", learnCycle); }
    try {
      const d = new Date(), day = d.toISOString().slice(0, 10);
      if (S && d.getUTCHours() >= REPORT_HOUR && lastReportDay !== day) { await report(S); lastReportDay = day; }
    } catch (e) { await onErr("report error:", e); }
    await sleep(Math.max(0, Math.min(POLL_SEC * 1000, deadline - Date.now())));
  }
  await safe("final persist", () => obsPersist(true));
  log("time window finished, exiting (open positions stay in the database and are picked up by the next run)");
}

if (SELFTEST) selftest().catch(e => { console.log("selftest crashed:", e); process.exit(1); });
else main().catch(e => {
  console.log("::error::[" + step + "] " + String(e?.message || e).replace(/\s+/g, " "));
  process.exit(1);
});
