import type { FastifyReply, FastifyRequest } from 'fastify';

// Rate-limit par IP, fenêtre fixe, en mémoire. But : protéger le serveur du
// flood/vélocité (DoS, coût) — pas l'anti-triche (déjà fait au scoring). Adapté
// au single-instance ; pour du multi-réplica il faudrait un store partagé (Redis).

interface Bucket {
  count: number;
  resetAt: number;
}

// Cœur pur (now injecté) → testable. true = autorisé, false = quota dépassé.
export function allow(
  store: Map<string, Bucket>,
  key: string,
  max: number,
  windowMs: number,
  now: number,
): boolean {
  let bucket = store.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    store.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count <= max;
}

// preHandler Fastify : limite `max` requêtes par IP et par fenêtre.
export function ipRateLimit(max: number, windowMs: number) {
  const store = new Map<string, Bucket>();
  // Purge périodique des entrées expirées. unref() → n'empêche pas la sortie du
  // process (important pour que les tests se terminent).
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of store) if (now >= bucket.resetAt) store.delete(key);
  }, windowMs);
  timer.unref?.();

  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!allow(store, request.ip, max, windowMs, Date.now())) {
      return reply.code(429).send({ error: 'too many requests' });
    }
  };
}
