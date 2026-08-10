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
week?"* or *"Is NVDA overbought? Show me the daily chart for the last 6 months."*
Claude calls the connector, pulls the live data, and reasons over the actual
numbers.

Three tools are exposed:

| Tool | What it does |
|---|---|
| `list_expirations` | Expiration dates for a symbol, with days to expiry and strike counts |
| `get_options_chain` | Strikes around the money for one expiration — bid, ask, last, delta, gamma, theta, vega, IV, open interest, volume, both sides |
| `get_price_history` | OHLCV candles plus SMA 20/50/100/200/250, EMA 9/21, MACD, RSI 14, ATR 14, range high/low and average volume |

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
