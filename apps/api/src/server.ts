import { buildApp } from './app.js';
import { config } from './config.js';
import { ensureClickhouseSchema } from './clickhouse.js';

// Ne bloque pas le démarrage si ClickHouse n'est pas encore prêt : l'API
// web reste disponible, l'ingestion échouera silencieusement en attendant.
try {
  await ensureClickhouseSchema();
} catch (err) {
  console.warn('ClickHouse indisponible au démarrage (schéma non vérifié) :', (err as Error).message);
}

const app = await buildApp();
await app.listen({ port: config.port, host: '0.0.0.0' });
