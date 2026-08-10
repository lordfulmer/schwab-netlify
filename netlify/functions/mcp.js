// mcp.js
// An MCP server exposing your live Schwab market data — options chains and price
// history — as tools, so Claude can pull the numbers itself instead of you
// pasting them in. Add the URL as a custom connector in claude.ai and it runs
// under your subscription, not API billing.
//
// Served at:  https://YOUR-SITE.netlify.app/mcp/YOUR_SECRET
//
// Required environment variables (in addition to the SCHWAB_* ones):
//   MCP_SHARED_SECRET - any long random string you make up. Without it this
//                       function refuses to serve, because it would otherwise
//                       expose your Schwab-authenticated data to anyone.
//
// This is a CommonJS function on purpose: it matches the other functions here,
// so the bundler inlines every dependency rather than leaving @netlify/blobs to
// be resolved at runtime.

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const {
  WebStandardStreamableHTTPServerTransport,
} = require('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js');
const { z } = require('zod');

const { getValidAccessToken } = require('./schwab-token-manager');

const DEFAULT_WINDOW = 12;
const DEFAULT_MAX_CANDLES = 300;

async function schwabGet(path, params) {
  const accessToken = await getValidAccessToken();
  const query = new URLSearchParams(params).toString();
  const url = `https://api.schwabapi.com/marketdata/v1/${path}?${query}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

  if (!res.ok) {
    throw new Error(`Schwab returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

const fetchChain = (symbol) => schwabGet('chains', { symbol });

function textResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// Schwab keys expirations as "2026-08-10:1" — the date and the days to expiry.
function parseExp(key) {
  const [date, dte] = key.split(':');
  return { key, date, daysToExpiration: Number(dte) };
}

// Schwab's price history takes four interlocking parameters (periodType, period,
// frequencyType, frequency) with combinations that are illegal in ways the docs
// only imply. These two tables collapse that into one range plus one interval,
// so a model cannot ask for something the API will reject.
const RANGES = {
  '1d': { periodType: 'day', period: 1 },
  '2d': { periodType: 'day', period: 2 },
  '3d': { periodType: 'day', period: 3 },
  '5d': { periodType: 'day', period: 5 },
  '10d': { periodType: 'day', period: 10 },
  '1m': { periodType: 'month', period: 1 },
  '2m': { periodType: 'month', period: 2 },
  '3m': { periodType: 'month', period: 3 },
  '6m': { periodType: 'month', period: 6 },
  ytd: { periodType: 'ytd', period: 1 },
  '1y': { periodType: 'year', period: 1 },
  '2y': { periodType: 'year', period: 2 },
  '3y': { periodType: 'year', period: 3 },
  '5y': { periodType: 'year', period: 5 },
  '10y': { periodType: 'year', period: 10 },
};

const INTERVALS = {
  '1min': { frequencyType: 'minute', frequency: 1 },
  '5min': { frequencyType: 'minute', frequency: 5 },
  '10min': { frequencyType: 'minute', frequency: 10 },
  '15min': { frequencyType: 'minute', frequency: 15 },
  '30min': { frequencyType: 'minute', frequency: 30 },
  daily: { frequencyType: 'daily', frequency: 1 },
  weekly: { frequencyType: 'weekly', frequency: 1 },
  monthly: { frequencyType: 'monthly', frequency: 1 },
};

// Which frequencyTypes each periodType actually accepts.
const LEGAL = {
  day: ['minute'],
  month: ['daily', 'weekly'],
  year: ['daily', 'weekly', 'monthly'],
  ytd: ['daily', 'weekly'],
};

function defaultInterval(periodType, period) {
  if (periodType === 'day') return '5min';
  if (periodType === 'year' && period > 2) return 'weekly';
  return 'daily';
}

const NY_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const NY_MINUTE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

// Schwab stamps candles in epoch milliseconds. Market questions are asked in
// exchange time, so render them in New York rather than UTC.
function stamp(ms, intraday) {
  const d = new Date(ms);
  return intraday ? NY_MINUTE.format(d).replace(', ', ' ') : NY_DAY.format(d);
}

const round = (v, digits = 2) =>
  v === null || v === undefined || !isFinite(v) ? null : Number(v.toFixed(digits));

function sma(values, n) {
  if (values.length < n) return null;
  let sum = 0;
  for (let i = values.length - n; i < values.length; i++) sum += values[i];
  return sum / n;
}

function ema(values, n) {
  if (values.length < n) return null;
  const k = 2 / (n + 1);
  let e = 0;
  for (let i = 0; i < n; i++) e += values[i];
  e /= n;
  for (let i = n; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

// Wilder's RSI — the smoothing everyone's charts use, not a plain average.
function rsi(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }
  gain /= n;
  loss /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(change, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-change, 0)) / n;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

function atr(candles, n = 14) {
  if (candles.length < n + 1) return null;
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1].close;
    ranges.push(Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev)));
  }
  let a = 0;
  for (let i = 0; i < n; i++) a += ranges[i];
  a /= n;
  for (let i = n; i < ranges.length; i++) a = (a * (n - 1) + ranges[i]) / n;
  return a;
}

// Computed here rather than left to the model: these are cheap for a CPU and
// error-prone as mental arithmetic over hundreds of closes.
function indicators(candles) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12 !== null && ema26 !== null ? ema12 - ema26 : null;

  return {
    lastClose: round(closes[closes.length - 1]),
    changeFromFirst: round(closes[closes.length - 1] - closes[0]),
    changePercentFromFirst: round(((closes[closes.length - 1] - closes[0]) / closes[0]) * 100),
    sma20: round(sma(closes, 20)),
    sma50: round(sma(closes, 50)),
    sma200: round(sma(closes, 200)),
    ema9: round(ema(closes, 9)),
    ema21: round(ema(closes, 21)),
    macd: round(macdLine, 3),
    rsi14: round(rsi(closes, 14), 1),
    atr14: round(atr(candles, 14), 3),
    periodHigh: round(Math.max(...candles.map((c) => c.high))),
    periodLow: round(Math.min(...candles.map((c) => c.low))),
    avgVolume20: volumes.length >= 20 ? Math.round(sma(volumes, 20)) : null,
    lastVolume: volumes[volumes.length - 1],
  };
}

function buildServer() {
  const server = new McpServer({ name: 'schwab-options-chain', version: '1.0.0' });

  server.registerTool(
    'list_expirations',
    {
      title: 'List option expirations',
      description:
        'List the available option expiration dates for a stock symbol, with days to expiry and strike counts. ' +
        'Call this first when the person names a timeframe rather than an exact date ("this week", "next month", ' +
        'or no date at all) so you can pick the right expiration before pulling the chain.',
      inputSchema: {
        symbol: z.string().describe('Stock ticker, e.g. NVDA'),
      },
    },
    async ({ symbol }) => {
      try {
        const data = await fetchChain(symbol.toUpperCase());
        const map = data.callExpDateMap || {};
        const expirations = Object.keys(map).map((k) => ({
          ...parseExp(k),
          strikeCount: Object.keys(map[k]).length,
        }));

        return textResult({
          symbol: symbol.toUpperCase(),
          underlyingPrice: data.underlyingPrice,
          expirations,
        });
      } catch (err) {
        return errorResult(`Could not list expirations: ${err.message}`);
      }
    }
  );

  server.registerTool(
    'get_options_chain',
    {
      title: 'Get live options chain',
      description:
        'Get the live options chain for one expiration: strikes around the money with bid, ask, last, delta, ' +
        'gamma, theta, vega, implied volatility, open interest and volume for both the call and the put. ' +
        'Call this whenever the person asks which strike or contract to pick, or asks anything that depends on ' +
        'current option pricing — the data is live and cannot be answered from memory. Quotes are delayed or ' +
        'stale outside market hours, so state that when it matters.',
      inputSchema: {
        symbol: z.string().describe('Stock ticker, e.g. NVDA'),
        expiration: z
          .string()
          .optional()
          .describe(
            'Expiration to pull, either "2026-08-10" or the full "2026-08-10:1" key from list_expirations. ' +
              'Omit to use the nearest expiration.'
          ),
        strikesAroundMoney: z
          .number()
          .int()
          .min(1)
          .max(40)
          .optional()
          .describe(`How many strikes above and below the money to include. Defaults to ${DEFAULT_WINDOW}.`),
      },
    },
    async ({ symbol, expiration, strikesAroundMoney }) => {
      try {
        const ticker = symbol.toUpperCase();
        const data = await fetchChain(ticker);
        const callMap = data.callExpDateMap || {};
        const putMap = data.putExpDateMap || {};
        const expKeys = Object.keys(callMap);

        if (!expKeys.length) {
          return errorResult(`No expirations returned for ${ticker}. Check the symbol.`);
        }

        // Accept either the bare date or the full "date:dte" key.
        let expKey = expKeys[0];
        if (expiration) {
          const match = expKeys.find((k) => k === expiration || k.split(':')[0] === expiration);
          if (!match) {
            return errorResult(
              `No expiration ${expiration} for ${ticker}. Available: ${expKeys
                .map((k) => k.split(':')[0])
                .join(', ')}`
            );
          }
          expKey = match;
        }

        const calls = callMap[expKey] || {};
        const puts = putMap[expKey] || {};
        const underlying = data.underlyingPrice || 0;
        const all = Object.keys(calls).map(Number).sort((a, b) => a - b);

        // Centre the window on the strike nearest spot; the far wings are noise.
        let atmIdx = 0;
        all.forEach((s, i) => {
          if (Math.abs(s - underlying) < Math.abs(all[atmIdx] - underlying)) atmIdx = i;
        });
        const window = strikesAroundMoney || DEFAULT_WINDOW;
        const strikes = all.slice(
          Math.max(0, atmIdx - window),
          Math.min(all.length, atmIdx + window + 1)
        );

        // Schwab reports -999 for greeks and IV it has no value for. Passed
        // through as-is that reads like a real (wildly wrong) number, so it
        // becomes null instead.
        const num = (v) => (v === undefined || v === null || v === -999 ? null : v);

        const leg = (contract) => {
          if (!contract) return null;

          const quoted =
            num(contract.bid) || num(contract.ask) || num(contract.last) || contract.openInterest;

          // A strike with no bid, no ask, no trade and no open interest is not
          // tradeable; say so rather than emitting a row of zeros.
          if (!quoted) return null;

          return {
            bid: num(contract.bid),
            ask: num(contract.ask),
            last: num(contract.last),
            mark: num(contract.mark),
            delta: num(contract.delta),
            gamma: num(contract.gamma),
            theta: num(contract.theta),
            vega: num(contract.vega),
            ivPercent: num(contract.volatility),
            openInterest: contract.openInterest,
            volume: contract.totalVolume,
            inTheMoney: contract.inTheMoney,
          };
        };

        return textResult({
          symbol: ticker,
          underlyingPrice: underlying,
          expiration: parseExp(expKey),
          quoteNote:
            'Live from Schwab. Prices in dollars, ivPercent in percent, null means no quote.',
          strikes: strikes.map((strike) => {
            const key = strike.toFixed(1);
            return {
              strike,
              call: leg((calls[key] || calls[String(strike)] || [])[0]),
              put: leg((puts[key] || puts[String(strike)] || [])[0]),
            };
          }),
        });
      } catch (err) {
        if (err.message && err.message.startsWith('REAUTH_REQUIRED')) {
          return errorResult(
            'The Schwab login has expired. Visit /.netlify/functions/schwab-auth-start on the site to reconnect, then try again.'
          );
        }
        return errorResult(`Could not fetch the chain: ${err.message}`);
      }
    }
  );

  server.registerTool(
    'get_price_history',
    {
      title: 'Get price history candles',
      description:
        'Get OHLCV candles for a stock symbol, plus precomputed indicators (SMA 20/50/200, EMA 9/21, ' +
        'MACD line, RSI 14, ATR 14, period high/low, average volume). Call this for any charting, trend, ' +
        'candlestick-pattern, support/resistance, momentum or moving-average question — the data is live ' +
        'and cannot be answered from memory. Use the returned indicators rather than recomputing them by ' +
        'hand. Intraday intervals only work with a range in days.',
      inputSchema: {
        symbol: z.string().describe('Stock ticker, e.g. NVDA'),
        range: z
          .enum(Object.keys(RANGES))
          .optional()
          .describe('How far back to look. Defaults to 6m.'),
        interval: z
          .enum(Object.keys(INTERVALS))
          .optional()
          .describe(
            'Candle size. Minute intervals require a range of 1d-10d; daily/weekly work with months ' +
              'and years; monthly only with years. Defaults to a sensible size for the range.'
          ),
        extendedHours: z
          .boolean()
          .optional()
          .describe('Include pre/post-market candles on intraday ranges. Defaults to false.'),
        maxCandles: z
          .number()
          .int()
          .min(10)
          .max(1200)
          .optional()
          .describe(
            `Cap on candles returned, keeping the most recent. Defaults to ${DEFAULT_MAX_CANDLES}. ` +
              'Indicators are always computed on the full series, not just the returned slice.'
          ),
      },
    },
    async ({ symbol, range, interval, extendedHours, maxCandles }) => {
      try {
        const ticker = symbol.toUpperCase();
        const rangeKey = range || '6m';
        const { periodType, period } = RANGES[rangeKey];
        const intervalKey = interval || defaultInterval(periodType, period);
        const { frequencyType, frequency } = INTERVALS[intervalKey];

        if (!LEGAL[periodType].includes(frequencyType)) {
          const usable = Object.keys(INTERVALS).filter((k) =>
            LEGAL[periodType].includes(INTERVALS[k].frequencyType)
          );
          return errorResult(
            `Schwab does not serve ${intervalKey} candles over a ${rangeKey} range. ` +
              `Valid intervals for ${rangeKey}: ${usable.join(', ')}.`
          );
        }

        const data = await schwabGet('pricehistory', {
          symbol: ticker,
          periodType,
          period,
          frequencyType,
          frequency,
          needExtendedHoursData: extendedHours ? 'true' : 'false',
          needPreviousClose: 'true',
        });

        const candles = data.candles || [];
        if (!candles.length) {
          return errorResult(
            `No candles returned for ${ticker} over ${rangeKey}. Check the symbol, or note that ` +
              'Schwab only keeps intraday history for roughly the last several weeks.'
          );
        }

        // Indicators run on everything Schwab sent; only the printed rows are
        // trimmed, so a 200-day average survives a short candle window.
        const stats = indicators(candles);
        const intraday = frequencyType === 'minute';
        const shown = candles.slice(-(maxCandles || DEFAULT_MAX_CANDLES));

        return textResult({
          symbol: ticker,
          range: rangeKey,
          interval: intervalKey,
          extendedHours: Boolean(extendedHours),
          previousClose: data.previousClose,
          candlesReturned: shown.length,
          candlesAvailable: candles.length,
          indicators: stats,
          indicatorNote: `Computed over all ${candles.length} ${intervalKey} candles. Prices are live from Schwab and may be delayed or stale outside market hours.`,
          columns: ['time', 'open', 'high', 'low', 'close', 'volume'],
          candles: shown.map((c) => [
            stamp(c.datetime, intraday),
            round(c.open),
            round(c.high),
            round(c.low),
            round(c.close),
            c.volume,
          ]),
        });
      } catch (err) {
        if (err.message && err.message.startsWith('REAUTH_REQUIRED')) {
          return errorResult(
            'The Schwab login has expired. Visit /.netlify/functions/schwab-auth-start on the site to reconnect, then try again.'
          );
        }
        return errorResult(`Could not fetch price history: ${err.message}`);
      }
    }
  );

  return server;
}

// The secret rides in the URL path (/mcp/<secret>) rather than a query string,
// because an MCP client's later requests are not guaranteed to carry the query
// it was configured with — but they always carry the path. Header and query
// forms still work for command-line testing.
function authorized(request, event) {
  const secret = process.env.MCP_SHARED_SECRET;
  if (!secret) return false;

  if (request.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (new URL(request.url).searchParams.get('key') === secret) return true;

  const path = (event.path || new URL(request.url).pathname || '').replace(/\/+$/, '');
  return path.endsWith(`/${secret}`);
}

// Bridge the v1 Lambda-style event into the web Request/Response pair the MCP
// transport speaks.
function toRequest(event) {
  const url =
    event.rawUrl ||
    `https://${(event.headers && event.headers.host) || 'localhost'}${event.path || ''}` +
      (event.rawQuery ? `?${event.rawQuery}` : '');

  const body = event.isBase64Encoded && event.body
    ? Buffer.from(event.body, 'base64')
    : event.body;

  return new Request(url, {
    method: event.httpMethod || 'POST',
    headers: event.headers || {},
    body: ['GET', 'HEAD'].includes(event.httpMethod) ? undefined : body,
  });
}

exports.handler = async (event) => {
  if (!process.env.MCP_SHARED_SECRET) {
    return {
      statusCode: 503,
      body:
        'MCP_SHARED_SECRET is not set. Add it in Netlify → Site configuration → Environment variables and ' +
        'redeploy. This endpoint stays closed until it is set, because it serves Schwab-authenticated data.',
    };
  }

  const request = toRequest(event);

  // Deliberately 404, not 401. A 401 is an OAuth challenge under the MCP
  // authorization spec, so returning one sends clients off to hunt for an
  // authorization server that does not exist here — which surfaces to the user
  // as a failed sign-in rather than "wrong URL".
  if (!authorized(request, event)) {
    return { statusCode: 404, body: 'Not found.' };
  }

  // Stateless: no sessionIdGenerator, and plain JSON rather than SSE, since each
  // invocation is a fresh short-lived process.
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });

  const server = buildServer();
  await server.connect(transport);

  try {
    const response = await transport.handleRequest(request);
    return {
      statusCode: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
    };
  } finally {
    await transport.close().catch(() => {});
  }
};
