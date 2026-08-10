// schwab-auth-start.js
// Visit this endpoint in your browser to kick off the one-time (or weekly) login.
// e.g. https://your-site.netlify.app/.netlify/functions/schwab-auth-start

exports.handler = async () => {
  const params = new URLSearchParams({
    client_id: process.env.SCHWAB_APP_KEY,
    redirect_uri: process.env.SCHWAB_REDIRECT_URI,
  });

  const authUrl = `https://api.schwabapi.com/v1/oauth/authorize?${params.toString()}`;

  return {
    statusCode: 302,
    headers: {
      Location: authUrl,
    },
    body: '',
  };
};
