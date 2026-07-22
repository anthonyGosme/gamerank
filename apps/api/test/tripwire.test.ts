import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mix, tripwireOk } from '../src/tripwire.js';
import { config } from '../src/config.js';

test('mix est déterministe et dépend de l’entrée', () => {
  assert.equal(mix('abc'), mix('abc'));
  assert.notEqual(mix('abc'), mix('abd'));
  assert.match(mix('abc'), /^[0-9a-f]+$/); // hex
});

test('tripwireOk : vrai pour ctx = mix(token+salt), faux sinon', () => {
  const token = 'tok_123';
  const salt = config.tripwireSalts[0];
  assert.equal(tripwireOk(token, mix(token + salt)), true);
  assert.equal(tripwireOk(token, 'nope'), false);
  assert.equal(tripwireOk(token, undefined), false);
  assert.equal(tripwireOk(token, ''), false);
  // ctx calculé pour un AUTRE token → faux
  assert.equal(tripwireOk(token, mix('autre' + salt)), false);
});
