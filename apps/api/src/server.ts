import { buildApp } from './app.js';
import { config } from './config.js';
import { ensureClickhouseSchema } from './clickhouse.js';
import { runPipeline } from './scoring/score.js';

// Ne bloque pas le démarrage si ClickHouse n'est pas encore prêt : l'API
// web reste disponible, l'ingestion échouera silencieusement en attendant.
try {
  await ensureClickhouseSchema();
} catch (err) {
  console.warn('ClickHouse indisponible au démarrage (schéma non vérifié) :', (err as Error).message);
}

const app = await buildApp();
await app.listen({ port: config.port, host: '0.0.0.0' });

// Pipeline agrégation + scoring (épic 7), cadence en secondes (0 = off).
if (config.scoring.pipelineIntervalSeconds > 0) {
  const tick = () =>
    runPipeline().catch((err) => app.log.warn({ err }, 'scoring pipeline failed'));
  setTimeout(tick, 5000);
  setInterval(tick, config.scoring.pipelineIntervalSeconds * 1000);
}
