// Fonctions pures du scoring (CDC §4-§8) — testables sans base.

// Borne inférieure de Wilson à 95 % (CDC §7.2) : « quel taux d'approbation
// peut-on garantir avec ce volume de votes ? »
export function wilsonLowerBound(positive: number, total: number, z = 1.96): number | null {
  if (total === 0) return null;
  const p = positive / total;
  const z2 = z * z;
  const numerator = p + z2 / (2 * total) - z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
  return numerator / (1 + z2 / total);
}

// Correction de confiance (CDC §7.3) : ramène une observation vers le prior
// global proportionnellement à la taille de son échantillon.
export function shrink(observed: number, sample: number, prior: number, k: number): number {
  if (sample <= 0) return prior;
  return prior + (sample / (sample + k)) * (observed - prior);
}

// Rangs percentiles 0-100 (0 = dernier, 100 = premier), ex æquo moyennés.
// Un seul jeu → 50 (position médiane par convention).
export function percentileRanks(values: Array<[string, number]>): Map<string, number> {
  const result = new Map<string, number>();
  if (values.length === 0) return result;
  if (values.length === 1) {
    result.set(values[0][0], 50);
    return result;
  }
  const sorted = [...values].sort((a, b) => a[1] - b[1]);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1][1] === sorted[i][1]) j++;
    const rank = ((i + j) / 2 / (sorted.length - 1)) * 100;
    for (let k = i; k <= j; k++) result.set(sorted[k][0], rank);
    i = j + 1;
  }
  return result;
}

export interface PrefixLevel {
  v4: number;
  v6: number;
  exponent: number;
}

// Normalise une adresse reçue : les IPv4-mappées (::ffff:81.2.3.4, que
// renvoie un socket dual-stack pour un client IPv4) redeviennent de l'IPv4,
// et la zone (%en0) est retirée.
export function normalizeIp(ip: string): { family: 4 | 6; value: string } | null {
  const clean = (ip ?? '').trim().toLowerCase().split('%')[0];
  if (!clean) return null;
  const mapped = /^(?:::ffff:)([0-9.]+)$/.exec(clean);
  const candidate = mapped ? mapped[1] : clean;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(candidate)) {
    const octets = candidate.split('.').map(Number);
    if (octets.some((o) => o > 255)) return null;
    return { family: 4, value: candidate };
  }
  return clean.includes(':') ? { family: 6, value: clean } : null;
}

// Développe une IPv6 (y compris compressée ::) en 8 groupes de 16 bits.
function ipv6Groups(ip: string): number[] | null {
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const filler = Array(Math.max(0, 8 - head.length - tail.length)).fill('0');
  const groups = [...head, ...filler, ...tail];
  if (groups.length !== 8) return null;
  return groups.map((group) => parseInt(group || '0', 16) & 0xffff);
}

// Préfixe réseau d'une IP au nombre de bits demandé.
// IPv4 : /8 /16 /20 /24 /32 ; IPv6 : /32 /48 /56 /64 /128.
export function ipPrefix(ip: string, level: PrefixLevel): string {
  const normalized = normalizeIp(ip);
  if (!normalized) return `raw:${ip}`;

  if (normalized.family === 4) {
    const octets = normalized.value.split('.').map(Number);
    const asInt = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
    const bits = Math.min(32, level.v4);
    const masked = bits === 0 ? 0 : (asInt & (bits === 32 ? 0xffffffff : ~0 << (32 - bits))) >>> 0;
    return `v4/${bits}:${masked}`;
  }

  const groups = ipv6Groups(normalized.value);
  if (!groups) return `raw:${normalized.value}`;
  const bits = Math.min(128, level.v6);
  const kept: number[] = [];
  for (let i = 0; i < 8; i++) {
    const groupBits = Math.min(16, Math.max(0, bits - i * 16));
    kept.push(groupBits === 0 ? 0 : groups[i] & ((0xffff << (16 - groupBits)) & 0xffff));
  }
  return `v6/${bits}:${kept.join(':')}`;
}

// Visiteurs effectifs d'un jour (CDC §4.1) : pour chaque niveau de préfixe,
// somme des n^α par préfixe ; on retient le niveau le plus restrictif.
// 100 visiteurs depuis la même /24 ≈ 20 ; 100 IP toutes distinctes ≈ 100.
export function effectiveVisitors(
  ipCounts: Map<string, number>,
  levels: PrefixLevel[],
): number {
  let minimum = Infinity;
  for (const level of levels) {
    const perPrefix = new Map<string, number>();
    for (const [ip, count] of ipCounts) {
      const prefix = ipPrefix(ip, level);
      perPrefix.set(prefix, (perPrefix.get(prefix) ?? 0) + count);
    }
    let total = 0;
    for (const count of perPrefix.values()) total += Math.pow(count, level.exponent);
    minimum = Math.min(minimum, total);
  }
  return Number.isFinite(minimum) ? minimum : 0;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Échelle absolue logarithmique 0-100 sur une borne de référence fixe.
export function absoluteLog(value: number, referenceMax: number): number {
  if (value <= 0) return 0;
  return clamp((Math.log1p(value) / Math.log1p(referenceMax)) * 100, 0, 100);
}

// Échelle absolue linéaire 0-100 sur une borne de référence fixe.
export function absoluteLinear(value: number, referenceMax: number): number {
  return clamp((value / referenceMax) * 100, 0, 100);
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
