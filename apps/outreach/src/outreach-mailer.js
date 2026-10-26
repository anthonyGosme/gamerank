import nodemailer from 'nodemailer';
import { createOutreachMessage } from './message-template.js';

export const OUTREACH_TEST_RECIPIENT = 'anthonygosme@gmail.com';
export const OUTREACH_TEST_PROSPECT = Object.freeze({
  gameTitle: 'test game',
  candidateUrl: 'https://test.com/',
});

let transport;

function requiredEnvironment(name) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`Variable d’environnement manquante : ${name}`);
  return value;
}

function mailTransport() {
  if (transport) return transport;
  const port = Number(requiredEnvironment('SMTP_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('SMTP_PORT est invalide.');
  }
  transport = nodemailer.createTransport({
    host: requiredEnvironment('SMTP_HOST'),
    port,
    secure: process.env.SMTP_SECURE
      ? process.env.SMTP_SECURE === 'true'
      : port === 465,
    auth: {
      user: requiredEnvironment('SMTP_USER'),
      pass: requiredEnvironment('SMTP_PASS'),
    },
    ...(process.env.SMTP_TLS_INSECURE === 'true'
      ? { tls: { rejectUnauthorized: false } }
      : {}),
  });
  return transport;
}

function validRecipient(value) {
  const email = String(value ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Le prospect ne possède pas d’adresse e-mail valide.');
  }
  return email;
}

export async function sendOutreachEmail({
  to,
  prospect,
  smtpTransport = mailTransport(),
  from = requiredEnvironment('MAIL_FROM'),
}) {
  const recipient = validRecipient(to);
  const message = createOutreachMessage(prospect);
  const result = await smtpTransport.sendMail({
    from,
    to: recipient,
    subject: message.subject,
    text: message.body,
  });
  const accepted = Array.isArray(result.accepted) ? result.accepted.map(String) : [];
  if (!accepted.some((address) => address.toLowerCase() === recipient.toLowerCase())) {
    throw new Error(`Le SMTP n’a pas accepté le destinataire ${recipient}.`);
  }
  return {
    to: recipient,
    subject: message.subject,
    messageId: result.messageId ?? null,
    accepted,
    rejected: Array.isArray(result.rejected) ? result.rejected.map(String) : [],
  };
}

export function sendOutreachTestEmail(options = {}) {
  return sendOutreachEmail({
    ...options,
    to: OUTREACH_TEST_RECIPIENT,
    prospect: OUTREACH_TEST_PROSPECT,
  });
}
