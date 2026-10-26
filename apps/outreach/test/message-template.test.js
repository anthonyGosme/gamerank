import assert from 'node:assert/strict';
import test from 'node:test';
import { createOutreachMessage } from '../src/message-template.js';

test('prépare un objet et un message personnalisé avec une seule URL', () => {
  const result = createOutreachMessage({ gameTitle: 'Pushdle' });

  assert.equal(result.subject, 'Add Pushdle to WebGameRank?');
  assert.match(result.body, /I discovered Pushdle through r\/playmygame\./);
  assert.match(result.body, /using 9 quality signals/);
  assert.match(result.body, /playtime, community votes, and repeat visits/);
  assert.match(result.body, /lightweight integration snippet/);
  assert.match(result.body, /measures real player engagement/);
  assert.equal(result.body.match(/https?:\/\//g)?.length, 1);
  assert.match(result.body, /https:\/\/webgamerank\.com\//);
  assert.match(result.body, /Best,\nAnthony Gosme\nCreator of WebGameRank$/);
});
