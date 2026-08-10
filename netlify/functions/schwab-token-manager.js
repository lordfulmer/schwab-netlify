// schwab-token-manager.js
// Shared helper used by every other function that needs to call the Schwab API.
// Handles: reading stored tokens, refreshing when the access token is stale,
// and saving the refreshed pair back to Netlify Blobs.
//
// Required environment variables (set in Netlify site settings):
//   SCHWAB_APP_KEY      - your App Key from the Developer Portal
//   SCHWAB_APP_SECRET   - your Secret from the Developer Portal
//   SCHWAB_REDIRECT_URI - must exactly match the callback URL on your app

const { getStore } = require('@netlify/blobs');

const TOKEN_KEY = 'schwab-tokens';
const TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';

function getStoreClient() {
  // Netlify Blobs auto-detection sometimes fails even in production.
  // Passing siteID + token explicitly is the documented workaround.
  if (process.env.NETLIFY_SITE_ID && process.env.NETLIFY_API_TOKEN) {
    return getStore({
      name: 'schwab-auth',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });
  }
  return getStore('schwab-auth');
}

function basicAuthHeader() {
  const creds = `${process.env.SCHWAB_APP_KEY}:${process.env.SCHWAB_APP_SECRET}`;
  return 'Basic ' + Buffer.from(creds).toString('base64');
}

// Called by schwab-callback.js after the one-time browser login.
async function saveInitialTokens(authCode) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: authCode,
    redirect_uri: process.env.SCHWAB_REDIRECT_URI,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }

  const tokens = await res.json();
  await storeTokens(tokens);
  return tokens;
}

async function storeTokens(tokens) {
  const store = getStoreClient();
  const payload = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    // access tokens last ~30 min; refresh a bit early to be safe
    expires_at: Date.now() + (tokens.expires_in - 60) * 1000,
    refreshed_at: Date.now(),
  };
  await store.setJSON(TOKEN_KEY, payload);
  return payload;
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    // This is the "refresh token expired, need to re-login" case (~weekly)
    throw new Error(`REAUTH_REQUIRED: ${res.status} ${text}`);
  }

  const tokens = await res.json();
  return storeTokens(tokens);
}

// A single invocation can now issue several Schwab calls in parallel (a
// watchlist scan). Without this, every one of them would see the same expired
// token and fire its own refresh_token grant — and Schwab rotates refresh
// tokens, so only the first would succeed and the rest would fail with a
// spurious REAUTH_REQUIRED. Concurrent callers within one invocation instead
// share a single in-flight refresh.
let refreshPromise = null;

// Main entry point: call this from any function that needs to hit the Schwab API.
// Returns a valid, unexpired access token, refreshing automatically if needed.
async function getValidAccessToken() {
  const store = getStoreClient();
  const stored = await store.get(TOKEN_KEY, { type: 'json' });

  if (!stored) {
    throw new Error('REAUTH_REQUIRED: no tokens found, run /schwab-auth-start first');
  }

  if (Date.now() < stored.expires_at) {
    return stored.access_token;
  }

  if (!refreshPromise) {
    refreshPromise = refreshAccessToken(stored.refresh_token).finally(() => {
      refreshPromise = null;
    });
  }
  const refreshed = await refreshPromise;
  return refreshed.access_token;
}

module.exports = {
  saveInitialTokens,
  getValidAccessToken,
};
