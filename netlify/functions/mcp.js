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
const DEFAULT_RANGE = '1y';

// The longest moving average served. A range only just long enough to hold it
// (a year is ~252 trading days) would leave it null or resting on two or three
// bars, so the fetch is widened to cover it — see widenForAverages below.
const LONGEST_AVERAGE = 250;

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

// A price-history request that is invalid or has no data — as opposed to a
// network/auth failure — so callers that fan out over many symbols (the
// watchlist scan) can tell "this symbol has nothing to say" apart from
// "the whole scan should stop", which only REAUTH_REQUIRED means.
class PriceHistoryError extends Error {}

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

// Daily candles everywhere except a range measured in days, where Schwab only
// serves minute bars anyway.
function defaultInterval(periodType) {
  return periodType === 'day' ? '5min' : 'daily';
}

// Roughly how many daily bars a range holds — 252 trading days a year, 21 a
// month. Only used to decide whether to reach back further, so an estimate is
// enough; the window that gets reported is cut by date, not by this.
function approxDailyBars(periodType, period) {
  if (periodType === 'year') return period * 252;
  if (periodType === 'ytd') return 252;
  if (periodType === 'month') return period * 21;
  return period;
}

// Where the range the caller asked for begins, measured back from the last
// candle. Day-length ranges count sessions instead, since counting calendar
// days there would swallow weekends.
function windowStart(periodType, period, lastMs) {
  const d = new Date(lastMs);
  if (periodType === 'month') {
    d.setUTCMonth(d.getUTCMonth() - period);
    return d.getTime();
  }
  if (periodType === 'year') {
    d.setUTCFullYear(d.getUTCFullYear() - period);
    return d.getTime();
  }
  if (periodType === 'ytd') return Date.UTC(d.getUTCFullYear(), 0, 1);
  return null;
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
//
// Two series go in, and the distinction matters. Moving averages run over
// everything fetched, because a 250-day average needs 250 days of lookback
// whatever range was asked for. High, low and change run over `window` — the
// range actually asked for — so a question about the 52-week high gets the
// 52-week high rather than whatever the extra lookback happened to contain.
function indicators(full, window) {
  const closes = full.map((c) => c.close);
  const volumes = full.map((c) => c.volume);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12 !== null && ema26 !== null ? ema12 - ema26 : null;
  const last = closes[closes.length - 1];
  const windowOpen = window[0].close;

  return {
    lastClose: round(last),
    changeOverRange: round(last - windowOpen),
    changePercentOverRange: round(((last - windowOpen) / windowOpen) * 100),
    sma20: round(sma(closes, 20)),
    sma50: round(sma(closes, 50)),
    sma100: round(sma(closes, 100)),
    sma200: round(sma(closes, 200)),
    sma250: round(sma(closes, 250)),
    ema9: round(ema(closes, 9)),
    ema21: round(ema(closes, 21)),
    macd: round(macdLine, 3),
    rsi14: round(rsi(closes, 14), 1),
    atr14: round(atr(full, 14), 3),
    rangeHigh: round(Math.max(...window.map((c) => c.high))),
    rangeLow: round(Math.min(...window.map((c) => c.low))),
    avgVolume20: volumes.length >= 20 ? Math.round(sma(volumes, 20)) : null,
    lastVolume: volumes[volumes.length - 1],
  };
}

// The shared core of get_price_history and scan_watchlist: resolve range and
// interval into what Schwab actually needs, fetch, and compute indicators over
// the right two spans. Throws PriceHistoryError for a bad request or empty
// result, or a generic/REAUTH_REQUIRED Error on transport failure — both are
// meaningful to a caller fanning out over many symbols, so neither is caught
// here.
async function fetchPriceHistory(ticker, rangeKey, intervalKey, extendedHours) {
  const asked = RANGES[rangeKey];
  let { periodType, period } = asked;
  const { frequencyType, frequency } = INTERVALS[intervalKey];

  // "The last five days, daily candles" is an ordinary request that Schwab has
  // no parameters for — a day-range only serves minute bars. Pull a month of
  // daily bars instead and keep the last N sessions, rather than refusing
  // something the caller can reasonably expect to work.
  let sessionCap = null;
  if (periodType === 'day' && frequencyType !== 'minute') {
    sessionCap = period;
    periodType = 'month';
    period = 1;
  }

  // A 250-day average over a one-year range would rest on a couple of bars, or
  // fall out entirely on a short trading year. Reach back far enough to seed
  // the long averages properly; only the candles inside the requested range
  // are reported.
  if (frequencyType === 'daily' && approxDailyBars(periodType, period) < LONGEST_AVERAGE + 20) {
    periodType = 'year';
    period = 2;
  }

  if (!LEGAL[periodType].includes(frequencyType)) {
    const usable = Object.keys(INTERVALS).filter((k) => LEGAL[periodType].includes(INTERVALS[k].frequencyType));
    throw new PriceHistoryError(
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
    throw new PriceHistoryError(
      `No candles returned for ${ticker} over ${rangeKey}. Check the symbol, or note that ` +
        'Schwab only keeps intraday history for roughly the last several weeks.'
    );
  }

  // The candles inside the range that was actually asked for. Sessions are
  // counted for day-length ranges and cut by date for the rest.
  const cutoff = windowStart(asked.periodType, asked.period, candles[candles.length - 1].datetime);
  const window = sessionCap
    ? candles.slice(-sessionCap)
    : cutoff
      ? candles.filter((c) => c.datetime >= cutoff)
      : candles;
  const inRange = window.length ? window : candles;

  // Moving averages read the whole series so the long ones are properly
  // seeded; highs, lows and the change read only the requested range.
  const stats = indicators(candles, inRange);

  return {
    data,
    candles,
    inRange,
    stats,
    frequencyType,
    reachedBack: candles.length > inRange.length,
  };
}

// A simple close-vs-SMA50-vs-SMA200 read for the watchlist scan. Null when
// there isn't enough history to seed both averages — a scan across a mixed
// batch of old and newly-listed tickers should say "unknown", not guess.
function trendLabel(stats) {
  if (stats.sma50 === null || stats.sma200 === null) return null;
  if (stats.lastClose > stats.sma50 && stats.sma50 > stats.sma200) return 'uptrend';
  if (stats.lastClose < stats.sma50 && stats.sma50 < stats.sma200) return 'downtrend';
  return 'mixed';
}

// Schwab reports -999 for fields it has no value for; pass that through raw
// and it reads like a real (wildly wrong) number.
const noSentinel = (v) => (v === undefined || v === null || v === -999 ? null : v);

function formatQuote(ticker, entry) {
  if (!entry || entry.invalid || !entry.quote) {
    return { symbol: ticker, error: 'No quote returned — check the symbol.' };
  }
  const q = entry.quote;
  const ref = entry.reference || {};

  return {
    symbol: ticker,
    description: ref.description || null,
    exchange: ref.exchangeName || q.exchangeName || null,
    last: noSentinel(q.lastPrice),
    mark: noSentinel(q.mark),
    bid: noSentinel(q.bidPrice),
    bidSize: q.bidSize ?? null,
    ask: noSentinel(q.askPrice),
    askSize: q.askSize ?? null,
    netChange: noSentinel(q.netChange),
    netPercentChange: noSentinel(q.netPercentChange),
    open: noSentinel(q.openPrice),
    dayHigh: noSentinel(q.highPrice),
    dayLow: noSentinel(q.lowPrice),
    previousClose: noSentinel(q.closePrice),
    week52High: noSentinel(q['52WeekHigh']),
    week52Low: noSentinel(q['52WeekLow']),
    volume: q.totalVolume ?? null,
    quoteTime: q.quoteTime ? stamp(q.quoteTime, true) : null,
    securityStatus: q.securityStatus || null,
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
        'Get OHLCV candles for a stock symbol, plus precomputed indicators (SMA 20/50/100/200/250, ' +
        'EMA 9/21, MACD line, RSI 14, ATR 14, range high/low, average volume). Call this for any ' +
        'charting, trend, candlestick-pattern, support/resistance, momentum or moving-average question — ' +
        'the data is live and cannot be answered from memory. Use the returned indicators rather than ' +
        'recomputing them by hand. Intraday intervals only work with a range in days.',
      inputSchema: {
        symbol: z.string().describe('Stock ticker, e.g. NVDA'),
        range: z
          .enum(Object.keys(RANGES))
          .optional()
          .describe(`How far back to look. Defaults to ${DEFAULT_RANGE}.`),
        interval: z
          .enum(Object.keys(INTERVALS))
          .optional()
          .describe(
            'Candle size. Minute intervals require a range of 1d-10d; daily and weekly work with any ' +
              'range; monthly only with years. Defaults to a sensible size for the range.'
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
            `Cap on candles listed, keeping the most recent. Defaults to ${DEFAULT_MAX_CANDLES}; raise ` +
              'it to read a long daily range bar by bar. Indicators never depend on this — they are ' +
              'computed over the full series regardless.'
          ),
      },
    },
    async ({ symbol, range, interval, extendedHours, maxCandles }) => {
      const ticker = symbol.toUpperCase();
      const rangeKey = range || DEFAULT_RANGE;
      const intervalKey = interval || defaultInterval(RANGES[rangeKey].periodType);

      try {
        const { data, candles, inRange, stats, frequencyType, reachedBack } = await fetchPriceHistory(
          ticker,
          rangeKey,
          intervalKey,
          extendedHours
        );

        const intraday = frequencyType === 'minute';
        const shown = inRange.slice(-(maxCandles || DEFAULT_MAX_CANDLES));

        return textResult({
          symbol: ticker,
          range: rangeKey,
          interval: intervalKey,
          extendedHours: Boolean(extendedHours),
          previousClose: data.previousClose,
          candlesInRange: inRange.length,
          candlesListed: shown.length,
          candlesFetched: candles.length,
          indicators: stats,
          indicatorNote: [
            `Moving averages, RSI and ATR are computed over all ${candles.length} ${intervalKey} candles fetched.`,
            reachedBack
              ? `That deliberately reaches back past the ${rangeKey} asked for, so the long averages are ` +
                `properly seeded; rangeHigh, rangeLow and the change cover the ${rangeKey} itself.`
              : null,
            shown.length < inRange.length
              ? `Only the most recent ${shown.length} of ${inRange.length} candles in range are listed; ` +
                'raise maxCandles to see the rest.'
              : null,
            'Prices are live from Schwab and may be delayed or stale outside market hours.',
          ]
            .filter(Boolean)
            .join(' '),
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
        if (err instanceof PriceHistoryError) return errorResult(err.message);
        if (err.message && err.message.startsWith('REAUTH_REQUIRED')) {
          return errorResult(
            'The Schwab login has expired. Visit /.netlify/functions/schwab-auth-start on the site to reconnect, then try again.'
          );
        }
        return errorResult(`Could not fetch price history: ${err.message}`);
      }
    }
  );

  server.registerTool(
    'get_quote',
    {
      title: 'Get a live quote',
      description:
        'Get a real-time bid/ask/last/mark quote for one or more stock symbols, plus day range, previous ' +
        'close, 52-week high/low and volume. Call this for a fast price check that does not need the ' +
        'full options chain or price history — e.g. "what is NVDA trading at" or "quote AAPL and MSFT". ' +
        'Reflects the last trade when the market is closed.',
      inputSchema: {
        symbols: z
          .union([z.string(), z.array(z.string()).min(1).max(20)])
          .describe('One ticker or an array of up to 20, e.g. "NVDA" or ["NVDA", "AAPL", "MSFT"].'),
      },
    },
    async ({ symbols }) => {
      try {
        const tickers = [...new Set((Array.isArray(symbols) ? symbols : [symbols]).map((s) => s.toUpperCase()))];
        const data = await schwabGet('quotes', { symbols: tickers.join(','), fields: 'quote,reference' });
        const quotes = tickers.map((t) => formatQuote(t, data[t]));
        const missing = quotes.filter((q) => q.error).map((q) => q.symbol);

        return textResult({
          quotes,
          quoteNote:
            'Live from Schwab. Prices are delayed or reflect the last trade outside market hours.' +
            (missing.length ? ` No data for: ${missing.join(', ')} — check the symbol.` : ''),
        });
      } catch (err) {
        if (err.message && err.message.startsWith('REAUTH_REQUIRED')) {
          return errorResult(
            'The Schwab login has expired. Visit /.netlify/functions/schwab-auth-start on the site to reconnect, then try again.'
          );
        }
        return errorResult(`Could not fetch quotes: ${err.message}`);
      }
    }
  );

  server.registerTool(
    'scan_watchlist',
    {
      title: 'Scan a watchlist for trend and moving-average status',
      description:
        'Run price-history indicators across multiple symbols at once and return a compact summary for ' +
        'each — last close, percent change over the range, SMA 20/50/100/200/250, RSI, MACD, range ' +
        'high/low, and a simple trend label. Call this when the person wants to screen several tickers at ' +
        'once instead of one at a time, e.g. "which of these are above their 200-day" or "scan my ' +
        'watchlist for RSI over 70". Up to 15 symbols per call; for one symbol use get_price_history ' +
        'instead, which also returns the underlying candles.',
      inputSchema: {
        symbols: z.array(z.string()).min(1).max(15).describe('Tickers to scan, e.g. ["NVDA", "AAPL", "MSFT"].'),
        range: z
          .enum(Object.keys(RANGES))
          .optional()
          .describe(`How far back each symbol's indicators look. Defaults to ${DEFAULT_RANGE}.`),
        interval: z
          .enum(Object.keys(INTERVALS))
          .optional()
          .describe('Candle size for the scan. Defaults to daily; weekly also makes sense for a longer view.'),
      },
    },
    async ({ symbols, range, interval }) => {
      const rangeKey = range || DEFAULT_RANGE;
      const intervalKey = interval || defaultInterval(RANGES[rangeKey].periodType);
      const tickers = [...new Set(symbols.map((s) => s.toUpperCase()))];

      const settled = await Promise.allSettled(
        tickers.map((ticker) => fetchPriceHistory(ticker, rangeKey, intervalKey, false))
      );

      let reauth = false;
      const results = settled.map((outcome, i) => {
        const ticker = tickers[i];
        if (outcome.status === 'fulfilled') {
          const { stats } = outcome.value;
          return {
            symbol: ticker,
            lastClose: stats.lastClose,
            changePercentOverRange: stats.changePercentOverRange,
            sma20: stats.sma20,
            sma50: stats.sma50,
            sma100: stats.sma100,
            sma200: stats.sma200,
            sma250: stats.sma250,
            rsi14: stats.rsi14,
            macd: stats.macd,
            rangeHigh: stats.rangeHigh,
            rangeLow: stats.rangeLow,
            trend: trendLabel(stats),
          };
        }

        const message = (outcome.reason && outcome.reason.message) || String(outcome.reason);
        if (message.startsWith('REAUTH_REQUIRED')) reauth = true;
        return { symbol: ticker, error: message.slice(0, 200) };
      });

      // A reauth failure is identical for every symbol in the batch — surface
      // it once rather than as 15 copies of the same error.
      if (reauth) {
        return errorResult(
          'The Schwab login has expired. Visit /.netlify/functions/schwab-auth-start on the site to reconnect, then try again.'
        );
      }

      return textResult({
        range: rangeKey,
        interval: intervalKey,
        scanned: tickers.length,
        results,
        note:
          'Live from Schwab. Prices may be delayed or stale outside market hours. trend compares last ' +
          'close against SMA50 and SMA200 — a quick starting point, not a signal.',
      });
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
