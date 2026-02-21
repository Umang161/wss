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
  onSocketClose as routingOnSocketClose,
} from './routing';

const PORT = config.port;
const server = http.createServer();
const wss = new WebSocketServer({ server });

type ExtendedWebSocket = WebSocket & { isAlive?: boolean; data?: SocketData };

function sendEnvelope(ws: WebSocket, envelope: EventEnvelope): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(envelope));
}

function closeWithAuthError(ws: WebSocket, message: string): void {
  console.warn('[WS] Closing connection:', message);
  sendEnvelope(ws, { type: 'auth_error', version: 1, payload: { message } });
  ws.close(4001, message);
}

// ── Connection handler ──────────────────────────────────────────────

wss.on('connection', (socket: ExtendedWebSocket) => {
  const now = Date.now();
  console.log('[WS] Client connected');

  socket.data = {
    authState: 'UNAUTHENTICATED',
    connectedAt: now,
    lastActivityAt: now,
  };

  socket.on('message', (raw) => {
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
          const context = verifyAndDecode(token);
          data.authState = 'AUTHENTICATED';
          data.context = context;
          data.token = token;

          if (context.role === 'human_agent') {
            registerHumanAgentSocket(socket, context);
          }

          sendEnvelope(socket, { type: 'auth_ok', version: 1, payload: {} });
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
    console.log('[WS] Client disconnected', code, reason?.toString() || '');
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
