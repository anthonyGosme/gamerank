// Envoie un email de test via le transport SMTP de l'app (mêmes réglages que la
// prod). Utilisé par `./run.sh dev email-test <destinataire>`.
//   tsx --env-file=.env apps/api/scripts/send-test-email.ts you@example.com
import { sendTestEmail } from '../src/mailer.js';

const to = process.argv[2];
if (!to) {
  console.error('usage : tsx apps/api/scripts/send-test-email.ts <destinataire>');
  process.exit(1);
}

try {
  await sendTestEmail(to);
  console.log(`✅ email de test envoyé à ${to}`);
  process.exit(0);
} catch (err) {
  console.error(`❌ échec d'envoi à ${to} :`, err instanceof Error ? err.message : err);
  process.exit(1);
}
