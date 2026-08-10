// schwab-callback.js
// This is your SCHWAB_REDIRECT_URI / callback URL, registered exactly as
// https://your-site.netlify.app/.netlify/functions/schwab-callback
// in the Developer Portal app settings.
//
// Schwab redirects here after you log in, with ?code=... in the query string.
// This function grabs it, exchanges it for tokens, and stores them.
// No more copy-pasting codes out of a broken browser page.

const { saveInitialTokens } = require('./schwab-token-manager');

exports.handler = async (event) => {
  const code = event.queryStringParameters && event.queryStringParameters.code;

  if (!code) {
    return {
      statusCode: 400,
      body: 'No authorization code found in the callback URL.',
    };
  }

  try {
    await saveInitialTokens(decodeURIComponent(code));
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: '<h2>Connected.</h2><p>Tokens saved. You can close this tab.</p>',
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: `Token exchange failed: ${err.message}`,
    };
  }
};
