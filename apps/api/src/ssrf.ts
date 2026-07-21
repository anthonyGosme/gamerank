import { lookup } from 'node:dns/promises';
import net from 'node:net';

// Garde anti-SSRF pour les requêtes sortantes vers des URL fournies par les
// utilisateurs (vérification du snippet d'intégration). Sans ça, une URL comme
// http://localhost:8443 (admin Poste.io), http://127.0.0.1:3001 (Kuma) ou
// http://169.254.169.254 (métadonnées cloud) ferait taper le serveur sur des
// services internes du VPS. On refuse tout ce qui résout vers une IP non
// publique, et on suit les redirections en revalidant chaque saut.

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

function v4ToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
}

function inV4(ip: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (v4ToInt(base) & mask);
}

// Plages IPv4 non routables sur l'Internet public (RFC 1918/6598/5735/…).
function isPrivateV4(ip: string): boolean {
  const n = v4ToInt(ip);
  const ranges: Array<[string, number]> = [
    ['0.0.0.0', 8], // "this network"
    ['10.0.0.0', 8], // privé
    ['100.64.0.0', 10], // CGNAT
    ['127.0.0.0', 8], // loopback
    ['169.254.0.0', 16], // link-local (dont 169.254.169.254 métadonnées)
    ['172.16.0.0', 12], // privé
    ['192.0.0.0', 24], // IETF protocol assignments
    ['192.0.2.0', 24], // TEST-NET-1
    ['192.88.99.0', 24], // 6to4 relay anycast
    ['192.168.0.0', 16], // privé
    ['198.18.0.0', 15], // benchmarking
    ['198.51.100.0', 24], // TEST-NET-2
    ['203.0.113.0', 24], // TEST-NET-3
    ['224.0.0.0', 4], // multicast
    ['240.0.0.0', 4], // réservé
    ['255.255.255.255', 32], // broadcast
  ];
  return ranges.some(([base, bits]) => inV4(n, base, bits));
}

// Décompose une IPv6 (y compris `::` et suffixe IPv4 embarqué) en 8 hextets.
function hextetsOf(ip: string): number[] | null {
  if (net.isIP(ip) !== 6) return null;
  let str = ip;
  // Suffixe IPv4 embarqué (::ffff:a.b.c.d, 64:ff9b::a.b.c.d) → 2 hextets.
  if (str.includes('.')) {
    const colon = str.lastIndexOf(':');
    const v4 = str.slice(colon + 1).split('.').map(Number);
    const h1 = ((v4[0] << 8) | v4[1]).toString(16);
    const h2 = ((v4[2] << 8) | v4[3]).toString(16);
    str = `${str.slice(0, colon + 1)}${h1}:${h2}`;
  }
  const hasGap = str.includes('::');
  const [head, tail = ''] = str.split('::');
  const headParts = head ? head.split(':').filter(Boolean) : [];
  const tailParts = tail ? tail.split(':').filter(Boolean) : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0 || (!hasGap && missing !== 0)) return null;
  const full = [...headParts, ...Array(hasGap ? missing : 0).fill('0'), ...tailParts];
  if (full.length !== 8) return null;
  return full.map((h) => parseInt(h || '0', 16));
}

function embeddedV4(h: number[]): string {
  return `${(h[6] >> 8) & 0xff}.${h[6] & 0xff}.${(h[7] >> 8) & 0xff}.${h[7] & 0xff}`;
}

function isPrivateV6(ip: string): boolean {
  const h = hextetsOf(ip);
  if (!h) return true; // parse impossible → on refuse par prudence
  if (h.every((x) => x === 0)) return true; // :: (unspecified)
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1 loopback
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // 2001:db8::/32 doc
  // IPv4-mapped ::ffff:0:0/96 → tester la v4 embarquée
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
    return isPrivateV4(embeddedV4(h));
  }
  // NAT64 64:ff9b::/96 → idem
  if (h[0] === 0x0064 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) {
    return isPrivateV4(embeddedV4(h));
  }
  return false;
}

function isPublicAddress(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) return !isPrivateV4(ip);
  if (fam === 6) return !isPrivateV6(ip);
  return false; // pas une IP valide → refuse
}

interface GuardOptions {
  // En dev/test on autorise le privé (faux serveurs locaux, intégration en
  // local). En prod ce doit être false pour fermer la SSRF.
  allowPrivate?: boolean;
}

// Valide une URL avant de la requêter : schéma http(s) + toutes les IP de
// résolution doivent être publiques. Lève SsrfError sinon.
export async function assertSafeUrl(rawUrl: string, opts: GuardOptions = {}): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfError('invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfError(`unsupported scheme: ${parsed.protocol}`);
  }
  if (opts.allowPrivate) return;

  const host = parsed.hostname.replace(/^\[|\]$/g, ''); // retire les crochets IPv6
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new SsrfError('host does not resolve');
  }
  if (addresses.length === 0) throw new SsrfError('host does not resolve');
  for (const { address } of addresses) {
    if (!isPublicAddress(address)) {
      throw new SsrfError(`resolves to a non-public address (${address})`);
    }
  }
}

type SafeFetchInit = RequestInit & GuardOptions & { maxRedirects?: number };

// fetch() durci : valide l'URL, puis suit les redirections manuellement en
// revalidant chaque saut (une page publique ne peut pas rediriger vers l'interne).
export async function safeFetch(rawUrl: string, init: SafeFetchInit = {}): Promise<Response> {
  const { allowPrivate = false, maxRedirects = 3, ...rest } = init;
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertSafeUrl(current, { allowPrivate });
    const res = await fetch(current, { ...rest, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return res;
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new SsrfError('too many redirects');
}
