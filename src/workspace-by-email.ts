/**
 * Fetch workspace IDs from Supabase by human agent email.
 * Uses members table (email → workspace_id) and Workspaces table (profile_id → id).
 * Requires SUPABASE_SERVICE_ROLE_KEY to bypass RLS.
 */
import { config } from './config';

export async function fetchWorkspaceIdsByEmail(
  email: string,
  profileId: string
): Promise<string[]> {
  const url = config.supabaseUrl;
  const key = config.supabaseServiceRoleKey;
  if (!url || !key) {
    return [];
  }
  const base = url.replace(/\/$/, '');
  const seen = new Set<string>();

  try {
    // 1. members: email → workspace_id (shared workspaces)
    const emailNorm = String(email || '').trim().toLowerCase();
    if (emailNorm && emailNorm.includes('@')) {
      const membersRes = await fetch(
        `${base}/rest/v1/members?email=eq.${encodeURIComponent(emailNorm)}&status=eq.active&select=workspace_id`,
        {
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
        }
      );
      if (membersRes.ok) {
        const rows = (await membersRes.json()) as Array<{ workspace_id: string }>;
        for (const r of rows) {
          if (r?.workspace_id) seen.add(String(r.workspace_id));
        }
      }
    }

    // 2. Workspaces: profile_id → id (owned workspaces)
    if (profileId) {
      const wsRes = await fetch(
        `${base}/rest/v1/Workspaces?profile_id=eq.${encodeURIComponent(profileId)}&select=id`,
        {
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
        }
      );
      if (wsRes.ok) {
        const rows = (await wsRes.json()) as Array<{ id: string }>;
        for (const r of rows) {
          if (r?.id) seen.add(String(r.id));
        }
      }
    }

    return Array.from(seen);
  } catch (err) {
    console.warn('[Workspace] fetch by email error:', err instanceof Error ? err.message : err);
    return [];
  }
}
