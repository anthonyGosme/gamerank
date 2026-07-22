import { config } from './config.js';

// Tripwire anti-triche (PAS de la crypto). Le vrai SDK envoie
// ctx = mix(token + salt) ; le serveur recalcule et compare EN SILENCE.
// Une requête sans ctx / avec un ctx faux = très probablement une requête
// bricolée (curl, vieux SDK) → on la laisse passer mais on la flag.
// Le salt/algo étant côté client, ça n'authentifie pas — ça détecte le paresseux.

// FNV-1a 32 bits — implémentation IDENTIQUE côté SDK (packages/sdk widget.ts).
// Non-crypto exprès : rapide, déterministe, moins « devinable » que sha256.
export function mix(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// true si ctx correspond à mix(token+salt) pour l'un des salts acceptés.
// Plusieurs salts = période de grâce lors d'une rotation (nouveau + ancien).
export function tripwireOk(token: string, ctx: unknown): boolean {
  if (typeof ctx !== 'string' || ctx.length === 0) return false;
  return config.tripwireSalts.some((salt) => mix(token + salt) === ctx);
}
