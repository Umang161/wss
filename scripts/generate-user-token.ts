/**
 * Generate a JWT for chat UI user. Uses same secret as WSS.
 * Usage: npx ts-node scripts/generate-user-token.ts
 */
import jwt from 'jsonwebtoken';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const secret = process.env.JWT_SECRET || process.env.JWT_PUBLIC_KEY || 'change-me';
const issuer = process.env.JWT_ISSUER;
const audience = process.env.JWT_AUDIENCE;

const now = Math.floor(Date.now() / 1000);
const exp = now + 10 * 24 * 60 * 60; // 10 days

const payload = {
  sub: 'user-001',
  tenant_id: 'e262c031-d67b-496d-a0dd-1c99df0e4d71',
  role: 'user',
  permissions: [] as string[],
  iat: now,
  exp,
};

const options: jwt.SignOptions = { algorithm: 'HS256' };
if (issuer) options.issuer = issuer;
if (audience) options.audience = audience;

const token = jwt.sign(payload, secret, options);

console.log('Chat UI user JWT (10 days):');
console.log(token);
console.log('\nPayload:', JSON.stringify(payload, null, 2));
