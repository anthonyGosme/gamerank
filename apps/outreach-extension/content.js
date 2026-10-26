(function registerContentScript() {
  const extractor = globalThis.GameRankRedditExtractor;
  if (!extractor) return;

  const POST_CONTAINER_SELECTOR = [
    'shreddit-post',
    'article',
    '[data-testid="post-container"]',
    '[data-post-click-location]',
    '[id^="t3_"]',
  ].join(',');

  const FLAIR_SELECTOR = [
    '[slot="post-flair"]',
    '[data-testid*="flair"]',
    '[class*="flair"]',
    'a[href*="flair_name"]',
  ].join(',');

  function textValues(root, selector, limit = 20) {
    return [...root.querySelectorAll(selector)]
      .slice(0, limit)
      .map((element) => element.textContent ?? '')
      .filter(Boolean);
  }

  function attributeValues(root, selector, attribute, limit = 20) {
    return [...root.querySelectorAll(selector)]
      .slice(0, limit)
      .map((element) => element.getAttribute(attribute) ?? '')
      .filter(Boolean);
  }

  function linksFrom(root, contentHref) {
    const links = [...root.querySelectorAll('a[href]')].slice(0, 100).map((anchor) => ({
      url: anchor.href,
      text: anchor.textContent ?? anchor.getAttribute('aria-label') ?? '',
      source: 'anchor',
    }));
    if (contentHref) links.unshift({ url: contentHref, text: 'post content link', source: 'content-href' });
    return links;
  }

  function nearestPostContainer(anchor) {
    const direct = anchor.closest(POST_CONTAINER_SELECTOR);
    if (direct) return direct;

    let element = anchor.parentElement;
    for (let depth = 0; element && depth < 8; depth += 1, element = element.parentElement) {
      const text = element.textContent ?? '';
      if (text.length > 30 && element.querySelectorAll('a[href]').length >= 2) return element;
    }
    return anchor.parentElement;
  }

  function snapshotContainer(container, permalinkHint) {
    const get = (name) => container.getAttribute?.(name) ?? '';
    const permalinkAttributes = [
      get('permalink'),
      get('post-permalink'),
      get('content-href'),
      permalinkHint,
    ].filter(Boolean);
    const contentHref = get('content-href') || get('url');

    return {
      permalinks: [
        ...permalinkAttributes,
        ...attributeValues(container, 'a[href*="/r/playmygame/comments/"]', 'href'),
      ],
      flairAttribute: get('flair-text') || get('post-flair'),
      flairs: textValues(container, FLAIR_SELECTOR),
      titleAttribute: get('post-title') || get('title'),
      titles: textValues(container, '[slot="title"], h1, h2, h3, a[href*="/comments/"]', 12),
      authorAttribute: get('author') || get('author-name'),
      authors: textValues(container, '[data-testid*="author"], a[href^="/user/"], a[href*="reddit.com/user/"]', 5),
      postedAtAttribute: get('created-timestamp') || get('created-at'),
      postedAts: attributeValues(container, 'time[datetime]', 'datetime', 3),
      body: container.innerText ?? container.textContent ?? '',
      links: linksFrom(container, contentHref),
    };
  }

  function collectSnapshots() {
    const snapshots = [];
    const seenContainers = new Set();

    for (const post of document.querySelectorAll('shreddit-post')) {
      seenContainers.add(post);
      snapshots.push(snapshotContainer(post));
    }

    const permalinkAnchors = document.querySelectorAll(
      'a[href*="/r/playmygame/comments/"], a[href^="/r/playmygame/comments/"]',
    );
    for (const anchor of permalinkAnchors) {
      const container = nearestPostContainer(anchor);
      if (!container || seenContainers.has(container)) continue;
      seenContainers.add(container);
      snapshots.push(snapshotContainer(container, anchor.href));
    }
    return snapshots;
  }

  function extractPosts() {
    const snapshots = collectSnapshots();
    const accepted = [];
    const rejected = {};

    for (const snapshot of snapshots) {
      const result = extractor.buildPost(snapshot, location.href);
      if (result.accepted) accepted.push(result.post);
      else rejected[result.reason] = (rejected[result.reason] ?? 0) + 1;
    }

    const posts = extractor.dedupePosts(accepted).map((post) => ({
      ...post,
      capturedAt: new Date().toISOString(),
    }));
    return {
      version: 1,
      source: location.href,
      capturedAt: new Date().toISOString(),
      posts,
      diagnostics: {
        containersScanned: snapshots.length,
        postsAcceptedBeforeDedupe: accepted.length,
        postsExported: posts.length,
        postsWithoutCandidateLink: posts.filter((post) => post.candidateLinks.length === 0).length,
        rejected,
      },
    };
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function mergeExtraction(target, extraction) {
    for (const post of extraction.posts) {
      const previous = target.posts.get(post.redditId);
      if (!previous || post.candidateLinks.length > previous.candidateLinks.length) {
        target.posts.set(post.redditId, post);
      }
    }
    target.containersScanned += extraction.diagnostics.containersScanned;
    target.postsAcceptedBeforeDedupe += extraction.diagnostics.postsAcceptedBeforeDedupe;
    for (const [reason, count] of Object.entries(extraction.diagnostics.rejected)) {
      target.rejected[reason] = (target.rejected[reason] ?? 0) + count;
    }
  }

  function reportProgress(posts, step, state) {
    chrome.runtime.sendMessage({
      type: 'GR_EXTRACTION_PROGRESS',
      posts,
      step,
      state,
    }).catch(() => {
      // La popup peut avoir été fermée pendant le défilement.
    });
  }

  function linksFromRedditData(data) {
    const links = [];
    for (const value of [data?.url_overridden_by_dest, data?.url]) {
      if (value) links.push({ url: value, text: 'Reddit destination', source: 'post-detail' });
    }
    if (data?.selftext_html) {
      const document = new DOMParser().parseFromString(data.selftext_html, 'text/html');
      for (const anchor of document.querySelectorAll('a[href]')) {
        links.push({
          url: anchor.href,
          text: anchor.textContent ?? '',
          source: 'post-detail',
        });
      }
    }
    return links;
  }

  async function fetchDetailedPost(post) {
    try {
      const response = await fetch(`${post.postUrl}.json?raw_json=1`, {
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
        const payload = await response.json();
        const children = payload?.[0]?.data?.children ?? payload?.data?.children ?? [];
        const data =
          children.find((child) => child?.data?.id === post.redditId)?.data ??
          children[0]?.data;
        if (data) {
          return {
            body: data.selftext ?? '',
            links: linksFromRedditData(data),
          };
        }
      }
    } catch {
      // Reddit peut désactiver sa réponse JSON ; le HTML détaillé sert de secours.
    }

    const response = await fetch(post.postUrl, {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'text/html' },
    });
    if (!response.ok) throw new Error(`Reddit détail HTTP ${response.status}`);
    const document = new DOMParser().parseFromString(await response.text(), 'text/html');
    const container =
      [...document.querySelectorAll('shreddit-post')].find((element) => {
        const permalink =
          element.getAttribute('permalink') ??
          element.getAttribute('post-permalink') ??
          element.getAttribute('content-href') ??
          '';
        return permalink.includes(`/comments/${post.redditId}/`);
      }) ?? document.querySelector('shreddit-post, article, [data-testid="post-container"]');
    if (!container) throw new Error('Contenu détaillé Reddit introuvable');
    const snapshot = snapshotContainer(container, post.postUrl);
    return { body: snapshot.body, links: snapshot.links };
  }

  async function enrichPostsWithoutLinks(posts) {
    const missing = posts.filter((post) => post.candidateLinks.length === 0).slice(0, 100);
    let recovered = 0;
    let failures = 0;
    for (const [index, post] of missing.entries()) {
      reportProgress(posts.length, index + 1, 'enriching');
      try {
        const enriched = extractor.enrichPost(post, await fetchDetailedPost(post));
        Object.assign(post, enriched);
        if (post.candidateLinks.length) recovered += 1;
      } catch {
        failures += 1;
      }
      if (index < missing.length - 1) await wait(200);
    }
    return {
      requested: missing.length,
      recovered,
      failures,
    };
  }

  async function extractAllPosts() {
    const originalScrollY = window.scrollY;
    const aggregate = {
      posts: new Map(),
      containersScanned: 0,
      postsAcceptedBeforeDedupe: 0,
      rejected: {},
    };
    const maximumPosts = 200;
    const maximumSteps = 400;
    const maximumDuration = 180_000;
    const startedAt = Date.now();
    let step = 0;
    let idleAtBottom = 0;

    window.scrollTo({ top: 0, behavior: 'instant' });
    await wait(500);

    try {
      while (
        aggregate.posts.size < maximumPosts &&
        step < maximumSteps &&
        Date.now() - startedAt < maximumDuration
      ) {
        step += 1;
        const before = aggregate.posts.size;
        mergeExtraction(aggregate, extractPosts());
        const scrollingElement = document.scrollingElement ?? document.documentElement;
        const distanceToBottom =
          scrollingElement.scrollHeight - (scrollingElement.scrollTop + window.innerHeight);
        const atBottom = distanceToBottom <= 250;

        reportProgress(aggregate.posts.size, step, atBottom ? 'loading' : 'scrolling');

        if (atBottom) {
          idleAtBottom = aggregate.posts.size === before ? idleAtBottom + 1 : 0;
          if (idleAtBottom >= 8) break;
          await wait(1_000);
        } else {
          idleAtBottom = 0;
          window.scrollBy({
            top: Math.max(Math.round(window.innerHeight * 0.85), 700),
            behavior: 'instant',
          });
          await wait(450);
        }
      }
    } finally {
      window.scrollTo({ top: originalScrollY, behavior: 'instant' });
    }

    const posts = extractor.dedupePosts([...aggregate.posts.values()]).slice(0, maximumPosts);
    const detailEnrichment = await enrichPostsWithoutLinks(posts);
    return {
      version: 1,
      source: location.href,
      capturedAt: new Date().toISOString(),
      posts,
      diagnostics: {
        containersScanned: aggregate.containersScanned,
        postsAcceptedBeforeDedupe: aggregate.postsAcceptedBeforeDedupe,
        postsExported: posts.length,
        postsWithoutCandidateLink: posts.filter((post) => post.candidateLinks.length === 0).length,
        rejected: aggregate.rejected,
        automaticScroll: {
          steps: step,
          durationMs: Date.now() - startedAt,
          maximumPosts,
          targetReached: posts.length >= maximumPosts,
          stoppedBySafetyLimit:
            step >= maximumSteps || Date.now() - startedAt >= maximumDuration,
        },
        detailEnrichment,
      },
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'GR_EXTRACT_VISIBLE_POSTS') {
      const extraction = extractPosts();
      enrichPostsWithoutLinks(extraction.posts)
        .then((detailEnrichment) => {
          extraction.diagnostics.detailEnrichment = detailEnrichment;
          extraction.diagnostics.postsWithoutCandidateLink = extraction.posts.filter(
            (post) => post.candidateLinks.length === 0,
          ).length;
          sendResponse({ ok: true, data: extraction });
        })
        .catch((error) => {
          sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
        });
      return true;
    }

    if (message?.type === 'GR_EXTRACT_ALL_POSTS') {
      extractAllPosts()
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => {
          sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
        });
      return true;
    }

    return undefined;
  });
})();
