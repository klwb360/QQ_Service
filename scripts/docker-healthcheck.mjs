import http from 'node:http';

// Healthchecks run inside the container, so use the internal port and Host.
// Do not require a QQ login, API key or external service to report readiness.
const port = Number(process.env.QQ_DASHBOARD_PORT || 3210);
const request = http.get({ hostname: '127.0.0.1', port, path: '/api/accounts', timeout: 4000 }, response => {
  let body = '';
  response.setEncoding('utf8');
  response.on('data', chunk => {
    body += chunk;
    if (body.length > 1024 * 1024) response.destroy(new Error('Health response too large.'));
  });
  response.on('error', () => process.exit(1));
  response.on('end', () => {
    try {
      const data = JSON.parse(body);
      process.exit(response.statusCode === 200 && Array.isArray(data.accounts) ? 0 : 1);
    } catch { process.exit(1); }
  });
});
request.on('timeout', () => request.destroy(new Error('Healthcheck timed out.')));
request.on('error', () => process.exit(1));
