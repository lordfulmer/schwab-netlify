# Schwab Trader API — Netlify Setup

## 1. Deploy
Drag this folder into Netlify (same drag-and-drop workflow you used for the
Opulent Oasis dashboard), or push to a repo and connect it.

## 2. Set environment variables
In Netlify: Site settings → Environment variables. Add:

| Key | Value |
|---|---|
| `SCHWAB_APP_KEY` | your App Key from developer.schwab.com |
| `SCHWAB_APP_SECRET` | your Secret from developer.schwab.com |
| `SCHWAB_REDIRECT_URI` | `https://YOUR-SITE.netlify.app/.netlify/functions/schwab-callback` |

## 3. Update the callback URL in Schwab's Developer Portal
Go to your app in the Developer Portal and set the Callback URL to the
exact same value as `SCHWAB_REDIRECT_URI` above. Must match exactly,
including no trailing slash.

## 4. Connect your account
Visit:
```
https://YOUR-SITE.netlify.app/.netlify/functions/schwab-auth-start
```
Log in, approve access. You'll land on a "Connected." page. Tokens are now
saved in Netlify Blobs — no manual copying of codes ever again.

## 5. Pull data
```
https://YOUR-SITE.netlify.app/.netlify/functions/schwab-options-chain?symbol=NVDA
```

## 6. Let Claude read the chain directly (MCP connector)

This site ships an MCP server, so Claude can pull your live chain itself instead
of you pasting it in. It runs through your Claude subscription — no API key, no
per-request cost.

**Set the secret.** In Netlify → Site configuration → Environment variables, add
`MCP_SHARED_SECRET` set to any long random string. Generate one with:

```
openssl rand -hex 24
```

Redeploy. Until this is set the endpoint returns 503 and serves nothing — it is
gated because it exposes Schwab-authenticated data.

**Add the connector.** In claude.ai → Settings → Connectors → Add custom
connector, paste — note the secret goes in the **path**, not a `?key=`:

```
https://YOUR-SITE.netlify.app/mcp/YOUR_SECRET
```

Check it works before adding it, replacing both placeholders:

```
curl -sS -X POST https://YOUR-SITE.netlify.app/mcp/YOUR_SECRET \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

You should get JSON listing both tools. `404` means the secret in the URL does
not match the environment variable; `503` means the variable is not set at all.

If the connector asks you to sign in and the sign-in fails, the URL is wrong —
the server uses no OAuth, so Claude should never prompt for a login.

Then just ask, in any conversation: *"What's the best NVDA strike expiring this
week?"*, *"Is NVDA overbought? Show me the daily chart for the last 6 months."*,
or *"Scan my watchlist for anything above its 200-day."* Claude calls the
connector, pulls the live data, and reasons over the actual numbers.

Six tools are exposed:

| Tool | What it does |
|---|---|
| `list_expirations` | Expiration dates for a symbol, with days to expiry and strike counts |
| `get_options_chain` | Strikes around the money for one expiration — bid, ask, last, delta, gamma, theta, vega, IV, open interest, volume, both sides |
| `get_price_history` | OHLCV candles plus SMA 20/50/100/200/250, EMA 9/21, MACD, RSI 14, ATR 14, range high/low and average volume |
| `get_quote` | Fast live bid/ask/last/mark for one or more symbols at once, plus day range, previous close, 52-week high/low and volume |
| `scan_watchlist` | The same moving-average and RSI read as `get_price_history`, compressed into one summary row per symbol, for up to 15 symbols at once |
| `get_watchlists` | The symbols in your actual saved Schwab watchlists — feeds `scan_watchlist`/`get_quote` when you say "my watchlist" instead of naming tickers |

### Price history ranges and intervals

`get_price_history` takes one `range` and one `interval`. Schwab won't serve
every pairing, so the tool rejects impossible ones up front with the list of
intervals that do work:

| Range | Intervals allowed |
|---|---|
| `1d` `2d` `3d` `5d` `10d` | `1min` `5min` `10min` `15min` `30min` `daily` `weekly` |
| `1m` `2m` `3m` `6m` `ytd` | `daily` `weekly` |
| `1y` `2y` `3y` `5y` `10y` | `daily` `weekly` `monthly` |

Both are optional — the default is one year of daily candles. Schwab only keeps
intraday history for roughly the last several weeks, so minute candles from
months ago come back empty.

Schwab itself won't serve daily candles over a range measured in days, so asking
for `5d` + `daily` gets a month of daily bars trimmed to the last five sessions.

### How the indicator window works

Indicators are computed on the server, not by Claude — a 250-day average is
cheap for a CPU and error-prone as mental arithmetic over hundreds of closes.

Two different spans feed them, which is what makes the long averages usable:

- **Moving averages, RSI and ATR** read the *whole* series fetched. A one-year
  range is only ~252 trading days, so a 250-day average over it would rest on a
  couple of bars — or vanish entirely in a short trading year. Ranges too short
  to seed the long averages quietly fetch two years and use the extra as
  lookback.
- **`rangeHigh`, `rangeLow` and the change** read only the range you asked for.
  So "where's the 52-week high?" on a `1y` range gets the 52-week high, not
  whatever the extra lookback happened to contain.

The response spells out which is which, and `maxCandles` only limits how many
rows get *listed* — it never changes a computed number.

### `get_quote`

Takes one symbol or an array (up to 20), returns one bid/ask/last/mark/day-range
row per symbol in a single Schwab call. Use it for "what's it trading at"
questions that don't need a chain or a chart. A symbol Schwab doesn't
recognize shows up as an `error` row rather than failing the whole call, so one
typo in a batch doesn't cost you the rest.

**Futures work too** — use a leading slash and the specific contract month,
e.g. `/ESZ26` (S&P 500), `/NQZ26` (Nasdaq), `/CLZ26` (crude oil), `/GCZ26`
(gold). A bare continuous root like `/ES` often won't resolve on its own; when
it does, Schwab answers under the actual contract symbol rather than the root
you asked for, so the response includes `resolvedSymbol` when that happens.
Futures report `openInterest` instead of a 52-week range, and their percent
change comes from a different field than a stock's (`futurePercentChange` vs
`netPercentChange`) — both are normalized into the same `netPercentChange` and
`openInterest` fields in the response either way, so nothing downstream needs
to know which asset type it's looking at.

One resolution limit worth knowing: if a continuous root is requested
*alongside* other symbols in the same call and Schwab renames it, there's no
way to tell which returned entry belongs to which request, so it comes back
as a "check the symbol" error instead of a guess. Quote it on its own, or use
the specific contract month, and it resolves cleanly either way.

### `scan_watchlist`

Same indicators as `get_price_history` (SMA 20/50/100/200/250, RSI, MACD,
range high/low), but for up to 15 symbols in one call, trimmed to a summary
row each — no candle data, so a 15-symbol scan doesn't come back as fifteen
full candle dumps. Includes a `trend` field (`uptrend` / `downtrend` / `mixed`,
or `null` if there isn't enough history yet) from comparing last close against
SMA 50 and SMA 200 — a starting point, not a signal.

The 15 symbols fetch in parallel, not one at a time, to stay well inside
Netlify's function time limit. One consequence worth knowing: `get_quote` and
`scan_watchlist` can both trigger a Schwab token refresh from several tool
calls at once. The token manager already handles that — concurrent callers
share a single in-flight refresh rather than each firing their own — so this
doesn't need anything from you, but it's why that logic exists.

### `get_watchlists`

Reads your actual saved watchlist(s) from Schwab — not just a symbol list you
type in. Say *"scan my watchlist"* and Claude calls this first to get the real
symbols, then feeds them into `scan_watchlist` or `get_quote`.

This one needs more than the market data access the other five tools use.
Watchlists live under Schwab's **Trader API**, a separate product from Market
Data:

1. In the [Schwab Developer Portal](https://developer.schwab.com), open your
   app and enable **Trader API - Individual** (Market Data alone won't expose
   `/trader/v1/...` endpoints — that's what causes the 401/403 this tool
   explains if it's missing).
2. If that access is new since your last login, revisit
   `schwab-auth-start` and log in again so the new scope actually gets
   consented to. An old token doesn't retroactively pick up new permissions.

Account numbers never appear in the tool's output — only an index like
"Account 1" — since there's no reason that identifier needs to reach a chat
transcript. Symbols are all it returns.

Treat the secret like a password: anyone holding that URL can pull chains
against your Schwab connection.

## Re-authing (~weekly)
Schwab's refresh token expires after about 7 days no matter what. If a call
returns 401 with "Login expired," just revisit `schwab-auth-start` and log
in again — takes 15 seconds, tokens auto-save the same way.

## Adding more endpoints (e.g. price history for the SMA screener)
Copy `schwab-options-chain.js`, swap the URL to the endpoint you need
(e.g. `/marketdata/v1/pricehistory`), keep the `getValidAccessToken()` call
at the top. That's the whole pattern — every Schwab endpoint works the same way.
