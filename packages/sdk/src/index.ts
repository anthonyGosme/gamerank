// GameRank SDK — mesure du temps de jeu réellement actif (CDC §2, US-4.1/4.2).
// Contrat : ne JAMAIS casser le jeu hôte — tout échec est silencieux.

const SDK_VERSION = '0.1.0';
const HEARTBEAT_MIN_MS = 5_000;
const HEARTBEAT_FACTOR = 3;
// Plafonné : au-delà, un heartbeat perdu coûterait des minutes de mesure,
// et le plafond serveur (150 s) doit rester serré.
const HEARTBEAT_MAX_MS = 135_000;
const IDLE_LIMIT_MS = 60_000;
const SESSION_GAP_MS = 30 * 60_000;
const VISITOR_STORAGE_KEY = 'gamerank_visitor';

type QueuedEvent = { type: string; visitorId: string; sessionId: string; activeMs?: number };

function randomId(): string {
  try {
    if (crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* continue */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function getVisitorId(): string {
  // localStorage est par origine : l'identifiant est "par jeu" de fait (CDC §3).
  try {
    let id = localStorage.getItem(VISITOR_STORAGE_KEY);
    if (!id) {
      id = randomId();
      localStorage.setItem(VISITOR_STORAGE_KEY, id);
    }
    return id;
  } catch {
    return randomId(); // navigation privée : visiteur éphémère
  }
}

function init(): void {
  const script = document.currentScript as HTMLScriptElement | null;
  const key = script?.dataset.key;
  if (!key || !script) return;
  const endpoint = new URL('/api/ingest', script.src).toString();

  const visitorId = getVisitorId();
  let sessionId = randomId();
  let sessionStarted = false;
  let lastActivity = 0;
  let activeMs = 0;
  let heartbeatDelay = HEARTBEAT_MIN_MS;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let queue: QueuedEvent[] = [];

  function enqueue(type: string, withActive = false): void {
    const event: QueuedEvent = { type, visitorId, sessionId };
    if (withActive) {
      event.activeMs = Math.round(activeMs);
      activeMs = 0;
    }
    queue.push(event);
  }

  function flush(useBeacon = false): void {
    if (queue.length === 0) return;
    const body = JSON.stringify({ key, sdkVersion: SDK_VERSION, events: queue });
    queue = [];
    try {
      // text/plain : requête "simple" (pas de préflight CORS), compatible sendBeacon.
      if (useBeacon && navigator.sendBeacon) {
        navigator.sendBeacon(endpoint, body);
      } else {
        fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body,
          keepalive: true,
        }).catch(() => {});
      }
    } catch {
      /* silencieux */
    }
  }

  function scheduleHeartbeat(): void {
    heartbeatTimer = setTimeout(() => {
      try {
        enqueue('heartbeat', true);
        flush();
      } catch {
        /* silencieux */
      }
      // Cadence exponentielle : 5 s → 15 s → 45 s → 135 s (plafond).
      heartbeatDelay = Math.min(heartbeatDelay * HEARTBEAT_FACTOR, HEARTBEAT_MAX_MS);
      scheduleHeartbeat();
    }, heartbeatDelay);
  }

  function onActivity(): void {
    const now = Date.now();
    if (lastActivity && now - lastActivity > SESSION_GAP_MS) {
      // Longue pause : la session précédente se clôt, une nouvelle démarre.
      enqueue('session_end', true);
      flush();
      sessionId = randomId();
      sessionStarted = false;
      heartbeatDelay = HEARTBEAT_MIN_MS;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
    }
    lastActivity = now;
    if (!sessionStarted) {
      sessionStarted = true;
      enqueue('session_start');
      flush();
      scheduleHeartbeat();
    }
  }

  for (const type of ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel']) {
    addEventListener(type, onActivity, { passive: true, capture: true });
  }

  // Comptage : 1 tick/s uniquement si l'onglet est visible ET qu'un input
  // date de moins de 60 s (CDC §2).
  setInterval(() => {
    try {
      if (
        document.visibilityState === 'visible' &&
        lastActivity &&
        Date.now() - lastActivity < IDLE_LIMIT_MS
      ) {
        activeMs += 1000;
      }
    } catch {
      /* silencieux */
    }
  }, 1000);

  addEventListener('pagehide', () => {
    try {
      if (sessionStarted) enqueue('session_end', true);
      flush(true);
    } catch {
      /* silencieux */
    }
  });
  document.addEventListener('visibilitychange', () => {
    try {
      if (document.visibilityState === 'hidden') {
        if (activeMs > 0) enqueue('heartbeat', true);
        flush(true);
      }
    } catch {
      /* silencieux */
    }
  });

  enqueue('load');
  flush();
}

try {
  init();
} catch {
  /* ne jamais remonter d'erreur au site hôte */
}
