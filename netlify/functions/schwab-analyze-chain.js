// schwab-analyze-chain.js
// Pulls one expiration's chain from Schwab, hands it to Claude, and returns a
// single strike pick with the reasoning behind it.
// Call it like: /.netlify/functions/schwab-analyze-chain?symbol=NVDA&exp=2026-08-10:1
//
// Required environment variables (in addition to the SCHWAB_* ones):
//   ANTHROPIC_API_KEY - from console.anthropic.com

const Anthropic = require('@anthropic-ai/sdk');
const { getValidAccessToken } = require('./schwab-token-manager');

// Keep the payload tight: only strikes near the money are worth reasoning about,
// and a full chain is mostly far-OTM noise.
const STRIKE_WINDOW = 18;

const PICK_SCHEMA = {
  type: 'object',
  properties: {
    strike: { type: 'number' },
    side: { type: 'string', enum: ['CALL', 'PUT'] },
    rationale: { type: 'string' },
    risks: { type: 'string' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['strike', 'side', 'rationale', 'risks', 'confidence'],
  additionalProperties: false,
};

function condenseChain(data, expKey) {
  const calls = (data.callExpDateMap && data.callExpDateMap[expKey]) || {};
  const puts = (data.putExpDateMap && data.putExpDateMap[expKey]) || {};
  const underlying = data.underlyingPrice || 0;

  const strikes = Object.keys(calls).map(Number).sort((a, b) => a - b);
  if (!strikes.length) return null;

  // Center the window on the strike closest to spot.
  let atmIdx = 0;
  strikes.forEach((s, i) => {
    if (Math.abs(s - underlying) < Math.abs(strikes[atmIdx] - underlying)) atmIdx = i;
  });
  const start = Math.max(0, atmIdx - STRIKE_WINDOW);
  const end = Math.min(strikes.length, atmIdx + STRIKE_WINDOW + 1);

  const pick = (contract) => {
    if (!contract) return null;
    return {
      bid: contract.bid,
      ask: contract.ask,
      last: contract.last,
      delta: contract.delta,
      iv: contract.volatility,
      theta: contract.theta,
      vega: contract.vega,
      oi: contract.openInterest,
      vol: contract.totalVolume,
    };
  };

  return {
    underlyingPrice: underlying,
    expiration: expKey,
    strikes: strikes.slice(start, end).map((strike) => {
      const key = strike.toFixed(1);
      return {
        strike,
        call: pick((calls[key] || calls[String(strike)] || [])[0]),
        put: pick((puts[key] || puts[String(strike)] || [])[0]),
      };
    }),
  };
}

const SYSTEM_PROMPT = `You are an options analyst. You are given one expiration of a live options chain and asked which single contract is the most sensible pick.

Work from what the data actually shows: moneyness relative to spot, the bid/ask spread as a liquidity signal, open interest and volume, delta as directional exposure and rough probability, IV for whether premium is rich or cheap, and theta against the time remaining.

Pick exactly one strike and side that appears in the data. Ground the rationale in the specific numbers for that contract and say why it beats the neighbouring strikes — not generic options theory. Be concrete and brief. Name the real risks, including what has to happen for the trade to lose.

This is analysis of market data for the person's own decision-making, not personalized investment advice, and you have no knowledge of their portfolio, risk tolerance, or goals. Do not tell them to place a trade.`;

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const symbol = (params.symbol || '').trim().toUpperCase();
  const exp = params.exp || '';
  const thesis = (params.thesis || '').slice(0, 500);

  if (!symbol) return { statusCode: 400, body: 'Missing ?symbol=' };
  if (!exp) return { statusCode: 400, body: 'Missing ?exp=' };
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      body: 'ANTHROPIC_API_KEY is not set. Add it in Netlify → Site configuration → Environment variables, then redeploy.',
    };
  }

  try {
    const accessToken = await getValidAccessToken();

    const url = `https://api.schwabapi.com/marketdata/v1/chains?symbol=${encodeURIComponent(symbol)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

    if (!res.ok) {
      const text = await res.text();
      return { statusCode: res.status, body: text };
    }

    const condensed = condenseChain(await res.json(), exp);
    if (!condensed) {
      return { statusCode: 404, body: `No strikes found for expiration ${exp}.` };
    }

    const anthropic = new Anthropic();

    const message = await anthropic.messages.create({
      model: 'claude-opus-5',
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: PICK_SCHEMA },
      },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                `Symbol: ${symbol}\n` +
                `Underlying price: ${condensed.underlyingPrice}\n` +
                `Expiration: ${condensed.expiration}\n` +
                (thesis ? `The person's stated thesis: ${thesis}\n` : 'No thesis given — evaluate both calls and puts on the merits.\n') +
                `\nChain data (JSON; prices in dollars, iv in percent):\n` +
                JSON.stringify(condensed.strikes),
            },
          ],
        },
      ],
    });

    if (message.stop_reason === 'refusal') {
      return { statusCode: 422, body: 'The model declined to analyze this chain.' };
    }

    const textBlock = message.content.find((b) => b.type === 'text');
    if (!textBlock) {
      return { statusCode: 502, body: 'No analysis returned.' };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: textBlock.text,
    };
  } catch (err) {
    if (err.message && err.message.startsWith('REAUTH_REQUIRED')) {
      return {
        statusCode: 401,
        body: 'Login expired. Visit /.netlify/functions/schwab-auth-start to reconnect.',
      };
    }
    return { statusCode: 500, body: err.message };
  }
};
