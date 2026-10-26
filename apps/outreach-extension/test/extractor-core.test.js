const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPost,
  canonicalPostUrl,
  classifyExternalUrl,
  cleanExternalLinks,
  enrichPost,
  extractGameTitle,
  extractPlayableLinks,
  isWebFlair,
  pageHasWebFilter,
} = require('../extractor-core.js');

const filteredPage =
  'https://www.reddit.com/r/playmygame/?f=flair_name%3A%22%5BPC%5D%20(Web)%22';

test('reconnaît les variantes du flair web', () => {
  assert.equal(isWebFlair('[PC] (Web)'), true);
  assert.equal(isWebFlair('[ pc ]  ( WEB )'), true);
  assert.equal(isWebFlair('[PC] (Windows)'), false);
  assert.equal(pageHasWebFilter(filteredPage), true);
});

test('normalise uniquement les permalinks de r/playmygame', () => {
  assert.equal(
    canonicalPostUrl('/r/playmygame/comments/ABC123/my_game/?utm_source=x'),
    'https://www.reddit.com/r/playmygame/comments/abc123/',
  );
  assert.equal(canonicalPostUrl('https://www.reddit.com/r/gaming/comments/abc123/x/'), null);
  assert.equal(canonicalPostUrl('https://example.com/r/playmygame/comments/abc123/x/'), null);
});

test('classe les liens sans éliminer les plateformes de jeu', () => {
  assert.equal(classifyExternalUrl('https://studio.example/game'), 'website');
  assert.equal(classifyExternalUrl('https://creator.itch.io/game'), 'game_platform');
  assert.equal(classifyExternalUrl('https://www.crazygames.com/game/example'), 'game_platform');
  assert.equal(classifyExternalUrl('https://www.youtube.com/watch?v=x'), 'video');
  assert.equal(classifyExternalUrl('https://www.reddit.com/r/playmygame/'), 'reddit');
  assert.equal(classifyExternalUrl('https://v.redd.it/video-id'), 'reddit');
  assert.equal(classifyExternalUrl('https://i.redd.it/image-id.png'), 'reddit');
});

test('extrait un titre de jeu entre les libellés du modèle Reddit', () => {
  assert.equal(
    extractGameTitle(
      'Introduction **Game Title:** The Slightly Greedy Game **Playable Link:** https://game.test',
    ),
    'The Slightly Greedy Game',
  );
  assert.equal(
    extractGameTitle('Game Title: Orbil Playable Link: https://orbil.app Platform: Web'),
    'Orbil',
  );
});

test('extrait les Playable Link en texte brut, avec ou sans protocole', () => {
  assert.deepEqual(
    extractPlayableLinks(
      'Game Title: Scrap & Pressure Playable Link: https://nosenss.itch.io/scrap-and-pressure Platform: Web',
    ),
    ['https://nosenss.itch.io/scrap-and-pressure'],
  );
  assert.deepEqual(
    extractPlayableLinks('**Playable Link:** Apochess.com **Platform:** PC / Web'),
    ['https://apochess.com/'],
  );
});

test('ajoute un Playable Link textuel aux liens candidats du post', () => {
  const result = buildPost(
    {
      permalinks: ['/r/playmygame/comments/plainlink1/game/'],
      flairs: ['[PC] (Web)'],
      titles: ['Plain link game'],
      body: 'Game Title: Plain Link Playable Link: plain-link.example/play Platform: Web',
      links: [],
    },
    filteredPage,
  );

  assert.equal(result.accepted, true);
  assert.equal(result.post.candidateLinks[0].url, 'https://plain-link.example/play');
  assert.equal(result.post.candidateLinks[0].kind, 'website');
  assert.equal(result.post.candidateLinks[0].source, 'body-playable-link');
});

test('enrichit une carte Reddit incomplète avec le contenu du post détaillé', () => {
  const result = enrichPost(
    {
      redditId: 'detail1',
      title: 'Scrap post',
      body: 'Scrap post [PC] (Web)',
      gameTitle: '',
      candidateLinks: [],
    },
    {
      body:
        'Game Title: Scrap & Pressure Playable Link: https://nosenss.itch.io/scrap-and-pressure Platform: Web',
      links: [],
    },
  );

  assert.equal(result.gameTitle, 'Scrap & Pressure');
  assert.deepEqual(
    result.candidateLinks.map(({ url, kind }) => ({ url, kind })),
    [
      {
        url: 'https://nosenss.itch.io/scrap-and-pressure',
        kind: 'game_platform',
      },
    ],
  );
});

test('déduplique et ordonne les liens candidats', () => {
  const links = cleanExternalLinks([
    { url: 'https://youtu.be/trailer', text: 'Trailer' },
    { url: 'https://game.example/play#top', text: 'Play the game' },
    { url: 'https://game.example/play', text: '', source: 'content-href' },
    { url: 'https://discord.gg/example', text: 'Discord' },
    { url: 'https://v.redd.it/not-the-game', text: 'Video hosted by Reddit' },
  ]);
  assert.deepEqual(
    links.map(({ url, kind }) => ({ url, kind })),
    [
      { url: 'https://game.example/play', kind: 'website' },
      { url: 'https://discord.gg/example', kind: 'social' },
      { url: 'https://youtu.be/trailer', kind: 'video' },
    ],
  );
});

test('construit un post sourcé depuis un snapshot DOM', () => {
  const result = buildPost(
    {
      permalinks: ['/r/playmygame/comments/xyz789/space_game/'],
      flairs: ['[PC] (Web)'],
      titles: ['Space Game'],
      authors: ['u/space_dev'],
      body: 'A browser game you can play today.',
      links: [
        { url: 'https://space-game.example/', text: 'Play Space Game' },
        { url: 'https://youtube.com/watch?v=123', text: 'Trailer' },
      ],
    },
    filteredPage,
  );

  assert.equal(result.accepted, true);
  assert.equal(result.post.redditId, 'xyz789');
  assert.equal(result.post.title, 'Space Game');
  assert.equal(result.post.candidateLinks[0].url, 'https://space-game.example/');
  assert.equal(result.post.flairMatch, 'explicit');
});

test('le filtre de page compense un flair absent du DOM', () => {
  const result = buildPost(
    {
      permalinks: ['/r/playmygame/comments/filter1/game/'],
      flairs: [],
      titles: ['Filtered game'],
      links: [],
    },
    filteredPage,
  );
  assert.equal(result.accepted, true);
  assert.equal(result.post.flairMatch, 'page_filter');
});
