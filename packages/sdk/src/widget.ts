// GameRank vote widget (US-4.3) — pose deux zones de vote sur le badge :
// gauche 👎, droite 👍, le centre reste le lien vers la fiche GameRank.
// Flèches visibles après 5 s de jeu actif ; le serveur re-vérifie
// l'éligibilité réelle (60 s par défaut). Échec toujours silencieux.

const SHOW_ARROWS_AFTER_MS = 5_000;

type GameRankGlobal = { key: string; visitorId: string; activeMs: () => number };

function init(): void {
  const script = document.currentScript as HTMLScriptElement | null;
  const container = script?.parentElement;
  if (!script || !container) return;
  const endpoint = new URL('/api/vote', script.src).toString();

  container.style.position = 'relative';

  const feedback = document.createElement('span');
  feedback.style.cssText =
    'position:absolute;left:50%;top:-1.8rem;transform:translateX(-50%);background:#111827;color:#fff;' +
    'font:12px system-ui,sans-serif;padding:.2rem .6rem;border-radius:.4rem;white-space:nowrap;' +
    'opacity:0;transition:opacity .3s;pointer-events:none;';
  container.append(feedback);
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  function say(message: string): void {
    feedback.textContent = message;
    feedback.style.opacity = '1';
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => (feedback.style.opacity = '0'), 2000);
  }

  // Le visuel (flèches, couleurs, contraste) est rendu par badge.svg côté
  // serveur — les zones ne sont que des surfaces cliquables transparentes.
  const badgeImg = container.querySelector('img');
  const badgeBase = badgeImg ? badgeImg.src.split('?')[0] : null;

  function makeZone(side: 'left' | 'right', value: 1 | -1, label: string) {
    const zone = document.createElement('button');
    zone.type = 'button';
    zone.setAttribute('aria-label', label);
    zone.style.cssText =
      `position:absolute;top:0;${side}:0;width:25%;height:100%;border:0;margin:0;` +
      'background:transparent;cursor:pointer;pointer-events:none;';
    zone.addEventListener('click', (event) => {
      event.preventDefault();
      vote(value);
    });
    container!.append(zone);
    return zone;
  }
  const downZone = makeZone('left', -1, 'Vote down');
  const upZone = makeZone('right', 1, 'Vote up');

  function gamerank(): GameRankGlobal | undefined {
    return (window as unknown as Record<string, unknown>).GameRank as GameRankGlobal | undefined;
  }

  let shown = false;
  let currentVote: number | null = null;

  function refreshBadge(): void {
    if (!badgeImg || !badgeBase || !shown) return;
    badgeImg.src = `${badgeBase}?arrows=1${currentVote ? `&voted=${currentVote}` : ''}`;
  }

  function storageKey(): string {
    return `gamerank_vote_${gamerank()?.key ?? ''}`;
  }
  try {
    const saved = localStorage.getItem(storageKey());
    if (saved) currentVote = Number(saved);
  } catch {
    /* silencieux */
  }

  setInterval(() => {
    try {
      if (!shown && (gamerank()?.activeMs() ?? 0) >= SHOW_ARROWS_AFTER_MS) {
        shown = true;
        refreshBadge();
        for (const zone of [downZone, upZone]) zone.style.pointerEvents = 'auto';
      }
    } catch {
      /* silencieux */
    }
  }, 1000);

  function vote(value: 1 | -1): void {
    const sdk = gamerank();
    if (!sdk) return;
    try {
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ key: sdk.key, visitorId: sdk.visitorId, value }),
      })
        .then(async (response) => {
          if (response.ok) {
            currentVote = value;
            refreshBadge();
            try {
              localStorage.setItem(storageKey(), String(value));
            } catch {
              /* silencieux */
            }
            say('Thanks for your vote!');
          } else {
            // 403 (jouer d'abord), 429 (délai de changement) : message serveur.
            const data = await response.json().catch(() => ({}));
            say((data as { error?: string }).error || 'Vote not accepted');
          }
        })
        .catch(() => {});
    } catch {
      /* silencieux */
    }
  }
}

try {
  init();
} catch {
  /* ne jamais casser le site hôte */
}
