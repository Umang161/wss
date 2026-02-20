import jwt from 'jsonwebtoken';
import { config } from './config';
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

export function verifyAndDecode(token: string): SocketContext {
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
