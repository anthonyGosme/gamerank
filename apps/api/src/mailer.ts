import nodemailer from 'nodemailer';
import { config } from './config.js';

const transport = nodemailer.createTransport({
  host: config.smtpHost,
  port: config.smtpPort,
  secure: false,
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
