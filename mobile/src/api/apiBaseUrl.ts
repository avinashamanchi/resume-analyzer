function parseIpv4(hostname: string): readonly [number, number, number, number] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part))) return null;
  const values = parts.map(Number);
  if (values.some((value) => value > 255)) return null;
  return values as [number, number, number, number];
}

function isForbiddenIpv4(values: readonly [number, number, number, number]): boolean {
  const [first, second, third] = values;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) ||
    (first === 203 && second === 0 && third === 113)
  );
}

function parseIpv6(hostname: string): number[] | null {
  let value = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (value.includes('.')) {
    const separator = value.lastIndexOf(':');
    if (separator < 0) return null;
    const ipv4 = parseIpv4(value.slice(separator + 1));
    if (ipv4 === null) return null;
    value = `${value.slice(0, separator)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const doubleColon = value.indexOf('::');
  if (doubleColon !== value.lastIndexOf('::')) return null;
  const left = doubleColon < 0 ? value : value.slice(0, doubleColon);
  const right = doubleColon < 0 ? '' : value.slice(doubleColon + 2);
  const leftParts = left ? left.split(':') : [];
  const rightParts = right ? right.split(':') : [];
  const parts = [...leftParts, ...rightParts];
  if (parts.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  if (doubleColon < 0 && parts.length !== 8) return null;
  if (doubleColon >= 0 && parts.length >= 8) return null;
  const missing = 8 - parts.length;
  return [
    ...leftParts.map((part) => Number.parseInt(part, 16)),
    ...Array.from({ length: missing }, () => 0),
    ...rightParts.map((part) => Number.parseInt(part, 16)),
  ];
}

function isForbiddenIpv6(hostname: string): boolean {
  const values = parseIpv6(hostname);
  if (values === null) return true;
  const allZero = values.every((value) => value === 0);
  const loopback = values.slice(0, 7).every((value) => value === 0) && values[7] === 1;
  const uniqueLocal = (values[0] & 0xfe00) === 0xfc00;
  const linkLocal = (values[0] & 0xffc0) === 0xfe80;
  const multicast = (values[0] & 0xff00) === 0xff00;
  const documentation = values[0] === 0x2001 && values[1] === 0x0db8;
  const ipv4Mapped = values.slice(0, 5).every((value) => value === 0) && values[5] === 0xffff;
  const ipv4Compatible = values.slice(0, 6).every((value) => value === 0);
  const embeddedIpv4 = (): boolean => {
    const ipv4: [number, number, number, number] = [
      values[6] >> 8,
      values[6] & 0xff,
      values[7] >> 8,
      values[7] & 0xff,
    ];
    return isForbiddenIpv4(ipv4);
  };
  return (
    allZero ||
    loopback ||
    uniqueLocal ||
    linkLocal ||
    multicast ||
    documentation ||
    ((ipv4Mapped || ipv4Compatible) && embeddedIpv4())
  );
}

function canonicalHostname(hostname: string): string {
  const trimmed = hostname.toLowerCase().replace(/\.+$/, '');
  if (!trimmed) throw new TypeError('A non-local HTTPS API base URL is required.');
  const ipv4 = parseIpv4(trimmed);
  if (ipv4 !== null && isForbiddenIpv4(ipv4)) {
    throw new TypeError('A non-local HTTPS API base URL is required.');
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']') && isForbiddenIpv6(trimmed)) {
    throw new TypeError('A non-local HTTPS API base URL is required.');
  }
  if (trimmed === 'localhost' || trimmed.endsWith('.localhost')) {
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
  const host = hostname.startsWith('[') ? hostname : hostname;
  return `https://${host}${parsed.port ? `:${parsed.port}` : ''}`;
}
