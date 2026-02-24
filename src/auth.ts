import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { config } from './config';
import { fetchWorkspaceIdsByEmail } from './workspace-by-email';
import type { SocketContext, Role } from './types';

export interface JwtPayload {
  sub: string;
  tenant_id?: string;
  role?: Role;
  permissions?: string[];
  exp?: number;
  iss?: string;
  aud?: string | string[];
}

function verifyCustomToken(token: string): SocketContext {
  const options: jwt.VerifyOptions = {};
  if (config.jwtIssuer) options.issuer = config.jwtIssuer;
  if (config.jwtAudience) options.audience = config.jwtAudience;

  const decoded = jwt.verify(token, config.jwtSecret, options) as JwtPayload;

  const tenant_id =
    typeof decoded.tenant_id === 'string' ? decoded.tenant_id : '';
  const user_id = typeof decoded.sub === 'string' ? decoded.sub : '';
  const role: Role =
    decoded.role === 'user' || decoded.role === 'human_agent'
      ? decoded.role
      : 'user';
  const permissions = Array.isArray(decoded.permissions)
    ? decoded.permissions
    : [];

  return {
    tenant_id,
    user_id,
    role,
    permissions,
    authenticatedAt: Date.now(),
  };
}

/** Verify Supabase token via API (GET /auth/v1/user). No JWT secret needed. */
async function verifySupabaseTokenViaApi(
  token: string,
  supabaseUrl: string
): Promise<SocketContext> {
  const anonKey = config.supabaseAnonKey;
  if (!anonKey) {
    throw new Error(
      'Supabase anon key required for auth API. Set SUPABASE_ANON_KEY (from Project Settings > API).'
    );
  }
  const base = supabaseUrl.replace(/\/$/, '');
  const res = await fetch(`${base}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: anonKey,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase auth failed: ${res.status} ${body}`);
  }
  const user = (await res.json()) as { id?: string; email?: string };
  console.log('[Auth] Supabase /auth/v1/user response:', JSON.stringify(user, null, 2));
  const user_id = typeof user?.id === 'string' ? user.id : '';
  const email = typeof user?.email === 'string' ? user.email : '';
  if (!user_id) throw new Error('Invalid Supabase token: missing user id');

  let tenant_id = '';
  let workspace_ids: string[] = [];
  try {
    const wr = await fetch(`${config.crudServerAddress}/workspace/all`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await wr.json().catch(() => ({}))) as { workspaces?: Array<{ id?: string; workspace_id?: string }> };
    if (wr.ok) {
      const list = data.workspaces ?? [];
      workspace_ids = list.map((w) => (w.id ?? w.workspace_id) as string).filter(Boolean);
      if (workspace_ids.length > 0) tenant_id = workspace_ids[0];
    }
    if (workspace_ids.length === 0 && email) {
      workspace_ids = await fetchWorkspaceIdsByEmail(email, user_id);
      if (workspace_ids.length > 0) {
        tenant_id = workspace_ids[0];
        console.log(`[Auth] Fetched workspaces by email for ${email.slice(0, 20)}…: ${workspace_ids.length} workspace(s)`);
      }
    }
    if (workspace_ids.length === 0) {
      console.log(`[Auth] Chat user (no workspaces): ${user_id.slice(0, 8)}… (email: ${email || '(none)'})`);
    }
  } catch (err) {
    console.warn('[Auth] workspace fetch error:', err instanceof Error ? err.message : err);
  }

  const role: Role = workspace_ids.length > 0 ? 'human_agent' : 'user';
  return {
    tenant_id,
    user_id,
    role,
    permissions: [],
    authenticatedAt: Date.now(),
    ...(workspace_ids.length > 0 && { workspace_ids }),
  };
}

async function verifySupabaseToken(token: string): Promise<SocketContext> {
  const supabaseUrl = config.supabaseUrl;
  if (!supabaseUrl || typeof supabaseUrl !== 'string') {
    throw new Error('Supabase JWT verification requires SUPABASE_URL');
  }

  // Try JWKS first (Supabase projects with asymmetric signing keys)
  const jwksUri = `${supabaseUrl.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`;
  const res = await fetch(jwksUri);
  const jwks = (await res.json()) as { keys?: unknown[] };
  const hasKeys = Array.isArray(jwks?.keys) && jwks.keys.length > 0;

  if (!hasKeys) {
    console.log('[Auth] JWKS endpoint returned no keys, verifying via Supabase auth API');
    return verifySupabaseTokenViaApi(token, supabaseUrl);
  }

  // JWKS has keys — verify with RS256
  const client = jwksClient({ jwksUri, cache: true, rateLimit: true });
  const getKey = (header: jwt.JwtHeader, cb: jwt.SigningKeyCallback) => {
    client.getSigningKey(header.kid, (err, key) => {
      if (err) return cb(err);
      cb(null, key?.getPublicKey());
    });
  };

  const decoded = await new Promise<jwt.JwtPayload>((resolve, reject) => {
    jwt.verify(
      token,
      getKey,
      {
        algorithms: ['RS256'],
        issuer: `${supabaseUrl.replace(/\/$/, '')}/auth/v1`,
        audience: 'authenticated',
      },
      (err, payload) => {
        if (err) reject(err);
        else resolve(payload as jwt.JwtPayload);
      }
    );
  });

  const user_id = typeof decoded.sub === 'string' ? decoded.sub : '';
  const email = typeof (decoded as { email?: string }).email === 'string' ? (decoded as { email: string }).email : '';
  if (!user_id) throw new Error('Invalid Supabase token: missing sub');

  let tenant_id = '';
  let workspace_ids: string[] = [];
  try {
    const wr = await fetch(`${config.crudServerAddress}/workspace/all`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await wr.json().catch(() => ({}))) as { workspaces?: Array<{ id?: string; workspace_id?: string }> };
    if (wr.ok) {
      const list = data.workspaces ?? [];
      workspace_ids = list.map((w) => (w.id ?? w.workspace_id) as string).filter(Boolean);
      if (workspace_ids.length > 0) tenant_id = workspace_ids[0];
    }
    let emailToUse = email;
    if (workspace_ids.length === 0 && !emailToUse && config.supabaseAnonKey) {
      const userRes = await fetch(`${config.supabaseUrl!.replace(/\/$/, '')}/auth/v1/user`, {
        headers: { Authorization: `Bearer ${token}`, apikey: config.supabaseAnonKey },
      });
      if (userRes.ok) {
        const u = (await userRes.json()) as { email?: string };
        console.log('[Auth] Supabase /auth/v1/user response (email fetch):', JSON.stringify(u, null, 2));
        emailToUse = typeof u?.email === 'string' ? u.email : '';
      }
    }
    if (workspace_ids.length === 0 && emailToUse) {
      workspace_ids = await fetchWorkspaceIdsByEmail(emailToUse, user_id);
      if (workspace_ids.length > 0) {
        tenant_id = workspace_ids[0];
        console.log(`[Auth] Fetched workspaces by email for ${emailToUse.slice(0, 20)}…: ${workspace_ids.length} workspace(s)`);
      }
    }
    if (workspace_ids.length === 0) {
      console.log(`[Auth] Chat user (no workspaces): ${user_id.slice(0, 8)}… (email: ${emailToUse || '(none)'})`);
    }
  } catch (err) {
    console.warn('[Auth] workspace fetch error:', err instanceof Error ? err.message : err);
  }

  // Chat user: no workspaces → role 'user'. Helpdesk agent: has workspaces → role 'human_agent'.
  const role: Role = workspace_ids.length > 0 ? 'human_agent' : 'user';

  return {
    tenant_id,
    user_id,
    role,
    permissions: [],
    authenticatedAt: Date.now(),
    ...(workspace_ids.length > 0 && { workspace_ids }),
  };
}

/**
 * Verify token for chat users (Supabase) or helpdesk agents (Supabase or custom JWT).
 * Order: Supabase first when configured, then custom JWT as fallback.
 * Chat users: Supabase token with no workspaces → role 'user'.
 * Helpdesk agents: Supabase token with workspaces, or custom JWT → role 'human_agent'.
 */
export async function verifyAndDecode(token: string): Promise<SocketContext> {
  // 1. Try Supabase first when configured (chat users + helpdesk agents using Supabase)
  if (config.supabaseUrl) {
    try {
      return await verifySupabaseToken(token);
    } catch (supabaseErr) {
      // Supabase failed — fall through to custom JWT
    }
  }

  // 2. Fallback: custom JWT (helpdesk agents using JWT_SECRET)
  try {
    return verifyCustomToken(token);
  } catch (customErr) {
    if (config.supabaseUrl) {
      console.error('[Auth] Supabase JWT failed');
      console.error('[Auth] Custom JWT failed:', (customErr as Error).message);
    } else {
      console.error('[Auth] Custom JWT failed:', (customErr as Error).message);
    }
    throw new Error('Invalid token');
  }
}
