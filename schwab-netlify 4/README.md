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

## Re-authing (~weekly)
Schwab's refresh token expires after about 7 days no matter what. If a call
returns 401 with "Login expired," just revisit `schwab-auth-start` and log
in again — takes 15 seconds, tokens auto-save the same way.

## Adding more endpoints (e.g. price history for the SMA screener)
Copy `schwab-options-chain.js`, swap the URL to the endpoint you need
(e.g. `/marketdata/v1/pricehistory`), keep the `getValidAccessToken()` call
at the top. That's the whole pattern — every Schwab endpoint works the same way.
