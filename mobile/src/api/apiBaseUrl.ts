function canonicalHostname(hostname: string): string {
  const trimmed = hostname.toLowerCase().replace(/\.+$/, '');
  if (!trimmed) throw new TypeError('A non-local HTTPS API base URL is required.');

  // URL already canonicalizes decimal, hexadecimal, octal, and single-number
  // IPv4 spellings. Reject all literals instead of maintaining a CIDR allowlist.
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    throw new TypeError('An HTTPS hostname API base URL is required.');
  }
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(trimmed)) {
    throw new TypeError('An HTTPS hostname API base URL is required.');
  }
  if (
    trimmed === 'localhost' ||
    trimmed.endsWith('.localhost') ||
    trimmed.endsWith('.local') ||
    trimmed.endsWith('.internal')
  ) {
    throw new TypeError('A non-local HTTPS API base URL is required.');
  }
  return trimmed;
}

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
    parsed.hash
  ) {
    throw new TypeError('A non-local HTTPS API base URL is required.');
  }
  const hostname = canonicalHostname(parsed.hostname);
  return `https://${hostname}${parsed.port ? `:${parsed.port}` : ''}`;
}
