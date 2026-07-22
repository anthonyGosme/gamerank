import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allow } from '../src/ratelimit.js';

test('rate-limit : bloque au-delà du max dans la fenêtre, quota par IP, reset', () => {
  const store = new Map();
  const max = 3;
  const win = 1000;
  let now = 0;

  // 3 premières requêtes de ip1 : OK
  assert.equal(allow(store, 'ip1', max, win, now), true);
  assert.equal(allow(store, 'ip1', max, win, now), true);
  assert.equal(allow(store, 'ip1', max, win, now), true);
  // 4e : refusée
  assert.equal(allow(store, 'ip1', max, win, now), false);

  // ip2 a son propre quota, indépendant
  assert.equal(allow(store, 'ip2', max, win, now), true);

  // Après la fenêtre → reset de ip1
  now += win;
  assert.equal(allow(store, 'ip1', max, win, now), true);
});
