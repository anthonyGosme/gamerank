import assert from 'node:assert/strict';
import test from 'node:test';
import { crawlContactSite, extractContactData, isPublicIp } from '../src/contact-extractor.js';

test('extrait les e-mails publiés et les pages de contact sans sortir du site', () => {
  const result = extractContactData(
    `
      <html><body>
        <a href="mailto:Hello@Game.Example?subject=Hi">Email us</a>
        <p>Press: press@game.example</p>
        <a href="/contact">Contact</a>
        <a href="https://other.example/contact">External contact</a>
      </body></html>
    `,
    'https://game.example/',
  );

  assert.deepEqual(
    result.emails.map((item) => item.email),
    ['hello@game.example', 'press@game.example'],
  );
  assert.deepEqual(result.contactLinks, ['https://game.example/contact']);
});

test('détecte un formulaire de contact sans inventer d’adresse', () => {
  const result = extractContactData(
    `<form action="/send"><label>Email <input type="email" name="email"></label>
      <textarea name="message"></textarea></form>`,
    'https://game.example/contact',
  );
  assert.equal(result.contactFormUrl, 'https://game.example/send');
  assert.deepEqual(result.emails, []);
});

test('découvre les pages de contact placées dans un bloc noscript', () => {
  const result = extractContactData(
    `<div id="root"></div>
     <noscript>Read more <a href="/about.html">about the game</a>.</noscript>`,
    'https://game.example/',
  );

  assert.deepEqual(result.contactLinks, ['https://game.example/about.html']);
});

test('parcourt la page Contact et conserve la page source de l’adresse', async () => {
  const pages = new Map([
    [
      'https://game.example/',
      '<html><body><a href="/contact">Contact us</a></body></html>',
    ],
    [
      'https://game.example/contact',
      '<html><body><a href="mailto:studio@game.example">studio@game.example</a></body></html>',
    ],
  ]);
  const result = await crawlContactSite('https://game.example/', {
    loadPage: async (url) => ({ url, html: pages.get(url) }),
  });

  assert.equal(result.error, null);
  assert.equal(result.pagesScanned, 2);
  assert.equal(result.contactPageUrl, 'https://game.example/contact');
  assert.deepEqual(result.emails, [
    {
      email: 'studio@game.example',
      source: 'mailto',
      sourceUrl: 'https://game.example/contact',
    },
  ]);
});

test('utilise le rendu navigateur uniquement pour une coquille SPA vide', async () => {
  let rendered = false;
  const result = await crawlContactSite('https://spa.example/', {
    loadPage: async (url) => ({
      url,
      html: '<html><body><div id="root"></div><script src="/a.js"></script><script src="/b.js"></script></body></html>',
    }),
    renderPage: async (url) => {
      rendered = true;
      return { url, html: '<p>Contact us at dev@spa.example</p>' };
    },
  });

  assert.equal(rendered, true);
  assert.equal(result.method, 'playwright');
  assert.equal(result.emails[0].email, 'dev@spa.example');
});

test('bloque les adresses réseau privées utilisées pour le SSRF', () => {
  assert.equal(isPublicIp('127.0.0.1'), false);
  assert.equal(isPublicIp('10.0.0.1'), false);
  assert.equal(isPublicIp('192.168.1.2'), false);
  assert.equal(isPublicIp('::1'), false);
  assert.equal(isPublicIp('8.8.8.8'), true);
});
