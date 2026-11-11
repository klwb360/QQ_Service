// Desktop connections stay on loopback. Container deployments must explicitly
// name the external OneBot services they trust; these are never form fields.
export function onebotHosts() {
  const hosts = ['127.0.0.1', 'localhost', '[::1]'];
  if (process.env.QQ_SERVICE_CONTAINER === '1') {
    for (const value of (process.env.QQ_SERVICE_ONEBOT_HOSTS || '').split(',')) {
      const host = value.trim().toLowerCase();
      if (host && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) hosts.push(host);
    }
  }
  return [...new Set(hosts)];
}

export const isContainer = () => process.env.QQ_SERVICE_CONTAINER === '1';

export function publicOrigins() {
  if (!isContainer()) return [];
  return (process.env.QQ_SERVICE_PUBLIC_ORIGIN || '').split(',').map(value => {
    if (!value.trim()) return null;
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('QQ_SERVICE_PUBLIC_ORIGIN 必须为无路径和凭据的 HTTP(S) 来源列表。');
    }
    return url.origin;
  }).filter(Boolean);
}
