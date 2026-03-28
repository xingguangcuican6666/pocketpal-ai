/**
 * LocalApiServer — a minimal OpenAI-compatible HTTP/1.1 server.
 *
 * Exposes two endpoints so other apps can use the on-device model:
 *   GET  /v1/models              — lists the currently loaded model
 *   POST /v1/chat/completions    — runs a (streaming) chat completion
 *
 * The server runs on localhost only (127.0.0.1) so it is only reachable from
 * other apps on the same device.  The port is configurable (default 8080).
 *
 * Implementation notes
 * --------------------
 * React Native does not expose Node's `net` module, so we use the
 * `react-native-tcp-socket` package which provides a compatible `net`-like API
 * via a native module.  The HTTP parsing is hand-rolled but deliberately
 * minimal — we only handle the two methods we advertise.
 */

import TcpSocket from 'react-native-tcp-socket';
import {CompletionEngine} from '../utils/completionTypes';
import {Model} from '../utils/types';

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export interface LocalApiServerOptions {
  port?: number;
  /** Timeout (ms) for a single completion before the server gives up */
  completionTimeoutMs?: number;
}

export interface LocalApiServerCallbacks {
  /** Called once the TCP server is actually listening */
  onStarted?: (port: number) => void;
  /** Called after the server has been fully stopped */
  onStopped?: () => void;
  /** Called with a human-readable error description */
  onError?: (err: string) => void;
}

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

const DEFAULT_PORT = 8080;
const COMPLETION_TIMEOUT_MS = 180_000; // 3 min

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Build an HTTP/1.1 response string. */
function httpResponse(
  statusCode: number,
  statusText: string,
  body: string,
  extraHeaders: Record<string, string> = {},
): string {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Length': String(Buffer.byteLength(body, 'utf8')),
    Connection: 'close',
    ...extraHeaders,
  };
  const headerStr = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n');
  return `HTTP/1.1 ${statusCode} ${statusText}\r\n${headerStr}\r\n\r\n${body}`;
}

/** Write a Server-Sent Events chunk to a socket. */
function writeSSEChunk(socket: any, data: object): void {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  try {
    socket.write(payload);
  } catch {
    // Socket may have been closed by the client
  }
}

/** Write the SSE "[DONE]" sentinel and HTTP chunk terminator. */
function writeSSEDone(socket: any): void {
  try {
    socket.write('data: [DONE]\n\n');
    // End chunked transfer
    socket.write('0\r\n\r\n');
  } catch {
    // ignore
  }
}

/** Generate a random ID string (no uuid dependency needed here). */
function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Current Unix timestamp in seconds. */
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// --------------------------------------------------------------------------
// Request parser
// --------------------------------------------------------------------------

interface ParsedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Very small HTTP/1.1 request parser.
 * Returns null when the buffer does not yet contain a complete request.
 */
function parseRequest(raw: string): ParsedRequest | null {
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd === -1) {
    return null;
  }

  const headerSection = raw.slice(0, headerEnd);
  const bodySection = raw.slice(headerEnd + 4);
  const lines = headerSection.split('\r\n');
  const requestLine = lines[0] ?? '';
  const parts = requestLine.split(' ');
  if (parts.length < 2) {
    return null;
  }
  const method = (parts[0] ?? '').toUpperCase();
  const path = parts[1] ?? '/';

  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(':');
    if (colon !== -1) {
      const key = lines[i].slice(0, colon).trim().toLowerCase();
      const val = lines[i].slice(colon + 1).trim();
      headers[key] = val;
    }
  }

  // Wait for the full body
  const contentLength = parseInt(headers['content-length'] ?? '0', 10);
  if (bodySection.length < contentLength) {
    return null;
  }

  return {method, path, headers, body: bodySection.slice(0, contentLength)};
}

// --------------------------------------------------------------------------
// Server class
// --------------------------------------------------------------------------

/** Holds everything needed to resolve a pending request. */
interface PendingCompletion {
  socket: any;
  abortController: AbortController;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export class LocalApiServer {
  private server: any = null;
  private pendingCompletions: Set<PendingCompletion> = new Set();

  constructor(
    private getEngine: () => CompletionEngine | undefined,
    private getActiveModel: () => Model | undefined,
    private options: LocalApiServerOptions = {},
    private callbacks: LocalApiServerCallbacks = {},
  ) {}

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  get isRunning(): boolean {
    return this.server !== null;
  }

  start(): void {
    if (this.server) {
      return;
    }

    const port = this.options.port ?? DEFAULT_PORT;

    const server = TcpSocket.createServer((socket: any) => {
      let buffer = '';

      socket.on('data', async (data: Buffer | string) => {
        buffer += typeof data === 'string' ? data : data.toString('utf8');

        const req = parseRequest(buffer);
        if (!req) {
          return; // Incomplete — wait for more data
        }
        buffer = ''; // Consumed

        await this.handleRequest(socket, req);
      });

      socket.on('error', () => {
        // Individual socket errors are non-fatal
      });
    });

    server.on('error', (err: Error) => {
      this.server = null;
      this.callbacks.onError?.(err.message);
    });

    server.listen({port, host: '127.0.0.1'}, () => {
      this.callbacks.onStarted?.(port);
    });

    this.server = server;
  }

  stop(): void {
    if (!this.server) {
      return;
    }

    // Abort all in-flight completions
    for (const pending of this.pendingCompletions) {
      clearTimeout(pending.timeoutHandle);
      pending.abortController.abort();
      try {
        pending.socket.destroy();
      } catch {
        // ignore
      }
    }
    this.pendingCompletions.clear();

    this.server.close(() => {
      this.server = null;
      this.callbacks.onStopped?.();
    });
    this.server = null;
  }

  // ------------------------------------------------------------------
  // Request routing
  // ------------------------------------------------------------------

  protected async handleRequest(
    socket: any,
    req: ParsedRequest,
  ): Promise<void> {
    // CORS pre-flight
    if (req.method === 'OPTIONS') {
      const res = httpResponse(204, 'No Content', '');
      socket.write(res);
      socket.destroy();
      return;
    }

    try {
      if (req.method === 'GET' && req.path === '/v1/models') {
        this.handleGetModels(socket);
      } else if (req.method === 'POST' && req.path === '/v1/chat/completions') {
        await this.handleChatCompletions(socket, req);
      } else {
        const body = JSON.stringify({
          error: {message: 'Not found', type: 'invalid_request_error'},
        });
        socket.write(httpResponse(404, 'Not Found', body));
        socket.destroy();
      }
    } catch (err: any) {
      try {
        const body = JSON.stringify({
          error: {
            message: err?.message ?? 'Internal error',
            type: 'server_error',
          },
        });
        socket.write(httpResponse(500, 'Internal Server Error', body));
        socket.destroy();
      } catch {
        // ignore
      }
    }
  }

  // ------------------------------------------------------------------
  // GET /v1/models
  // ------------------------------------------------------------------

  protected handleGetModels(socket: any): void {
    const model = this.getActiveModel();
    const data = model
      ? [
          {
            id: model.id,
            object: 'model',
            created: nowSec(),
            owned_by: 'pocketpal',
          },
        ]
      : [];

    const body = JSON.stringify({object: 'list', data});
    socket.write(httpResponse(200, 'OK', body));
    socket.destroy();
  }

  // ------------------------------------------------------------------
  // POST /v1/chat/completions
  // ------------------------------------------------------------------

  protected async handleChatCompletions(
    socket: any,
    req: ParsedRequest,
  ): Promise<void> {
    // --- Parse request body ---
    let parsed: any;
    try {
      parsed = JSON.parse(req.body);
    } catch {
      const body = JSON.stringify({
        error: {message: 'Invalid JSON', type: 'invalid_request_error'},
      });
      socket.write(httpResponse(400, 'Bad Request', body));
      socket.destroy();
      return;
    }

    const messages: Array<{role: string; content: string}> =
      parsed?.messages ?? [];
    const stream: boolean = parsed?.stream ?? false;
    const temperature: number | undefined = parsed?.temperature;
    const topP: number | undefined = parsed?.top_p;
    const maxTokens: number | undefined =
      parsed?.max_tokens ?? parsed?.max_completion_tokens;
    // Normalize stop: llama.rn only accepts string[]
    const stopRaw: string | string[] | undefined = parsed?.stop;
    const stop: string[] | undefined = stopRaw
      ? Array.isArray(stopRaw)
        ? stopRaw
        : [stopRaw]
      : undefined;

    // --- Validate ---
    const engine = this.getEngine();
    if (!engine) {
      const body = JSON.stringify({
        error: {
          message:
            'No model is currently loaded. Please load a model in PocketPal AI first.',
          type: 'invalid_request_error',
          code: 'model_not_loaded',
        },
      });
      socket.write(httpResponse(503, 'Service Unavailable', body));
      socket.destroy();
      return;
    }

    if (!messages || messages.length === 0) {
      const body = JSON.stringify({
        error: {
          message: '`messages` is required and must not be empty',
          type: 'invalid_request_error',
        },
      });
      socket.write(httpResponse(400, 'Bad Request', body));
      socket.destroy();
      return;
    }

    const model = this.getActiveModel();
    const modelId = model?.id ?? 'local-model';
    const completionId = `chatcmpl-${randomId()}`;
    const created = nowSec();

    const abortController = new AbortController();

    const timeoutMs = this.options.completionTimeoutMs ?? COMPLETION_TIMEOUT_MS;
    const timeoutHandle = setTimeout(() => {
      abortController.abort();
    }, timeoutMs);

    const pending: PendingCompletion = {socket, abortController, timeoutHandle};
    this.pendingCompletions.add(pending);

    // --- Write SSE headers if streaming ---
    if (stream) {
      const headers = [
        'HTTP/1.1 200 OK',
        'Content-Type: text/event-stream',
        'Cache-Control: no-cache',
        'Transfer-Encoding: chunked',
        'Access-Control-Allow-Origin: *',
        'Connection: keep-alive',
        '',
        '',
      ].join('\r\n');
      socket.write(headers);
    }

    try {
      const result = await engine.completion(
        {
          messages,
          temperature,
          top_p: topP,
          n_predict: maxTokens,
          stop,
        },
        stream
          ? data => {
              if (abortController.signal.aborted) {
                return;
              }

              const token = data.token ?? '';
              if (!token) {
                return;
              }

              const chunk = {
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model: modelId,
                choices: [
                  {
                    index: 0,
                    delta: {
                      content: token,
                    },
                    finish_reason: null,
                  },
                ],
              };
              writeSSEChunk(socket, chunk);
            }
          : undefined,
      );

      clearTimeout(timeoutHandle);
      this.pendingCompletions.delete(pending);

      if (!stream) {
        // Non-streaming response
        const body = JSON.stringify({
          id: completionId,
          object: 'chat.completion',
          created,
          model: modelId,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: result.content,
              },
              finish_reason: result.stopped_eos
                ? 'stop'
                : result.stopped_limit
                  ? 'length'
                  : 'stop',
            },
          ],
          usage: {
            prompt_tokens: result.tokens_evaluated ?? 0,
            completion_tokens: result.tokens_predicted ?? 0,
            total_tokens:
              (result.tokens_evaluated ?? 0) + (result.tokens_predicted ?? 0),
          },
        });
        socket.write(httpResponse(200, 'OK', body));
        socket.destroy();
      } else {
        // Streaming: send final chunk with finish_reason
        const finalChunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: modelId,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: result.stopped_eos
                ? 'stop'
                : result.stopped_limit
                  ? 'length'
                  : 'stop',
            },
          ],
        };
        writeSSEChunk(socket, finalChunk);
        writeSSEDone(socket);
        socket.destroy();
      }
    } catch (err: any) {
      clearTimeout(timeoutHandle);
      this.pendingCompletions.delete(pending);

      if (abortController.signal.aborted) {
        // Completion was cancelled (server stopping or timeout)
        if (stream) {
          try {
            socket.write('data: [DONE]\n\n');
            socket.write('0\r\n\r\n');
            socket.destroy();
          } catch {
            // ignore
          }
        } else {
          try {
            const body = JSON.stringify({
              error: {
                message: 'Completion was interrupted',
                type: 'server_error',
              },
            });
            socket.write(httpResponse(503, 'Service Unavailable', body));
            socket.destroy();
          } catch {
            // ignore
          }
        }
        return;
      }

      const errBody = JSON.stringify({
        error: {
          message: err?.message ?? 'Completion failed',
          type: 'server_error',
        },
      });
      try {
        socket.write(httpResponse(500, 'Internal Server Error', errBody));
        socket.destroy();
      } catch {
        // ignore
      }
    }
  }
}
