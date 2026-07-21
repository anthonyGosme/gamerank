import nodemailer from 'nodemailer';
import { config } from './config.js';

// Envoi réel dans tous les environnements (plus de capture Mailpit). Auth
// activée dès que SMTP_USER est fourni ; TLS selon le port (465 = TLS direct,
// 587 = STARTTLS). En dev on passe par le tunnel SSH vers Poste.io
// (SMTP_HOST=localhost:1587, SMTP_TLS_INSECURE=true) — voir posteio/README.md.
// Le port 25 n'est jamais nécessaire côté envoi.
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

// Santé du mailer, alimentée par les vrais envois (pas une simulation). Exposée
// par /health/email pour qu'Uptime Kuma sache si l'envoi part toujours.
export interface MailerHealth {
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  totalSent: number;
  totalFailed: number;
}

export const mailerHealth: MailerHealth = {
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  consecutiveFailures: 0,
  totalSent: 0,
  totalFailed: 0,
};

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Sonde active : ouvre une connexion et tente l'auth SMTP sans envoyer de mail.
// C'est exactement ce qui a lâché (auth timeout) — donc un bon signal.
export async function verifyMailTransport(): Promise<{ ok: boolean; error?: string }> {
  try {
    await transport.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

export async function sendMagicLink(email: string, url: string): Promise<void> {
  // En dev on trace toujours le lien AVANT l'envoi : fallback si le tunnel SMTP
  // est coupé, on peut quand même se connecter.
  if (!config.isProduction) {
    console.log(`[dev] magic link pour ${email} : ${url}`);
  }
  try {
    await transport.sendMail({
      from: config.mailFrom,
      to: email,
      subject: 'Your WebGameRank login link',
      text: `Log in to WebGameRank by opening this link (valid for ${config.magicLinkTtlMinutes} minutes):\n\n${url}\n\nIf you did not request this, you can safely ignore this email.`,
    });
    mailerHealth.lastSuccessAt = Date.now();
    mailerHealth.consecutiveFailures = 0;
    mailerHealth.totalSent += 1;
  } catch (err) {
    mailerHealth.lastErrorAt = Date.now();
    mailerHealth.lastError = errMsg(err);
    mailerHealth.consecutiveFailures += 1;
    mailerHealth.totalFailed += 1;
    throw err; // l'appelant (issueMagicLink) log et n'échoue pas la requête
  }
}
