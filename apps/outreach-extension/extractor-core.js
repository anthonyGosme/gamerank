(function exposeExtractor(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GameRankRedditExtractor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createExtractor() {
  const REDDIT_HOSTS = ['reddit.com', 'redd.it'];

  const HOST_GROUPS = {
    game_platform: ['itch.io', 'gamejolt.com', 'newgrounds.com', 'crazygames.com'],
    video: ['youtube.com', 'youtu.be', 'twitch.tv', 'vimeo.com'],
    social: ['discord.com', 'discord.gg', 'twitter.com', 'x.com', 'bsky.app', 'mastodon.social'],
    store: ['store.steampowered.com', 'epicgames.com', 'apps.apple.com', 'play.google.com'],
    funding: ['patreon.com', 'ko-fi.com', 'kickstarter.com'],
    source_code: ['github.com', 'gitlab.com'],
  };

  function normalizeText(value) {
    return String(value ?? '')
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeHost(hostname) {
    return hostname.toLowerCase().replace(/^www\./, '');
  }

  function hostMatches(hostname, suffix) {
    const host = normalizeHost(hostname);
    const normalizedSuffix = normalizeHost(suffix);
    return host === normalizedSuffix || host.endsWith(`.${normalizedSuffix}`);
  }

  function isRedditHost(hostname) {
    return REDDIT_HOSTS.some((suffix) => hostMatches(hostname, suffix));
  }

  function isWebFlair(value) {
    const normalized = normalizeText(value).toLowerCase();
    return /\[\s*pc\s*\]\s*\(\s*web\s*\)/i.test(normalized);
  }

  function pageHasWebFilter(pageUrl) {
    try {
      const url = new URL(pageUrl);
      const decoded = decodeURIComponent(`${url.search} ${url.hash}`).replaceAll('+', ' ');
      return isWebFlair(decoded);
    } catch {
      return false;
    }
  }

  function canonicalPostUrl(value, baseUrl = 'https://www.reddit.com') {
    try {
      const url = new URL(value, baseUrl);
      if (!isRedditHost(url.hostname)) return null;
      const match = url.pathname.match(/\/r\/playmygame\/comments\/([a-z0-9]+)(?:\/[^/?#]*)?/i);
      if (!match) return null;
      return `https://www.reddit.com/r/playmygame/comments/${match[1].toLowerCase()}/`;
    } catch {
      return null;
    }
  }

  function redditIdFromUrl(value) {
    return canonicalPostUrl(value)?.match(/\/comments\/([a-z0-9]+)\//i)?.[1] ?? null;
  }

  function classifyExternalUrl(value) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) return 'unsupported';
      if (isRedditHost(url.hostname)) return 'reddit';
      for (const [group, suffixes] of Object.entries(HOST_GROUPS)) {
        if (suffixes.some((suffix) => hostMatches(url.hostname, suffix))) return group;
      }
      return 'website';
    } catch {
      return 'invalid';
    }
  }

  function scoreExternalLink(link) {
    const kind = classifyExternalUrl(link.url);
    const baseScores = {
      website: 50,
      game_platform: 45,
      source_code: 20,
      store: 15,
      funding: 10,
      social: 5,
      video: 0,
    };
    let score = baseScores[kind] ?? -100;
    if (link.source === 'content-href') score += 25;
    if (link.source === 'body-playable-link') score += 20;
    if (/\b(play|game|demo|website|web)\b/i.test(link.text ?? '')) score += 15;
    if (/\b(trailer|video|discord|community|follow)\b/i.test(link.text ?? '')) score -= 10;
    return score;
  }

  function cleanExternalLinks(links) {
    const unique = new Map();
    for (const rawLink of links ?? []) {
      try {
        const url = new URL(rawLink.url);
        url.hash = '';
        const kind = classifyExternalUrl(url.href);
        if (['invalid', 'unsupported', 'reddit'].includes(kind)) continue;
        const link = {
          url: url.href,
          text: normalizeText(rawLink.text).slice(0, 300),
          source: rawLink.source ?? 'anchor',
          kind,
        };
        link.score = scoreExternalLink(link);
        const previous = unique.get(link.url);
        if (!previous || link.score > previous.score) unique.set(link.url, link);
      } catch {
        // Une URL invalide est ignorée et comptée dans les diagnostics DOM.
      }
    }
    return [...unique.values()].sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  }

  function firstUseful(values) {
    return (values ?? []).map(normalizeText).find(Boolean) ?? '';
  }

  function extractGameTitle(value) {
    const body = normalizeText(value);
    const match = body.match(
      /(?:\*{1,2}|_{1,2})?\s*game\s*title\s*(?:\*{1,2}|_{1,2})?\s*:\s*(?:\*{1,2}|_{1,2})?\s*(.+?)(?=\s+(?:\*{0,2}|_{0,2})?(?:playable\s*link|platform|description|genre|status)\s*(?:\*{0,2}|_{0,2})?\s*:|$)/i,
    );
    return normalizeText(match?.[1] ?? '')
      .replace(/(?:\*{1,2}|_{1,2})+$/g, '')
      .trim()
      .slice(0, 200);
  }

  function extractPlayableLinks(value) {
    const body = normalizeText(value);
    const field = body.match(
      /(?:\*{1,2}|_{1,2})?\s*playable\s*link\s*(?:\*{1,2}|_{1,2})?\s*(?::|-)\s*(.+?)(?=\s+(?:\*{0,2}|_{0,2})?(?:platform|description|genre|status|game\s*title)\s*(?:\*{0,2}|_{0,2})?\s*:|$)/i,
    )?.[1];
    if (!field) return [];

    const matches =
      field.match(
        /https?:\/\/[^\s<>{}\[\]"']+|(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,24}(?:\/[^\s<>{}\[\]"']*)?/gi,
      ) ?? [];
    const unique = new Set();
    for (const match of matches) {
      const cleaned = match.replace(/[),.;:!?*_]+$/g, '');
      try {
        const url = new URL(/^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`);
        if (['http:', 'https:'].includes(url.protocol)) unique.add(url.href);
      } catch {
        // Un domaine incomplet dans le champ Playable Link est ignoré.
      }
    }
    return [...unique];
  }

  function enrichPost(post, details = {}) {
    const detailedBody = normalizeText(details.body).slice(0, 5000);
    const body = detailedBody.length > normalizeText(post.body).length ? detailedBody : post.body;
    const playableLinks = extractPlayableLinks(body).map((url) => ({
      url,
      text: 'Playable Link',
      source: 'body-playable-link',
    }));
    const candidateLinks = cleanExternalLinks([
      ...(post.candidateLinks ?? []),
      ...(details.links ?? []),
      ...playableLinks,
    ]);
    return {
      ...post,
      body,
      gameTitle: post.gameTitle || extractGameTitle(body),
      candidateLinks,
    };
  }

  function buildPost(snapshot, pageUrl) {
    const permalink = firstUseful(snapshot.permalinks);
    const postUrl = canonicalPostUrl(permalink, pageUrl);
    if (!postUrl) return { accepted: false, reason: 'missing_permalink' };

    const explicitFlair = firstUseful([snapshot.flairAttribute, ...(snapshot.flairs ?? [])]);
    const flairMatch = isWebFlair(explicitFlair)
      ? 'explicit'
      : pageHasWebFilter(pageUrl)
        ? 'page_filter'
        : null;
    if (!flairMatch) return { accepted: false, reason: 'wrong_flair', postUrl };

    const body = normalizeText(snapshot.body).slice(0, 5000);
    const bodyLinks = extractPlayableLinks(body).map((url) => ({
      url,
      text: 'Playable Link',
      source: 'body-playable-link',
    }));
    const candidateLinks = cleanExternalLinks([...(snapshot.links ?? []), ...bodyLinks]);
    return {
      accepted: true,
      post: {
        redditId: redditIdFromUrl(postUrl),
        postUrl,
        title: firstUseful([snapshot.titleAttribute, ...(snapshot.titles ?? [])]).slice(0, 500),
        author: firstUseful([snapshot.authorAttribute, ...(snapshot.authors ?? [])]).slice(0, 100),
        postedAt: firstUseful([snapshot.postedAtAttribute, ...(snapshot.postedAts ?? [])]) || null,
        flair: explicitFlair || '[PC] (Web)',
        flairMatch,
        body,
        gameTitle: extractGameTitle(body),
        candidateLinks,
      },
    };
  }

  function dedupePosts(posts) {
    const unique = new Map();
    for (const post of posts) {
      const previous = unique.get(post.redditId);
      if (!previous || post.candidateLinks.length > previous.candidateLinks.length) {
        unique.set(post.redditId, post);
      }
    }
    return [...unique.values()];
  }

  return {
    buildPost,
    canonicalPostUrl,
    classifyExternalUrl,
    cleanExternalLinks,
    dedupePosts,
    enrichPost,
    extractGameTitle,
    extractPlayableLinks,
    isWebFlair,
    normalizeText,
    pageHasWebFilter,
    redditIdFromUrl,
    scoreExternalLink,
  };
});
