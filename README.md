# sharpebot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/konzlodon74-dot/sharpebot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/konzlodon74-dot/sharpebot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Bounty: https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532

A paper-trading bot for the pump.fun Sharpe sprint (agent-fun/replay/v2). Places are
ranked by hourly Sharpe ratio on a 6-hour forward replay, and a prize needs net PnL
above 0 after fees — so this bot optimises for steady, controlled gains rather than
one lucky moonshot.

## Strategy

- **Small equal stakes.** Every normal position is 0.04 SOL of the 10 SOL bankroll,
  at most 5 open at once (the harness cap), so no single coin can swing the equity
  curve. Order sizes always respect the per-mint cap of 1% of real reserves (with a
  3% safety margin) and the free-cash balance after pending orders and tx fees.
- **Live-tape entries.** A curve qualifies when it is at least 120 slots old, holds
  2.5–80 SOL of real reserves, has at least 10 trades, shows net inflow of at least
  0.5 SOL with at least 3 buys over the last 30 slots, its price is up 3%..40% over
  the window, and the last price has pulled back to 80–97% of the window high —
  buying a dip inside a still-rising tape instead of chasing the top tick.
  Candidates are ranked by net inflow per unit of reserve, fresh mints first.
- **Mechanical exits.** Take profit at +12% liquidation value over cost, stop loss
  at −6%, a trailing stop (armed at +8%, exits 4% below the peak), a 600-slot hard
  time limit, and an early exit when a coin sees no trade for 150 slots. Liquidation
  value is estimated from the harness marks with curve fees and tx fees deducted.
- **Guardrail pacing.** The run needs round trips of at least 0.01 SOL on at least
  20 distinct mints. The bot tracks completed round trips, prefers mints that have
  not round-tripped yet, keeps one position slot in reserve for probes until the
  target is met, and — when the count lags a linear pace over the 6-hour window —
  opens 0.015 SOL probe round trips on liquid curves (same exit bands, shorter
  200-slot time limit). At most 1 entry per mint, with a 400-slot cooldown after an
  exit; a rejected buy also cools the mint down.
- **Drawdown guard.** Normal entries stop if equity (cash plus liquidation value)
  falls below 90% of the starting capital.
- **Deterministic.** No clock, environment, or `Math.random` reads; all decisions
  are a pure function of the hello/batch stream, with sorted tie-breaking, so the
  two graded executions produce byte-identical action logs.

## Run

Requires Node 22.18+ (the grader uses Node 22.23.4). No dependencies to install;
`vendor/makefun-bot.ts` is the kit's SDK shim, vendored byte for byte.

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2: it reads `hello`/`batch`/`done` JSON lines on
stdin and writes one `reply` line per batch on stdout. Diagnostics, if any, go to
stderr.

## License

MIT — see `LICENSE`.
