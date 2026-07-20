import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveVisitors, ipPrefix, normalizeIp } from '../src/scoring/math.js';
import { config } from '../src/config.js';
import { printTable } from './helpers.js';

const levels = config.scoring.prefixLevels;
const level = (v4: number) => levels.find((l) => l.v4 === v4)!;

// Détail du calcul niveau par niveau, pour voir lequel devient contraignant.
function explain(title: string, ips: string[]): number {
  const counts = new Map<string, number>();
  for (const ip of ips) counts.set(ip, (counts.get(ip) ?? 0) + 1);
  const rows = levels.map((l) => {
    const perPrefix = new Map<string, number>();
    for (const [ip, n] of counts) {
      const prefix = ipPrefix(ip, l);
      perPrefix.set(prefix, (perPrefix.get(prefix) ?? 0) + n);
    }
    let total = 0;
    for (const n of perPrefix.values()) total += Math.pow(n, l.exponent);
    return { label: `/${l.v4} (v6 /${l.v6})`, prefixes: perPrefix.size, exp: l.exponent, total };
  });
  const result = Math.min(...rows.map((r) => r.total));
  printTable(
    `${title} — ${ips.length} visiteurs bruts → ${result.toFixed(1)} comptés`,
    ['niveau', 'préfixes distincts', 'exposant', 'total', ''],
    rows.map((r) => [
      r.label,
      String(r.prefixes),
      r.exp.toFixed(2),
      r.total.toFixed(1),
      r.total === result ? '← retenu (minimum)' : '',
    ]),
  );
  return result;
}

test('une IPv4-mappée (socket dual-stack) est ramenée à de l’IPv4', () => {
  assert.deepEqual(normalizeIp('::ffff:81.2.3.4'), { family: 4, value: '81.2.3.4' });
  assert.deepEqual(normalizeIp('81.2.3.4'), { family: 4, value: '81.2.3.4' });
  // Donc elle est groupée comme l'IPv4 équivalente, pas comme de l'IPv6.
  assert.equal(ipPrefix('::ffff:81.2.3.4', level(24)), ipPrefix('81.2.3.4', level(24)));
});

test('IPv6 : la zone est ignorée et la forme compressée est développée', () => {
  assert.deepEqual(normalizeIp('2a01:e0a::1%en0'), { family: 6, value: '2a01:e0a::1' });
  // Même /64, écritures différentes → même préfixe.
  assert.equal(
    ipPrefix('2a01:0e0a:0000:0000:0000:0000:0000:0001', level(24)),
    ipPrefix('2a01:e0a::1', level(24)),
  );
});

test('les niveaux regroupent bien du plus large au plus fin', () => {
  const a = '81.2.3.4';
  const b = '81.2.3.200'; // même /24
  const c = '81.2.90.1'; // même /16, autre /24
  const d = '90.1.1.1'; // autre /8
  assert.equal(ipPrefix(a, level(24)), ipPrefix(b, level(24)));
  assert.notEqual(ipPrefix(a, level(24)), ipPrefix(c, level(24)));
  assert.equal(ipPrefix(a, level(16)), ipPrefix(c, level(16)));
  assert.notEqual(ipPrefix(a, level(8)), ipPrefix(d, level(8)));
  // /32 = l'adresse exacte.
  assert.notEqual(ipPrefix(a, level(32)), ipPrefix(b, level(32)));
});

test('un foyer IPv6 qui fait tourner ses adresses dans un /64 ne triche pas', () => {
  const rotated = explain(
    'IPv6 — 200 adresses tournantes dans UN SEUL /64 (extensions de confidentialité)',
    Array.from({ length: 200 }, (_, i) => `2a01:e0a:1:2:${i.toString(16)}::1`),
  );
  const dispersed = explain(
    'IPv6 — 200 foyers distincts (/48 différents)',
    Array.from({ length: 200 }, (_, i) => `2a01:${i.toString(16)}::1`),
  );
  console.log(
    `    → un foyer unique pèse ${rotated.toFixed(1)} contre ${dispersed.toFixed(1)} pour 200 vrais foyers\n`,
  );
  assert.ok(rotated < 40, `un seul /64 devrait peser peu, obtenu ${rotated.toFixed(1)}`);
  assert.ok(dispersed > rotated * 2, `dispersé doit dominer un /64 unique`);
});

test('IPv4 — concentration sur une /24 contre trafic dispersé', () => {
  const concentrated = explain(
    'IPv4 — 100 visiteurs, tous dans 10.1.1.0/24',
    Array.from({ length: 100 }, (_, i) => `10.1.1.${i}`),
  );
  const dispersed = explain(
    'IPv4 — 100 visiteurs répartis sur 50 blocs /8',
    Array.from({ length: 100 }, (_, i) => `${20 + (i % 50)}.${i}.7.9`),
  );
  console.log(
    `    → même nombre de visiteurs bruts : ${concentrated.toFixed(1)} comptés si concentrés,` +
      ` ${dispersed.toFixed(1)} si dispersés\n`,
  );
  assert.ok(concentrated < dispersed / 3);
});

test('partage inter-jeux : une IP active sur 10 jeux ne vaut pas 10 joueurs', () => {
  const gamma = config.scoring.crossGameExponent;
  const ip = '81.2.3.4';
  const onOneGame = effectiveVisitors(new Map([[ip, 1]]), levels, {
    globalIpCounts: new Map([[ip, 1]]),
    crossGameExponent: gamma,
  });
  const onTenGames = effectiveVisitors(new Map([[ip, 1]]), levels, {
    globalIpCounts: new Map([[ip, 10]]),
    crossGameExponent: gamma,
  });
  console.log(
    `    IP fidèle à 1 jeu : ${onOneGame.toFixed(2)} visiteur compté (inchangé)\n` +
      `    même IP répartie sur 10 jeux : ${onTenGames.toFixed(2)} par jeu` +
      ` → total plateforme ${(10 * onTenGames).toFixed(1)} au lieu de 10\n` +
      `    (γ = ${gamma} : part = (local/global)^${(1 - gamma).toFixed(1)})`,
  );
  assert.equal(onOneGame, 1, 'une IP mono-jeu ne doit subir aucune décote');
  assert.ok(onTenGames > 0.3 && onTenGames < 0.7, `attendu ≈ 0,5, obtenu ${onTenGames.toFixed(2)}`);
  assert.ok(10 * onTenGames < 7, 'le total plateforme doit rester nettement sous 10');
});

test('IPv4 et IPv6 se mélangent sans se confondre', () => {
  const mixed = new Map<string, number>([
    ['81.2.3.4', 1],
    ['::ffff:81.2.3.4', 1], // même machine vue en dual-stack
    ['2a01:e0a:1:2::1', 1],
  ]);
  // Les deux premières partagent le même /32 v4 → pas 3 visiteurs pleins.
  assert.ok(effectiveVisitors(mixed, levels) < 3);
});
