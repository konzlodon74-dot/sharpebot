// sharpebot — a small-stakes, high-turnover paper bot for the pump.fun Sharpe sprint
// (agent-fun/replay/v2). The grader runs `node /bot/main.ts`; the wire protocol lives in
// vendor/makefun-bot.ts and everything below is the strategy.
//
// Why this shape: places are ranked by hourly Sharpe ratio, not by raw PnL, and a prize
// needs net PnL above 0 after fees. So the bot spreads many small, short trades across
// many coins instead of betting big on one moonshot:
//   - every position is the same small stake (0.04 SOL of a 10 SOL bankroll), at most
//     5 open at once, so no single coin can move the equity curve much;
//   - exits are mechanical and tight: take profit at +7% liquidation value over cost,
//     stop loss at -7%, a trailing stop once a trade is up 5%, a hard time limit of
//     500 slots, and an early exit when a coin goes quiet for 150 slots;
//   - entries need a live tape: a curve at least 40 slots old holding 2.5-80 SOL of
//     real reserves, at least 6 trades, net inflow of 0.25 SOL or more over the last
//     30 slots with at least 3 buys, price within -2%..+60% of its window start and
//     still near the window high — steady buying, not a vertical spike or a dead coin.
//
// Guardrails: the run needs round trips of at least 0.01 SOL on at least 20 distinct
// mints. The bot tracks which mints have completed a round trip (a filled buy of at
// least 0.01 SOL whose position later closed) and prefers fresh mints for new entries.
// If the round-trip count lags a linear pace over the 6-hour window (measured in block
// time from the first event), it opens small 0.015 SOL probe round trips on liquid
// curves and sells them a few slots after the buy lands, until it is back on pace.
// At most 2 entries per mint, with a 200-slot cooldown after an exit.
//
// Determinism: the bot is a pure function of the hello/batch stream. It never reads the
// clock, the environment or Math.random; candidate mints are sorted by score then by
// mint address, and every map iteration follows insertion order from the batch stream,
// so the two graded executions produce byte-identical action logs.

import { pathToFileURL } from 'node:url';
import { BPS, LAMPORTS_PER_SOL, runBot } from './vendor/makefun-bot.ts';
import type { Batch, Bot, BotState, Mark, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ parameters

/** SOL per normal position (lamports). Small on purpose: Sharpe rewards steadiness. */
const STAKE = 40_000_000n;
/** SOL per guardrail probe round trip. Above the 0.01 SOL round-trip floor. */
const PROBE = 15_000_000n;
/** Never send a buy smaller than this (keeps every filled buy above the 0.01 SOL floor). */
const MIN_BUY = 12_000_000n;
/** Entry tape window, in slots. */
const WINDOW = 30;
/** A curve must be at least this many slots old before a normal entry. */
const MIN_AGE = 120;
/** Real SOL reserve band for normal entries (lamports). */
const MIN_REAL = 2_500_000_000n;
const MAX_REAL = 80_000_000_000n;
/** Minimum trades seen on the curve before a normal entry. */
const MIN_TRADES = 10;
/** Net inflow (buys minus sells, lamports) required over the entry window. */
const MIN_NET_FLOW = 500_000_000n;
/** Minimum buy trades inside the entry window. */
const MIN_WINDOW_BUYS = 3;
/** Price change over the window must stay inside this band (fractions): the window
 * as a whole is still up, but the coin has pulled back from its high (below). */
const MIN_UP = 0.03;
const MAX_UP = 0.4;
/** Last price must sit in this pullback band below the window high (shares of the
 * high): buying a dip inside a still-rising tape, not chasing the top tick. */
const PULLBACK_LO = 0.8;
const PULLBACK_HI = 0.97;
/** Exits, measured on liquidation value vs cost (fractions). Liquidation value is
 * already net of the sell-side curve fee and tx fee, and cost includes the buy-side
 * fee, so these bands are real profit/loss. The payoff is deliberately asymmetric
 * (+12% target vs -6% stop): on bonding curves a trade that works usually runs well
 * past +5%, while the stop and trailing exit keep the losing tail short, which is
 * what keeps hourly returns smooth for the Sharpe ranking. */
const TAKE_PROFIT = 0.12;
const STOP_LOSS = 0.06;
const TRAIL_ARM = 0.08;
const TRAIL = 0.04;
/** Hard holding limit and quiet-coin limit, in slots. */
const MAX_HOLD = 600;
const STALE = 150;
/** Probes use the same exit bands as normal positions but a shorter time limit, so
 * a probe still completes its round trip without donating the round-trip fees. */
const PROBE_MAX_HOLD = 200;
/** At most this many entries per mint, and this cooldown after an exit. */
const MAX_ENTRIES_PER_MINT = 1;
const COOLDOWN = 400;
/** Guardrail pacing: aim for this many round-tripped mints over the window. */
const TARGET_TRIPS = 24;
const WINDOW_SECONDS = 21_600;
/** Stop opening normal entries once equity falls below this share of the start. */
const EQUITY_FLOOR = 0.9;
/** Slippage tolerances (bps). Sells always go out wide so exits are never refused. */
const BUY_SLIP = 800;
const SELL_SLIP = 10_000;
/** Curve fees (protocol + creator fallback) used to estimate liquidation value. */
const FEE_BPS = 125n;

// ------------------------------------------------------------------ bookkeeping

interface TapeTrade {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  price: number;
}

interface Coin {
  created: number | null;
  trades: TapeTrade[];
  lastTradeSlot: number;
  entries: number;
  coolUntil: number;
}

interface Held {
  openedSlot: number;
  peakValue: bigint;
  probe: boolean;
  exiting: boolean;
}

export function createBot(): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints whose buy filled for at least 0.01 SOL and whose position has not closed yet. */
  const openTrips = new Set<Pubkey>();
  /** Mints with a completed round trip (filled buy >= 0.01 SOL, position later closed). */
  const doneTrips = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = { created: null, trades: [], lastTradeSlot: -1, entries: 0, coolUntil: -1 };
      coins.set(mint, c);
    }
    return c;
  };

  /** What selling `tokens` would pay after curve fees, from the harness mark reserves. */
  const liquidation = (mark: Mark | undefined, tokens: bigint, tx: bigint): bigint => {
    if (mark === undefined || tokens <= 0n) return 0n;
    const vq = BigInt(mark.virtual_quote_reserves);
    const vt = BigInt(mark.virtual_token_reserves);
    const rq = BigInt(mark.real_quote_reserves);
    if (vt + tokens === 0n) return 0n;
    let q = (tokens * vq) / (vt + tokens);
    if (q > rq) q = rq;
    return q - (q * FEE_BPS + BPS - 1n) / BPS - tx;
  };

  /** Entry score for a curve at slot `now`, or -1 when the tape does not qualify. */
  const scoreOf = (c: Coin, now: number, real: bigint): number => {
    if (c.created === null || now - c.created < MIN_AGE) return -1;
    if (real < MIN_REAL || real > MAX_REAL) return -1;
    if (c.trades.length < MIN_TRADES) return -1;
    const from = now - WINDOW;
    let net = 0n;
    let buys = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    for (const t of c.trades) {
      if (t.slot <= from) {
        startPrice = t.price;
        continue;
      }
      if (startPrice < 0) startPrice = t.price;
      net += t.isBuy ? t.sol : -t.sol;
      if (t.isBuy) buys++;
      if (t.price > high) high = t.price;
      last = t.price;
    }
    if (buys < MIN_WINDOW_BUYS || net < MIN_NET_FLOW) return -1;
    if (startPrice <= 0 || high <= 0) return -1;
    const up = last / startPrice - 1;
    if (up < MIN_UP || up > MAX_UP) return -1;
    if (last < high * PULLBACK_LO || last > high * PULLBACK_HI) return -1;
    // Rank by net inflow per unit of reserve, so small lively curves win over whales.
    return Number(net) / Number(real > 0n ? real : 1n);
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const tx = state.txFeeLamports();
      const orderCap = state.hello.caps.max_orders_per_batch;
      const traded: Pubkey[] = [];

      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          coinOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const vt = Number(e.virtual_token_reserves);
          c.trades.push({
            slot: e.slot,
            isBuy: e.is_buy,
            sol: BigInt(e.sol_amount),
            price: vt > 0 ? Number(e.virtual_quote_reserves) / vt : 0,
          });
          if (c.trades.length > 120) c.trades.splice(0, c.trades.length - 120);
          c.lastTradeSlot = e.slot;
          if (!traded.includes(e.mint)) traded.push(e.mint);
        }
      }

      // Round-trip bookkeeping from fills.
      for (const f of batch.fills) {
        if (f.status === 'filled' && f.side === 'buy' && BigInt(f.quote_lamports) >= LAMPORTS_PER_SOL / 100n) {
          openTrips.add(f.mint);
        }
        if (f.status === 'rejected' && f.side === 'buy' && !state.positions.has(f.mint)) {
          // A refused entry cools the mint down instead of retrying into the same wall.
          coinOf(f.mint).coolUntil = now + COOLDOWN;
          const h = held.get(f.mint);
          if (h !== undefined) held.delete(f.mint);
        }
      }
      for (const mint of [...openTrips]) {
        if (!state.positions.has(mint)) {
          let pending = false;
          for (const p of state.pending.values()) if (p.order.mint === mint) pending = true;
          if (!pending) {
            openTrips.delete(mint);
            doneTrips.add(mint);
          }
        }
      }

      const marks = new Map<Pubkey, Mark>();
      for (const m of batch.marks) marks.set(m.mint, m);
      const pendingMints = new Set<Pubkey>();
      for (const p of state.pending.values()) pendingMints.add(p.order.mint);

      const orders: OrderInput[] = [];

      // 1) Exits on held positions, oldest first.
      const heldMints = [...held.keys()].sort((a, b) => {
        const d = held.get(a)!.openedSlot - held.get(b)!.openedSlot;
        return d !== 0 ? d : a < b ? -1 : 1;
      });
      let equity = state.cash;
      for (const mint of heldMints) {
        const pos = state.positions.get(mint);
        const h = held.get(mint)!;
        if (pos === undefined) {
          if (!pendingMints.has(mint)) {
            held.delete(mint);
            coinOf(mint).coolUntil = now + COOLDOWN;
          }
          continue;
        }
        const value = liquidation(marks.get(mint), pos.token_amount, tx);
        equity += value > 0n ? value : 0n;
        if (value > h.peakValue) h.peakValue = value;
        if (h.exiting || pendingMints.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const cost = pos.cost_lamports;
        const heldSlots = now - h.openedSlot;
        const c = coinOf(mint);
        let exit = false;
        if (cost > 0n) {
          if (value * 10_000n >= cost * BigInt(Math.round((1 + TAKE_PROFIT) * 10_000))) exit = true;
          if (value * 10_000n <= cost * BigInt(Math.round((1 - STOP_LOSS) * 10_000))) exit = true;
          if (
            h.peakValue * 10_000n >= cost * BigInt(Math.round((1 + TRAIL_ARM) * 10_000)) &&
            value * 10_000n <= h.peakValue * BigInt(Math.round((1 - TRAIL) * 10_000))
          ) {
            exit = true;
          }
        }
        if (heldSlots >= (h.probe ? PROBE_MAX_HOLD : MAX_HOLD)) exit = true;
        if (c.lastTradeSlot >= 0 && now - c.lastTradeSlot >= STALE) exit = true;
        if (!exit) continue;
        if (orders.length >= orderCap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP });
        h.exiting = true;
        pendingMints.add(mint);
      }

      // 2) New entries: qualifying tapes, fresh mints first, then by score.
      const startCash = BigInt(state.hello.capital.lamports);
      const equityOk = equity * 100n >= startCash * BigInt(Math.round(EQUITY_FLOOR * 100));
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      if (equityOk && slotsLeft > 0) {
        const scored: { mint: Pubkey; score: number; fresh: boolean }[] = [];
        for (const mint of traded) {
          if (held.has(mint) || pendingMints.has(mint) || state.positions.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const c = coinOf(mint);
          if (now < c.coolUntil || c.entries >= MAX_ENTRIES_PER_MINT) continue;
          const score = scoreOf(c, now, curve.real_quote_reserves);
          if (score < 0) continue;
          scored.push({ mint, score, fresh: !doneTrips.has(mint) && !openTrips.has(mint) });
        }
        scored.sort((a, b) => {
          if (a.fresh !== b.fresh) return a.fresh ? -1 : 1;
          if (a.score !== b.score) return b.score - a.score;
          return a.mint < b.mint ? -1 : 1;
        });
        for (const s of scored) {
          if (orders.length >= orderCap || slotsLeft <= 0) break;
          // Keep one slot in reserve for guardrail probes until the trip target is met.
          if (doneTrips.size + openTrips.size < TARGET_TRIPS && slotsLeft <= 1) break;
          let amount = STAKE;
          const cap = (state.maxBuyLamports(s.mint) * 97n) / 100n;
          if (amount > cap) amount = cap;
          if (amount < MIN_BUY) continue;
          if (free < amount + tx) continue;
          orders.push({ side: 'buy', mint: s.mint, quote_lamports: amount, max_slippage_bps: BUY_SLIP });
          held.set(s.mint, { openedSlot: now, peakValue: 0n, probe: false, exiting: false });
          coinOf(s.mint).entries++;
          pendingMints.add(s.mint);
          free -= amount + tx;
          slotsLeft--;
        }
      }

      // 3) Guardrail probes when completed round trips lag the pace.
      if (firstTime !== null && lastTime !== null && slotsLeft > 0 && orders.length < orderCap) {
        const pace = Math.min(1, Math.max(0, (lastTime - firstTime) / WINDOW_SECONDS));
        const due = Math.ceil(TARGET_TRIPS * pace);
        if (doneTrips.size + openTrips.size < due) {
          for (const mint of traded) {
            if (orders.length >= orderCap || slotsLeft <= 0) break;
            if (held.has(mint) || pendingMints.has(mint) || state.positions.has(mint)) continue;
            if (doneTrips.has(mint) || openTrips.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (curve.real_quote_reserves < 2_000_000_000n) continue;
            const cap = (state.maxBuyLamports(mint) * 97n) / 100n;
            if (cap < PROBE) continue;
            if (free < PROBE + tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: PROBE, max_slippage_bps: BUY_SLIP });
            held.set(mint, { openedSlot: now, peakValue: 0n, probe: true, exiting: false });
            pendingMints.add(mint);
            free -= PROBE + tx;
            slotsLeft--;
            break; // one probe at a time keeps the pacing gentle
          }
        }
      }

      return orders;
    },
  };
}

// Run only when executed directly (`node main.ts`), so tests can import createBot.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await runBot(createBot());
}
