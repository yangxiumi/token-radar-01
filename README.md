# Token Radar

[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/c/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/yangxiumi/token-radar-01/rank.svg)](https://make.fun/c/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/yangxiumi/token-radar-01/reward.svg)](https://make.fun/c/token-radar-01)

> **Before submitting:** replace `OWNER` / `REPO` in the two badge URLs above with
> the real GitHub owner and repository name. The competition badge needs no
> owner; the rank and reward badges do, and the entry check refuses a
> placeholder such as `{owner}`.

A token launch radar for [make.fun's token-radar-01](https://make.fun/c/token-radar-01)
bounty. It reads a sealed DefiLlama snapshot, finds the protocols that have not
launched a token yet, ranks them by implied launch value, and renders a static
dashboard with a per-protocol farm plan.

## What it does

- **Watchlist first.** The snapshot's 40-protocol watchlist (TVL >= $50M, no
  token on record) is covered in full, and the early radar extends the
  watchlist's own eligibility rule below the floor — same categories, same
  no-token test — so no bridge, wrapped asset, centralised-exchange token or
  staking derivative of an already-tokenized asset ranks above a real
  protocol. 158 rows in total on the 2026-11-14 snapshot.
- **A fitted value model, not a fixed multiple.** `log10(market cap)` is
  fitted at runtime on the snapshot's own tokenized protocols (128 comps),
  with a per-category residual offset shrunk by `n/(n+3)`, then a small
  growth tilt and a maturity tilt. Fitted slope 0.522, R² 0.194. Held out on
  5 folds, the median absolute error is 0.57 dex, against 0.71 dex for a
  fixed 0.25x TVL multiple and 0.69 dex for a category-median multiple.
- **A farm plan per protocol.** Six concrete steps with capital, gas cost
  and time, tiered by TVL and by the protocol's main chain.
- **A static dashboard.** Sortable, searchable, filterable by category, with
  a live-token view of the comps the model is fitted on, a per-protocol
  detail view that recomputes the implied value on the page, and a model
  panel that shows the fitted coefficients and the held-out validation.
  No network: the page reads only `data.js` beside it.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
```

Node 22 or later, standard library only. `main.ts` reads the snapshot,
writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and
`dossier.json` to the output directory, and refuses to write a board the
gate would reject. Two runs on the same snapshot write byte-identical output.

## Layout

```
main.ts                  entry program (Node 22, stdlib only)
lib/model.ts             valuation model, farm plans, board builder
vendor/makefun-board.ts  make.fun's own dossier library (from the kit)
dashboard/               index.html + app.css + app.js (static, no network)
screenshots/             board, protocol detail, filtered view
```

## Model

```
implied = round( 10^(a + b·log10(TVL)) · 10^(category offset)
                 · (1 + clamp(change_7d, -60, 120)/100 · 0.5)
                 · (0.6 + min(age, 1095)/1095 · 0.4) )
```

`a` and `b` are fitted on the snapshot's tokenized protocols at runtime;
the category offset is the median residual of that category's comps,
shrunk toward zero. Growth and age have almost no explanatory power on this
snapshot (R² ≈ 0.02), so they enter as small disclosed priors, not fitted
coefficients. An implied value is an estimate, not a price, and a farm is a
bet on a launch that may never come.

## License

MIT. See [LICENSE](LICENSE).
