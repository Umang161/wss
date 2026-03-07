export const config = {
  port: Number(process.env.PORT) || 8080,

  authTimeoutSeconds: Number(process.env.AUTH_TIMEOUT_SECONDS) || 5,
  idleTimeoutSeconds: Number(process.env.IDLE_TIMEOUT_SECONDS) || 90,
  maxConnectionLifetimeSeconds:
    Number(process.env.MAX_CONNECTION_LIFETIME_SECONDS) || 30 * 60,
  maxUnauthenticatedPerIp: Number(process.env.MAX_UNAUTH_PER_IP) || 10,

  jwtSecret: process.env.JWT_SECRET || process.env.JWT_PUBLIC_KEY || 'change-me',
  jwtIssuer: process.env.JWT_ISSUER,
  jwtAudience: process.env.JWT_AUDIENCE,

  /** Base URL of the AI agent HTTP API (no trailing slash). */
  aiServerAddress: process.env.AI_SERVER_ADDRESS || 'https://25a5-106-219-176-243.ngrok-free.app',

  /** Timeout in ms for AI HTTP calls. */
  aiRequestTimeoutMs: Number(process.env.AI_REQUEST_TIMEOUT_MS) || 30_000,
  /** Max buffered SSE chunk data before aborting stream parse. */
  aiSseMaxBufferBytes: Number(process.env.AI_SSE_MAX_BUFFER_BYTES) || 256_000,
  /** Max size of a single SSE event data block. */
  aiSseMaxEventBytes: Number(process.env.AI_SSE_MAX_EVENT_BYTES) || 128_000,

  /** Base URL of the CRUD / HITL backend API (no trailing slash). */
  crudServerAddress: process.env.CRUD_SERVER_ADDRESS || 'https://api.zoft.ai',

  /** Timeout in ms for CRUD API HTTP calls. */
  crudRequestTimeoutMs: Number(process.env.CRUD_REQUEST_TIMEOUT_MS) || 10_000,

  /** Supabase project URL for JWT verification (e.g. https://xxx.supabase.co). Enables Supabase JWT auth for helpdesk. */
  supabaseUrl: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,

  /** Supabase anon key (required for auth API calls). From Project Settings > API. */
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_KEY,

  /** Supabase service role key (for server-side DB queries by email). From Project Settings > API. */
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY,

  /** Supabase JWT secret (from Project Settings > API). Required for legacy Supabase projects where JWKS returns empty keys. */
  supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET,

  /** Max accepted WebSocket frame bytes from clients. */
  wsMaxPayloadBytes: Number(process.env.WS_MAX_PAYLOAD_BYTES) || 64_000,
  /** Max chat message length accepted from user/agent payloads. */
  wsMaxMessageChars: Number(process.env.WS_MAX_MESSAGE_CHARS) || 8_000,
} as const;
