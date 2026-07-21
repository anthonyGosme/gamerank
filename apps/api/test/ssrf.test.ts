import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeUrl, safeFetch, SsrfError } from '../src/ssrf.js';

// Cibles internes qui DOIVENT être bloquées (mode prod : allowPrivate=false).
// On n'utilise que des IP littérales et `localhost` → résolution locale, pas de
// réseau, donc déterministe hors-ligne.
const BLOCKED = [
  'http://127.0.0.1/', // loopback
  'http://127.0.0.1:8443/', // admin Poste.io en loopback
  'http://localhost/', // résout vers 127.0.0.1 / ::1
  'http://169.254.169.254/latest/meta-data/', // métadonnées cloud
  'http://169.254.169.254/', // link-local
  'http://10.0.0.1/', // privé
  'http://172.16.0.1/', // privé
  'http://172.31.255.255/', // privé (haut de la plage /12)
  'http://192.168.1.1/', // privé
  'http://100.64.0.1/', // CGNAT
  'http://0.0.0.0/', // "this network"
  'http://[::1]/', // loopback IPv6
  'http://[::ffff:127.0.0.1]/', // IPv4-mapped loopback
  'http://[fc00::1]/', // unique-local IPv6
  'http://[fe80::1]/', // link-local IPv6
];

// Schémas non http(s) → refusés d'office.
const BAD_SCHEMES = ['ftp://example.com/', 'file:///etc/passwd', 'gopher://127.0.0.1/'];

// Adresses publiques (littérales) qui DOIVENT passer la validation.
const ALLOWED = [
  'http://1.1.1.1/',
  'http://8.8.8.8/',
  'https://93.184.216.34/', // example.com
  'http://[2606:4700:4700::1111]/', // Cloudflare DNS (IPv6 public)
];

for (const url of BLOCKED) {
  test(`SSRF bloqué : ${url}`, async () => {
    await assert.rejects(() => assertSafeUrl(url), SsrfError);
  });
}

for (const url of BAD_SCHEMES) {
  test(`schéma refusé : ${url}`, async () => {
    await assert.rejects(() => assertSafeUrl(url), SsrfError);
  });
}

for (const url of ALLOWED) {
  test(`adresse publique acceptée : ${url}`, async () => {
    await assert.doesNotReject(() => assertSafeUrl(url));
  });
}

test('URL invalide → SsrfError', async () => {
  await assert.rejects(() => assertSafeUrl('not a url'), SsrfError);
});

test('allowPrivate=true (dev/test) laisse passer le loopback', async () => {
  await assert.doesNotReject(() => assertSafeUrl('http://127.0.0.1:1234/', { allowPrivate: true }));
});

test('allowPrivate=true refuse quand même un schéma non http(s)', async () => {
  await assert.rejects(() => assertSafeUrl('file:///etc/passwd', { allowPrivate: true }), SsrfError);
});

test('safeFetch rejette une cible interne AVANT toute connexion', async () => {
  // Port 9 (discard) : si le garde échouait, la connexion traînerait/échouerait
  // différemment ; ici on veut une SsrfError immédiate, pas une erreur réseau.
  await assert.rejects(
    () => safeFetch('http://127.0.0.1:9/', { allowPrivate: false }),
    SsrfError,
  );
});
