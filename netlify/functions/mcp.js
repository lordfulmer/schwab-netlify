// mcp.js
// An MCP server exposing your live Schwab options chain as tools, so Claude can
// pull the chain itself instead of you pasting it in. Add the URL as a custom
// connector in claude.ai and it runs under your subscription, not API billing.
//
// Served at:  https://YOUR-SITE.netlify.app/mcp?key=YOUR_SECRET
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

async function fetchChain(symbol) {
  const accessToken = await getValidAccessToken();
  const url = `https://api.schwabapi.com/marketdata/v1/chains?symbol=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

  if (!res.ok) {
    throw new Error(`Schwab returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

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
