function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variable d'environnement manquante : ${name}`);
  return value;
}

const port = Number(process.env.PORT ?? 3000);

export const config = {
  databaseUrl: required('DATABASE_URL'),
  clickhouseUrl: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  clickhouseUser: process.env.CLICKHOUSE_USER ?? 'gamerank',
  clickhousePassword: process.env.CLICKHOUSE_PASSWORD ?? 'gamerank',
  clickhouseDb: process.env.CLICKHOUSE_DB ?? 'gamerank',
  appUrl: process.env.APP_URL ?? `http://localhost:${port}`,
  port,
  smtpHost: process.env.SMTP_HOST ?? 'localhost',
  smtpPort: Number(process.env.SMTP_PORT ?? 1025),
  // TLS direct si port 465, sinon STARTTLS/clair. Surchargeable par SMTP_SECURE.
  smtpSecure: process.env.SMTP_SECURE
    ? process.env.SMTP_SECURE === 'true'
    : Number(process.env.SMTP_PORT ?? 1025) === 465,
  smtpUser: process.env.SMTP_USER ?? '',
  smtpPass: process.env.SMTP_PASS ?? '',
  // Accepte un certif auto-signé (ex. Poste.io sans Let's Encrypt, app et
  // serveur mail sur le même VPS). La connexion reste chiffrée.
  smtpTlsInsecure: process.env.SMTP_TLS_INSECURE === 'true',
  mailFrom: process.env.MAIL_FROM ?? 'WebGameRank <no-reply@webgamerank.local>',
  adminEmails: (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
  isProduction: process.env.NODE_ENV === 'production',

  maxGamesPerDeveloper: Number(process.env.MAX_GAMES_PER_DEVELOPER ?? 15),
  uploadsDir: process.env.UPLOADS_DIR ?? 'uploads',
  voteMinActiveMs: Number(process.env.VOTE_MIN_ACTIVE_MS ?? 10_000),
  voteChangeCooldownHours: Number(process.env.VOTE_CHANGE_COOLDOWN_HOURS ?? 24),
  // Anti-triche : durée de vie d'un jeton de vote one-shot (émis au clic réel).
  voteTokenTtlSeconds: Number(process.env.VOTE_TOKEN_TTL_SECONDS ?? 120),
  // Anti-triche : un seul vote par IP et par jeu (bloque le re-vote après reset
  // du localStorage). ⚠️ IP partagée (foyer/CGNAT/école) = un seul vote pour
  // tous. Désactivable si le taux de faux positifs devient gênant.
  voteOnePerIp: process.env.VOTE_ONE_PER_IP !== 'false',
  // Rate-limit par IP (protection flood/DoS). Fenêtre + plafonds par famille.
  rateWindowSeconds: Number(process.env.RATE_WINDOW_SECONDS ?? 60),
  // Heartbeat SDK en backoff (5s→135s) : ~2-3/min en régime. 60/min (1/s) couvre
  // les pics légitimes d'UNE IP (reload + multi-onglets) sans plus.
  rateIngestMax: Number(process.env.RATE_INGEST_MAX ?? 60),
  rateVoteMax: Number(process.env.RATE_VOTE_MAX ?? 30), // clics rares
  // Tripwire : salts acceptés pour ctx = mix(token+salt). Le 1er = courant (celui
  // du SDK). Rotation : ajouter le nouveau en tête, garder l'ancien un temps.
  tripwireSalts: (process.env.TRIPWIRE_SALTS ?? 'wr1:k9x2mP7q')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  maxThumbnailBytes: Number(process.env.MAX_THUMBNAIL_BYTES ?? 2 * 1024 * 1024),

  magicLinkTtlMinutes: 15,
  magicLinkThrottleSeconds: 60,
  sessionTtlDays: 30,

  // Épic 7 — tous ces paramètres sont volontairement configurables (CDC §13).
  scoring: {
    // Intervalle du pipeline agrégation + score, en secondes (0 = désactivé).
    pipelineIntervalSeconds: Number(process.env.PIPELINE_INTERVAL_SECONDS ?? 30),
    decayFactor: Number(process.env.DECAY_FACTOR ?? 0.95),
    qualifiedVisitorMs: Number(process.env.QUALIFIED_VISITOR_MS ?? 30_000),
    activeDayMs: Number(process.env.ACTIVE_DAY_MS ?? 60_000),
    cohortDays: Number(process.env.COHORT_DAYS ?? 7),
    medianWindowDays: 30,
    // P (jury des pairs, épic 3) : barème sur 7 (5 élections + 2 consensus).
    // Valeur par défaut avant tout jugement : 2/7.
    peerDefaultRatio: Number(process.env.PEER_DEFAULT_RATIO ?? 2 / 7),
    // Jury : nombre de jeux à juger, d'élus, temps min par jeu, présentations.
    juryGamesToJudge: Number(process.env.JURY_GAMES_TO_JUDGE ?? 5),
    juryElections: Number(process.env.JURY_ELECTIONS ?? 2),
    juryMinPlayMs: Number(process.env.JURY_MIN_PLAY_MS ?? 20_000),
    juryPresentationsToRank: Number(process.env.JURY_PRESENTATIONS_TO_RANK ?? 5),
    // Dégressivité par préfixe IP (CDC §4.1), 5 niveaux du plus large au plus
    // fin : sévère sur l'IP exacte, quasi neutre sur le bloc opérateur.
    // v6 : le /64 est l'équivalent du /32 v4 (un foyer = un /64 entier,
    // et les extensions de confidentialité font tourner les /128).
    prefixLevels: [
      { v4: 8, v6: 32, exponent: 0.9 },
      { v4: 16, v6: 48, exponent: 0.85 },
      { v4: 20, v6: 56, exponent: 0.75 },
      { v4: 24, v6: 64, exponent: 0.65 },
      { v4: 32, v6: 128, exponent: 0.5 },
    ],
    // Partage inter-jeux (§4.1) : une IP/un bloc actif sur N jeux ne compte
    // pas N fois. part = (usage local / usage plateforme)^(1−γ) ; γ=1 → off.
    crossGameExponent: Number(process.env.CROSS_GAME_EXPONENT ?? 0.7),
    // Concentration des votes d'une même IP sur un même jeu : n^0,5.
    voteIpExponent: Number(process.env.VOTE_IP_EXPONENT ?? 0.5),
    // Constantes de confiance (shrinkage vers le prior global, CDC §7.3).
    shrinkSamples: { fidelity: 20, session: 20, engagement: 50 },
    // Bornes de référence des échelles absolues (CDC §6) — à recalibrer.
    referenceBounds: {
      visitors: 1000,
      activeHours: 500,
      voters: 200,
      fidelity: 0.4,
      medianMinutes: 15,
      engagement: 1,
    },
    weights: {
      g: { v: 0.5, t: 0.35, x: 0.15 },
      q: { r: 0.35, s: 0.25, v: 0.25, e: 0.15 },
      final: { g: 0.3, q: 0.55, p: 0.15 },
    },
  },
};
