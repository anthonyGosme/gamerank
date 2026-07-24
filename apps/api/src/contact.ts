import type { FastifyInstance } from 'fastify';
import { shell, escapeHtml } from './layout.js';
import { ipRateLimit } from './ratelimit.js';
import { sendContactMessage, type ContactMessage } from './mailer.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTACT_RATE_LIMIT = 5;
const CONTACT_RATE_WINDOW_MS = 60 * 60 * 1000;

interface ContactBody {
  name?: unknown;
  email?: unknown;
  subject?: unknown;
  message?: unknown;
  website?: unknown;
}

type ContactSender = (message: ContactMessage) => Promise<void>;

function field(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function contactPage(options: {
  sent?: boolean;
  error?: string;
  values?: Partial<ContactMessage>;
} = {}): string {
  const values = options.values ?? {};
  const notice = options.sent
    ? '<p class="notice" role="status">Thanks! Your message has been sent.</p>'
    : options.error
      ? `<p class="notice error" role="alert">${escapeHtml(options.error)}</p>`
      : '';

  return shell({
    title: 'Contact | WebGameRank',
    description: 'Contact the WebGameRank team about games, rankings, partnerships, or support.',
    path: '/contact',
    activeCategory: '@contact',
    narrow: true,
    body: `
      <h1>Contact</h1>
      <p class="lead">A question about WebGameRank, a listed game, or your developer account? Send Anthony a message.</p>
      ${notice}
      <form method="post" action="/contact">
        <label for="name">Name</label>
        <input id="name" name="name" autocomplete="name" required maxlength="100"
               value="${escapeHtml(values.name ?? '')}">

        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="email" inputmode="email"
               required maxlength="254" value="${escapeHtml(values.email ?? '')}">

        <label for="subject">Subject</label>
        <input id="subject" name="subject" required maxlength="150"
               placeholder="How can we help?" value="${escapeHtml(values.subject ?? '')}">

        <label for="message">Message</label>
        <textarea id="message" name="message" rows="8" required maxlength="5000"
                  placeholder="Tell us what you need…">${escapeHtml(values.message ?? '')}</textarea>

        <div class="contact-trap" aria-hidden="true">
          <label for="website">Website</label>
          <input id="website" name="website" tabindex="-1" autocomplete="off">
        </div>
        <button type="submit">Send message</button>
      </form>
      <style>
        .contact-trap { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
        textarea { resize: vertical; min-height: 10rem; }
      </style>`,
  });
}

export function registerContactRoutes(
  app: FastifyInstance,
  send: ContactSender = sendContactMessage,
): void {
  app.get('/contact', async (request, reply) => {
    const { sent } = request.query as { sent?: string };
    return reply.type('text/html').send(contactPage({ sent: sent === '1' }));
  });

  const rateLimit = ipRateLimit(CONTACT_RATE_LIMIT, CONTACT_RATE_WINDOW_MS);
  app.post('/contact', { preHandler: rateLimit }, async (request, reply) => {
    const body = (request.body ?? {}) as ContactBody;

    // Champ leurre : un bot qui le remplit reçoit une réponse normale, sans mail.
    if (field(body.website)) {
      return reply.redirect('/contact?sent=1');
    }

    const values: ContactMessage = {
      name: field(body.name),
      email: field(body.email).toLowerCase(),
      subject: field(body.subject),
      message: field(body.message),
      ip: request.ip,
    };
    const invalid =
      !values.name ||
      values.name.length > 100 ||
      /[\r\n]/.test(values.name) ||
      !EMAIL_RE.test(values.email) ||
      values.email.length > 254 ||
      !values.subject ||
      values.subject.length > 150 ||
      /[\r\n]/.test(values.subject) ||
      !values.message ||
      values.message.length > 5000;

    if (invalid) {
      return reply
        .code(400)
        .type('text/html')
        .send(contactPage({ error: 'Please check every field and try again.', values }));
    }

    try {
      await send(values);
      return reply.redirect('/contact?sent=1');
    } catch (err) {
      request.log.error({ err }, 'contact email send failed');
      return reply
        .code(502)
        .type('text/html')
        .send(contactPage({
          error: 'Your message could not be sent right now. Please try again later.',
          values,
        }));
    }
  });
}
