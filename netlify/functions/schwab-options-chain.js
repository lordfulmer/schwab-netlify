// schwab-options-chain.js
// Example: pull an options chain for a symbol.
// Call it like: /.netlify/functions/schwab-options-chain?symbol=NVDA
//
// This is the template for any other Schwab Market Data pull (quotes,
// price history for your SMA screener, etc.) — swap the URL and params.

const { getValidAccessToken } = require('./schwab-token-manager');

exports.handler = async (event) => {
  const symbol = (event.queryStringParameters && event.queryStringParameters.symbol) || '';

  if (!symbol) {
    return { statusCode: 400, body: 'Missing ?symbol=' };
  }

  try {
    const accessToken = await getValidAccessToken();

    const url = `https://api.schwabapi.com/marketdata/v1/chains?symbol=${encodeURIComponent(symbol)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const text = await res.text();
      return { statusCode: res.status, body: text };
    }

    const data = await res.json();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (err) {
    if (err.message.startsWith('REAUTH_REQUIRED')) {
      return {
        statusCode: 401,
        body: 'Login expired. Visit /.netlify/functions/schwab-auth-start to reconnect.',
      };
    }
    return { statusCode: 500, body: err.message };
  }
};
