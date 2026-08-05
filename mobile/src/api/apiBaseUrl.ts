const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

export function validateApiBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('A valid HTTPS API base URL is required.');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    LOCAL_HOSTS.has(parsed.hostname.toLowerCase()) ||
    parsed.hostname.toLowerCase().endsWith('.localhost')
  ) {
    throw new TypeError('A non-local HTTPS API base URL is required.');
  }
  return parsed.origin;
}
