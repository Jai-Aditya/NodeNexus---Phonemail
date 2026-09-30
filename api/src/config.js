// Settings from environment variables.

// Values that appear in examples and must never protect a real deployment.
const WEAK_TOKENS = new Set(['change-me-dev-token', 'change-me', 'secret', 'changeme']);

export function loadConfig(env = process.env) {
  const bool = (name, def) => (env[name] === undefined || env[name] === '' ? def : env[name] === 'true');
  const int = (name, def) => {
    const v = env[name];
    if (v === undefined || v === '') return def;
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
    return n;
  };

  const twilio = {
    accountSid: env.TWILIO_ACCOUNT_SID || '',
    authToken: env.TWILIO_AUTH_TOKEN || '',
    verifySid: env.TWILIO_VERIFY_SID || '',
    fromNumber: env.TWILIO_FROM_NUMBER || '',
    validateSignature: bool('TWILIO_VALIDATE_SIGNATURE', true),
  };
  const twilioVerifyReady = Boolean(twilio.accountSid && twilio.authToken && twilio.verifySid);

  // AUTH_MODE: auto | twilio | console | password
  //   twilio   = one-time codes sent by SMS through Twilio Verify
  //   console  = one-time codes printed in the server log (development only)
  //   password = phone number + password (the brief's fallback when no OTP provider is available)
  //   auto     = twilio if its settings are present, otherwise password
  let authMode = (env.AUTH_MODE || 'auto').toLowerCase();
  if (authMode === 'auto') authMode = twilioVerifyReady ? 'twilio' : 'password';
  if (!['twilio', 'console', 'password'].includes(authMode)) {
    throw new Error(`AUTH_MODE must be auto, twilio, console or password (got "${env.AUTH_MODE}")`);
  }
  if (authMode === 'twilio' && !twilioVerifyReady) {
    throw new Error('AUTH_MODE=twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_VERIFY_SID');
  }

  const cfg = {
    port: int('PORT', 3000),
    databaseUrl: env.DATABASE_URL || 'postgres://phonemail:phonemail@localhost:5432/phonemail',
    mailServiceUrl: (env.MAIL_SERVICE_URL || 'http://localhost:8081').replace(/\/+$/, ''),
    internalToken: env.INTERNAL_TOKEN || '',
    mailDomain: (env.MAIL_DOMAIN || 'phonemail.com').toLowerCase(),
    // RESERVED_ALIASES: names on our domain that belong to something else on the server (e.g. an
    // ordinary mailbox like office@phonemail.com), so nobody can take them as an alias.
    reservedAliases: (env.RESERVED_ALIASES || '').split(',').map((s) => s.trim().toLowerCase().split('@')[0]).filter(Boolean),
    defaultCountryCode: (env.DEFAULT_COUNTRY_CODE || '91').replace(/\D/g, ''),
    authMode,
    twilio,
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    cookieSecure: bool('COOKIE_SECURE', false),
    sessionDays: int('SESSION_DAYS', 30),
    corsOrigins: (env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    // true behind one reverse proxy (nginx) that appends the client's address to
    // X-Forwarded-For; the API then uses the last entry, the one nginx wrote.
    trustProxy: bool('TRUST_PROXY', false),
    avatarDir: env.AVATAR_DIR || './data/avatars',
    smsAlerts: bool('SMS_ALERTS', true),
    vapidSubject: env.VAPID_SUBJECT || `mailto:admin@${(env.MAIL_DOMAIN || 'phonemail.com').toLowerCase()}`,
    allowInsecurePush: bool('ALLOW_INSECURE_PUSH', false), // tests only: allow http push endpoints
    migrateOnStart: bool('MIGRATE_ON_START', true),
    // Country codes we text (OTP, alerts, sign-up replies). Stops "SMS pumping" fraud,
    // where bots request codes to expensive foreign numbers. Default: DEFAULT_COUNTRY_CODE.
    // TEST_PHONE_PREFIX: numbers kept for testing (e.g. +9155555): they are never texted, not even
    // sign-in codes, so made-up test accounts can't reach a real person. They sign in with a password.
    testPhonePrefix: (env.TEST_PHONE_PREFIX || '').trim(),
    smsCountryCodes: (env.SMS_COUNTRY_CODES || env.DEFAULT_COUNTRY_CODE || '91')
      .split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean),
    // Sending limits per user (new emails and replies), and at most one SMS alert per
    // person per chat in this many minutes.
    sendPerMinute: int('SEND_PER_MINUTE', 30),
    sendPerDay: int('SEND_PER_DAY', 500),
    smsAlertMinutes: int('SMS_ALERT_MINUTES', 10),
    // How fast alert texts leave our number. A US long-code number takes about 1 per
    // second; toll-free and short codes take more (raise this if Twilio says so).
    smsPerSecond: Math.max(1, int('SMS_PER_SECOND', 1)),
    maxStreamsPerUser: int('MAX_STREAMS_PER_USER', 5),
  };
  if (!cfg.internalToken) throw new Error('INTERNAL_TOKEN is required (the same secret the mail service uses)');
  if (WEAK_TOKENS.has(cfg.internalToken) || (env.NODE_ENV === 'production' && cfg.internalToken.length < 32)) {
    throw new Error('INTERNAL_TOKEN is a default or too short: set a random value of 32+ characters, '
      + 'e.g. the output of: openssl rand -hex 32');
  }
  return cfg;
}
