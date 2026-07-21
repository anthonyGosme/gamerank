import nodemailer from 'nodemailer';
import { config } from './config.js';

// En dev (Mailpit) : pas d'auth, pas de TLS. En prod (Resend/SES/Poste.io) :
// auth activée dès que SMTP_USER est fourni ; TLS selon le port (465 = TLS
// direct, 587 = STARTTLS). Le port 25 n'est jamais nécessaire côté envoi.
const transport = nodemailer.createTransport({
  host: config.smtpHost,
  port: config.smtpPort,
  secure: config.smtpSecure,
  ...(config.smtpUser
    ? { auth: { user: config.smtpUser, pass: config.smtpPass } }
    : {}),
  // Certif auto-signé accepté si demandé (liaison app ↔ serveur mail que
  // l'on contrôle). La connexion reste chiffrée (STARTTLS/TLS).
  ...(config.smtpTlsInsecure ? { tls: { rejectUnauthorized: false } } : {}),
});

export async function sendMagicLink(email: string, url: string): Promise<void> {
  await transport.sendMail({
    from: config.mailFrom,
    to: email,
    subject: 'Your WebGameRank login link',
    text: `Log in to WebGameRank by opening this link (valid for ${config.magicLinkTtlMinutes} minutes):\n\n${url}\n\nIf you did not request this, you can safely ignore this email.`,
  });
  if (!config.isProduction) {
    console.log(`[dev] magic link pour ${email} : ${url}`);
  }
}
