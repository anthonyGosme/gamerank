import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { load } from 'cheerio';
import { chromium } from 'playwright-core';

const CONTACT_PATH_RE =
  /\b(contact|about|legal|privacy|imprint|impressum|mentions?|equipe|team|support|press)\b/i;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}\b/gi;
const BLOCKED_EMAIL_DOMAINS = new Set(['example.com', 'example.org', 'email.com', 'domain.com']);
const BLOCKED_LOCAL_PARTS = /^(no-?reply|do-?not-?reply|your-?email|email|name)$/i;
const MAXIMUM_HTML_BYTES = 2 * 1024 * 1024;

function isPrivateIpv4(value) {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function isPublicIp(value) {
  const version = isIP(value);
  if (version === 4) return !isPrivateIpv4(value);
  if (version !== 6) return false;
  const normalized = value.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    return isPublicIp(normalized.slice('::ffff:'.length));
  }
  return !(
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('2001:db8:')
  );
}

export async function assertPublicHttpUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Protocole non autorisé.');
  if (url.username || url.password) throw new Error('Identifiants intégrés à l’URL interdits.');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('Port non autorisé.');
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error('Hôte local interdit.');
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) {
    throw new Error('Adresse réseau privée ou non résolue.');
  }
  return url;
}

function normalizeEmail(value) {
  const email = String(value ?? '')
    .trim()
    .replace(/^mailto:/i, '')
    .split('?')[0]
    .replace(/^[<("'[\s]+|[>)"',;:\]\s]+$/g, '')
    .toLowerCase();
  const [localPart, domain, extra] = email.split('@');
  if (extra || !localPart || !domain || email.length > 254) return null;
  if (!EMAIL_RE.test(email)) {
    EMAIL_RE.lastIndex = 0;
    return null;
  }
  EMAIL_RE.lastIndex = 0;
  if (BLOCKED_LOCAL_PARTS.test(localPart) || BLOCKED_EMAIL_DOMAINS.has(domain)) return null;
  return email;
}

function decodeCloudflareEmail(value) {
  if (!/^[0-9a-f]+$/i.test(value) || value.length < 4 || value.length % 2 !== 0) return null;
  const key = Number.parseInt(value.slice(0, 2), 16);
  let decoded = '';
  for (let index = 2; index < value.length; index += 2) {
    decoded += String.fromCharCode(Number.parseInt(value.slice(index, index + 2), 16) ^ key);
  }
  return normalizeEmail(decoded);
}

function sameSite(left, right) {
  return left.hostname.toLowerCase().replace(/^www\./, '') ===
    right.hostname.toLowerCase().replace(/^www\./, '');
}

export function extractContactData(html, pageUrl) {
  // Certains SPA placent leurs liens utiles dans <noscript>. Parse5 les traite
  // comme du texte lorsque le scripting est activé, ce qui masquait ces liens.
  const $ = load(html, { scriptingEnabled: false });
  const emails = new Map();
  const addEmail = (value, source) => {
    const email = normalizeEmail(value);
    if (email && !emails.has(email)) emails.set(email, { email, source });
  };

  $('a[href^="mailto:" i]').each((_index, element) => {
    addEmail($(element).attr('href'), 'mailto');
  });
  $('[data-cfemail]').each((_index, element) => {
    const email = decodeCloudflareEmail($(element).attr('data-cfemail') ?? '');
    if (email && !emails.has(email)) emails.set(email, { email, source: 'cloudflare' });
  });
  const visibleText = $('body').text().replace(/\s+/g, ' ');
  for (const match of visibleText.matchAll(EMAIL_RE)) addEmail(match[0], 'visible_text');

  let contactFormUrl = null;
  $('form').each((_index, element) => {
    if (contactFormUrl) return;
    const form = $(element);
    const formText = form.text();
    const hasEmailField = form.find('input[type="email"], input[name*="email" i]').length > 0;
    if (!hasEmailField && !/contact|message|support/i.test(formText)) return;
    try {
      contactFormUrl = new URL(form.attr('action') || pageUrl, pageUrl).href;
    } catch {
      contactFormUrl = pageUrl;
    }
  });

  const contactLinks = [];
  $('a[href]').each((_index, element) => {
    const href = $(element).attr('href');
    const label = `${$(element).text()} ${href ?? ''}`;
    if (!href || !CONTACT_PATH_RE.test(label)) return;
    try {
      const url = new URL(href, pageUrl);
      if (
        ['http:', 'https:'].includes(url.protocol) &&
        sameSite(url, new URL(pageUrl)) &&
        !contactLinks.includes(url.href)
      ) {
        contactLinks.push(url.href);
      }
    } catch {
      // Lien non exploitable.
    }
  });
  contactLinks.sort((left, right) => {
    const score = (value) =>
      /\bcontact\b/i.test(value) ? 3 : /\b(support|press)\b/i.test(value) ? 2 : 1;
    return score(right) - score(left);
  });

  const scripts = $('script[src], script:not([src])').length;
  const likelySpa =
    visibleText.trim().length < 350 &&
    scripts >= 2 &&
    ($('#root, #app, [data-reactroot], [data-v-app]').length > 0 || scripts >= 5);

  return {
    emails: [...emails.values()],
    contactFormUrl,
    contactLinks: contactLinks.slice(0, 5),
    visibleTextLength: visibleText.trim().length,
    likelySpa,
  };
}

async function responseTextWithLimit(response) {
  const declaredSize = Number(response.headers.get('content-length') ?? 0);
  if (declaredSize > MAXIMUM_HTML_BYTES) throw new Error('Page HTML trop volumineuse.');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAXIMUM_HTML_BYTES) {
      await reader.cancel();
      throw new Error('Page HTML trop volumineuse.');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

export async function fetchHtmlPage(value, options = {}) {
  let url = await assertPublicHttpUrl(value);
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const response = await (options.fetchImpl ?? fetch)(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 12_000),
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'WebGameRankContactResearch/0.1 (+https://webgamerank.com/contact)',
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`Redirection HTTP ${response.status} sans destination.`);
      url = await assertPublicHttpUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') ?? '';
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      throw new Error(`Type de contenu non HTML : ${contentType || 'inconnu'}.`);
    }
    return { url: url.href, html: await responseTextWithLimit(response) };
  }
  throw new Error('Trop de redirections.');
}

export async function createPlaywrightRenderer() {
  const launchOptions = { headless: true };
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  const executablePath = candidates.find(existsSync);
  if (executablePath) launchOptions.executablePath = executablePath;
  else launchOptions.channel = 'chrome';

  const browser = await chromium.launch(launchOptions);
  return {
    async render(url) {
      const expected = await assertPublicHttpUrl(url);
      const context = await browser.newContext({
        userAgent: 'WebGameRankContactResearch/0.1 (+https://webgamerank.com/contact)',
      });
      const page = await context.newPage();
      await page.route('**/*', async (route) => {
        const request = route.request();
        if (['image', 'media', 'font'].includes(request.resourceType())) return route.abort();
        try {
          const requestUrl = new URL(request.url());
          if (requestUrl.protocol === 'data:' || requestUrl.protocol === 'blob:') {
            return route.continue();
          }
          await assertPublicHttpUrl(requestUrl.href);
          return route.continue();
        } catch {
          return route.abort();
        }
      });
      try {
        await page.goto(expected.href, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await page.waitForTimeout(1_000);
        return { url: page.url(), html: await page.content() };
      } finally {
        await context.close();
      }
    },
    close: () => browser.close(),
  };
}

function mergePageResult(target, page, sourceUrl) {
  for (const item of page.emails) {
    if (!target.emails.has(item.email)) {
      target.emails.set(item.email, { ...item, sourceUrl });
    }
  }
  if (!target.contactFormUrl && page.contactFormUrl) target.contactFormUrl = page.contactFormUrl;
}

export async function crawlContactSite(startUrl, options = {}) {
  const loadPage = options.loadPage ?? fetchHtmlPage;
  const aggregate = { emails: new Map(), contactFormUrl: null, contactPageUrl: null };
  const visited = new Set();
  let method = 'html';
  let homepage;

  try {
    homepage = await loadPage(startUrl, options);
    visited.add(homepage.url);
    const homepageData = extractContactData(homepage.html, homepage.url);
    mergePageResult(aggregate, homepageData, homepage.url);

    for (const link of homepageData.contactLinks.slice(0, options.maximumContactPages ?? 4)) {
      if (visited.has(link)) continue;
      try {
        const page = await loadPage(link, options);
        visited.add(page.url);
        if (!aggregate.contactPageUrl) aggregate.contactPageUrl = page.url;
        mergePageResult(aggregate, extractContactData(page.html, page.url), page.url);
      } catch {
        // Une sous-page cassée ne doit pas invalider tout le site.
      }
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }

    if (
      !aggregate.emails.size &&
      !aggregate.contactFormUrl &&
      homepageData.likelySpa &&
      options.renderPage
    ) {
      method = 'playwright';
      const rendered = await options.renderPage(homepage.url);
      visited.add(rendered.url);
      const renderedData = extractContactData(rendered.html, rendered.url);
      mergePageResult(aggregate, renderedData, rendered.url);
      for (const link of renderedData.contactLinks.slice(0, 2)) {
        if (visited.has(link)) continue;
        try {
          const page = await options.renderPage(link);
          visited.add(page.url);
          if (!aggregate.contactPageUrl) aggregate.contactPageUrl = page.url;
          mergePageResult(aggregate, extractContactData(page.html, page.url), page.url);
        } catch {
          // Même tolérance pour une route SPA secondaire.
        }
      }
    }

    return {
      emails: [...aggregate.emails.values()],
      contactFormUrl: aggregate.contactFormUrl,
      contactPageUrl: aggregate.contactPageUrl ?? aggregate.contactFormUrl,
      pagesScanned: visited.size,
      method,
      error: null,
    };
  } catch (error) {
    return {
      emails: [],
      contactFormUrl: null,
      contactPageUrl: null,
      pagesScanned: visited.size,
      method,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
