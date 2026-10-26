import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OUTREACH_TEST_PROSPECT,
  OUTREACH_TEST_RECIPIENT,
  sendOutreachEmail,
  sendOutreachTestEmail,
} from '../src/outreach-mailer.js';

function fakeTransport(deliveries) {
  return {
    async sendMail(message) {
      deliveries.push(message);
      return {
        messageId: 'smtp-test-id',
        accepted: [message.to],
        rejected: [],
      };
    },
  };
}

test('le test utilise le même envoi avec les données fictives demandées', async () => {
  const deliveries = [];
  const result = await sendOutreachTestEmail({
    smtpTransport: fakeTransport(deliveries),
    from: 'WebGameRank <admin@webgamerank.com>',
  });

  assert.equal(result.to, OUTREACH_TEST_RECIPIENT);
  assert.deepEqual(OUTREACH_TEST_PROSPECT, {
    gameTitle: 'test game',
    candidateUrl: 'https://test.com/',
  });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].to, 'anthonygosme@gmail.com');
  assert.equal(deliveries[0].subject, 'Add test game to WebGameRank?');
  assert.match(deliveries[0].text, /I discovered test game through r\/playmygame/);
});

test('un prospect réel passe par le même générateur et le même transport', async () => {
  const deliveries = [];
  await sendOutreachEmail({
    to: 'developer@example.net',
    prospect: { gameTitle: 'Pushdle', candidateUrl: 'https://pushdle.example/' },
    smtpTransport: fakeTransport(deliveries),
    from: 'WebGameRank <admin@webgamerank.com>',
  });

  assert.equal(deliveries[0].subject, 'Add Pushdle to WebGameRank?');
  assert.match(deliveries[0].text, /I discovered Pushdle/);
});
