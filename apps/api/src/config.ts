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
  mailFrom: process.env.MAIL_FROM ?? 'GameRank <no-reply@gamerank.local>',
  adminEmails: (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
  isProduction: process.env.NODE_ENV === 'production',

  maxGamesPerDeveloper: Number(process.env.MAX_GAMES_PER_DEVELOPER ?? 5),
  uploadsDir: process.env.UPLOADS_DIR ?? 'uploads',
  voteMinActiveMs: Number(process.env.VOTE_MIN_ACTIVE_MS ?? 10_000),
  voteChangeCooldownHours: Number(process.env.VOTE_CHANGE_COOLDOWN_HOURS ?? 24),
  maxThumbnailBytes: Number(process.env.MAX_THUMBNAIL_BYTES ?? 2 * 1024 * 1024),

  magicLinkTtlMinutes: 15,
  magicLinkThrottleSeconds: 60,
  sessionTtlDays: 30,
};
