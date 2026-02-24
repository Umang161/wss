/**
 * WebSocket gateway: authenticate sockets, enforce permissions,
 * delegate events to the routing orchestrator.
 */
import 'dotenv/config';
import http from 'http';
import { config } from './config';
import { verifyAndDecode } from './auth';
import { WebSocketServer, WebSocket } from 'ws';
import type { EventEnvelope, AuthPayload, SocketData } from './types';
import { canSendEvent, isAllowedBeforeAuth } from './permissions';
import {
  handleEvent,
  registerHumanAgentSocket,
  pushAgentClaimedSessions,
  onSocketClose as routingOnSocketClose,
} from './routing';

const PORT = config.port;

// Handle normal HTTP requests (required for Nginx proxy - otherwise 504 on health checks)
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});

const wss = new WebSocketServer({ server });

type ExtendedWebSocket = WebSocket & { isAlive?: boolean; data?: SocketData };

function sendEnvelope(ws: WebSocket, envelope: EventEnvelope): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(envelope));
}

function closeWithAuthError(ws: WebSocket, message: string): void {
  console.warn('[WS] Closing connection:', message);
  sendEnvelope(ws, { type: 'auth_error', version: 1, payload: { message } });
  // WebSocket close reason max 123 bytes (UTF-8)
  const reason = Buffer.from(message, 'utf8').byteLength > 123
    ? message.slice(0, 60) + '…'
    : message;
  ws.close(4001, reason);
}

// ── Connection handler ──────────────────────────────────────────────

wss.on('connection', (socket: ExtendedWebSocket) => {
  const now = Date.now();
  const socketId = `ws-${Math.random().toString(36).slice(2, 10)}`;
  console.log('[WS] Client connected', socketId);

  socket.data = {
    socketId,
    authState: 'UNAUTHENTICATED',
    connectedAt: now,
    lastActivityAt: now,
  };

  socket.on('message', async (raw) => {
    let envelope: EventEnvelope;
    try {
      const parsed = JSON.parse(raw.toString());
      if (!parsed || typeof parsed.type !== 'string') {
        sendEnvelope(socket, {
          type: 'error',
          version: 1,
          payload: { message: 'Invalid envelope: missing type' },
        });
        return;
      }
      envelope = parsed as EventEnvelope;
    } catch {
      sendEnvelope(socket, {
        type: 'error',
        version: 1,
        payload: { message: 'Invalid JSON' },
      });
      return;
    }

    const data = socket.data!;

    // ── Unauthenticated phase ─────────────────────────────────────
    if (data.authState === 'UNAUTHENTICATED') {
      if (!isAllowedBeforeAuth(envelope.type)) {
        sendEnvelope(socket, {
          type: 'error',
          version: 1,
          payload: { message: 'Send auth first. Only auth or ping allowed before authentication.' },
        });
        return;
      }

      if (envelope.type === 'auth') {
        const payload = envelope.payload as AuthPayload;
        const token = payload?.token;
        if (!token || typeof token !== 'string') {
          closeWithAuthError(socket, 'Missing or invalid auth payload');
          return;
        }
        try {
          const context = await verifyAndDecode(token);
          // Chat users (Supabase): allow optional tenant_id from embed when token has none
          if (context.role === 'user' && !context.tenant_id && typeof payload.tenant_id === 'string' && payload.tenant_id.trim()) {
            context.tenant_id = payload.tenant_id.trim();
          }
          data.authState = 'AUTHENTICATED';
          data.context = context;
          data.token = token;

          if (context.role === 'human_agent') {
            const tokenPreview = token.length > 50 ? `${token.slice(0, 30)}…${token.slice(-15)}` : token;
            console.log(`[WS] Agent auth token received: ${tokenPreview}`);
            registerHumanAgentSocket(socket, context);
            const workspaces = (context.workspace_ids?.length ? context.workspace_ids : (context.tenant_id ? [context.tenant_id] : [])) as string[];
            const wsList = workspaces.length ? workspaces.map((w) => w.slice(0, 8) + '…').join(', ') : '(none)';
            console.log(`[WS] Agent joined broadcast list: socketId=${data.socketId ?? '?'} user_id=${context.user_id.slice(0, 8)}… workspaces=[${wsList}]`);
            pushAgentClaimedSessions(socket, context, token).catch((err) => {
              console.warn('[WS] Failed to push agent claimed sessions:', err);
            });
          } else if (context.role === 'user') {
            const wsList = context.tenant_id ? context.tenant_id : '(none)';
            console.log(`[WS] Embedded chat (user) connected: socketId=${data.socketId ?? '?'} workspace=${wsList}`);
          }

          const tenantId = context.tenant_id || (context.workspace_ids?.[0] as string | undefined) || '';
          sendEnvelope(socket, {
            type: 'auth_ok',
            version: 1,
            payload: { socket_id: data.socketId, tenant_id: tenantId },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Invalid token';
          closeWithAuthError(socket, message);
        }
        return;
      }

      if (envelope.type === 'ping') {
        sendEnvelope(socket, { type: 'pong', version: 1, payload: {} });
        return;
      }
      return;
    }

    // ── Authenticated phase ───────────────────────────────────────
    data.lastActivityAt = Date.now();

    if (envelope.type === 'ping') {
      sendEnvelope(socket, { type: 'pong', version: 1, payload: {} });
      return;
    }

    if (!canSendEvent(data.context!.role, envelope.type)) {
      sendEnvelope(socket, {
        type: 'error',
        version: 1,
        payload: { message: `Permission denied for event: ${envelope.type}` },
      });
      return;
    }

    handleEvent(envelope, socket, data).catch((err) => {
      console.error('Event handling error:', err);
      sendEnvelope(socket, {
        type: 'error',
        version: 1,
        payload: {
          message: err instanceof Error ? err.message : 'Internal server error',
        },
      });
    });
  });

  socket.on('close', (code, reason) => {
    const sid = (socket as ExtendedWebSocket).data?.socketId;
    console.log('[WS] Client disconnected', sid ? `socketId=${sid}` : '', code, reason?.toString() || '');
    routingOnSocketClose(socket);
  });

  socket.on('error', () => {
    // no-op, close event will handle cleanup
  });
});

// ── Heartbeat (keepalive only; do not disconnect on missed pong) ───
// Some clients/proxies don't respond to WS pings; terminating would drop them.

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((s) => {
    const socket = s as ExtendedWebSocket;
    if (socket.readyState === 1) socket.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`WebSocket gateway listening on ws://${HOST}:${PORT}`);
});
