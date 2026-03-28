/**
 * Tests for LocalApiServer.
 *
 * We test the HTTP routing and response logic by directly exercising
 * handleRequest via a test subclass that exposes the protected method.
 */

import TcpSocket from 'react-native-tcp-socket';
import {
  LocalApiServer,
  LocalApiServerCallbacks,
  LocalApiServerOptions,
} from '../LocalApiServer';
import {CompletionEngine, CompletionResult} from '../../utils/completionTypes';
import {Model} from '../../utils/types';

// -----------------------------------------------------------------------
// Test subclass that exposes handleRequest for unit-testing
// -----------------------------------------------------------------------

class TestableLocalApiServer extends LocalApiServer {
  public async invokeHandleRequest(
    socket: any,
    req: {
      method: string;
      path: string;
      headers: Record<string, string>;
      body: string;
    },
  ): Promise<void> {
    return this.handleRequest(socket, req);
  }
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function makeSocket() {
  const written: string[] = [];
  return {
    write: jest.fn((data: string) => written.push(data)),
    destroy: jest.fn(),
    on: jest.fn(),
    _written: written,
  };
}

function makeCompletionResult(
  overrides: Partial<CompletionResult> = {},
): CompletionResult {
  return {
    text: 'Hello',
    content: 'Hello',
    tokens_predicted: 5,
    tokens_evaluated: 3,
    stopped_eos: true,
    ...overrides,
  };
}

const mockModel: Partial<Model> = {
  id: 'test-model-id',
  name: 'Test Model',
};

function buildServer(
  engine?: Partial<CompletionEngine>,
  model?: Partial<Model>,
  options?: LocalApiServerOptions,
  callbacks?: LocalApiServerCallbacks,
) {
  const getEngine = () => (engine ? (engine as CompletionEngine) : undefined);
  const getActiveModel = () => (model ? (model as Model) : undefined);

  return new TestableLocalApiServer(
    getEngine,
    getActiveModel,
    options ?? {port: 8080},
    callbacks,
  );
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe('LocalApiServer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ---- start / stop ----

  describe('start and stop', () => {
    it('calls TcpSocket.createServer and listen on start', () => {
      const server = buildServer();
      server.start();

      expect(TcpSocket.createServer).toHaveBeenCalledTimes(1);
      expect(server.isRunning).toBe(true);
      server.stop();
    });

    it('does not create a second server if already running', () => {
      const server = buildServer();
      server.start();
      server.start(); // second call — should be no-op

      expect(TcpSocket.createServer).toHaveBeenCalledTimes(1);
      server.stop();
    });

    it('calls server.close on stop', () => {
      const server = buildServer();
      server.start();
      server.stop();

      expect(server.isRunning).toBe(false);
    });

    it('calls onStarted callback with port', () => {
      const onStarted = jest.fn();
      const server = new LocalApiServer(
        () => undefined,
        () => undefined,
        {port: 8080},
        {onStarted},
      );
      server.start();
      expect(onStarted).toHaveBeenCalledWith(8080);
      server.stop();
    });

    it('calls onStopped callback', () => {
      const onStopped = jest.fn();
      const server = new LocalApiServer(
        () => undefined,
        () => undefined,
        {port: 8080},
        {onStopped},
      );
      server.start();
      server.stop();
      expect(onStopped).toHaveBeenCalledTimes(1);
    });
  });

  // ---- GET /v1/models ----

  describe('GET /v1/models', () => {
    it('returns empty list when no model is loaded', async () => {
      const server = buildServer(undefined, undefined);
      const socket = makeSocket();

      await server.invokeHandleRequest(socket, {
        method: 'GET',
        path: '/v1/models',
        headers: {},
        body: '',
      });

      const response = socket._written.join('');
      expect(response).toContain('200 OK');
      const body = JSON.parse(response.slice(response.indexOf('\r\n\r\n') + 4));
      expect(body.data).toEqual([]);
    });

    it('returns the active model when one is loaded', async () => {
      const server = buildServer(undefined, mockModel);
      const socket = makeSocket();

      await server.invokeHandleRequest(socket, {
        method: 'GET',
        path: '/v1/models',
        headers: {},
        body: '',
      });

      const response = socket._written.join('');
      const body = JSON.parse(response.slice(response.indexOf('\r\n\r\n') + 4));
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe('test-model-id');
      expect(body.data[0].owned_by).toBe('pocketpal');
    });
  });

  // ---- POST /v1/chat/completions ----

  describe('POST /v1/chat/completions — non-streaming', () => {
    it('returns 503 when no engine is loaded', async () => {
      const server = buildServer(undefined, undefined);
      const socket = makeSocket();

      await server.invokeHandleRequest(socket, {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: {},
        body: JSON.stringify({
          messages: [{role: 'user', content: 'hi'}],
          stream: false,
        }),
      });

      const response = socket._written.join('');
      expect(response).toContain('503');
    });

    it('returns 400 for missing messages', async () => {
      const engine: Partial<CompletionEngine> = {
        completion: jest.fn(),
        stopCompletion: jest.fn(),
      };
      const server = buildServer(engine, mockModel);
      const socket = makeSocket();

      await server.invokeHandleRequest(socket, {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: {},
        body: JSON.stringify({messages: [], stream: false}),
      });

      const response = socket._written.join('');
      expect(response).toContain('400');
    });

    it('returns 400 for invalid JSON body', async () => {
      const engine: Partial<CompletionEngine> = {
        completion: jest.fn(),
        stopCompletion: jest.fn(),
      };
      const server = buildServer(engine, mockModel);
      const socket = makeSocket();

      await server.invokeHandleRequest(socket, {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: {},
        body: 'not-json',
      });

      const response = socket._written.join('');
      expect(response).toContain('400');
    });

    it('returns a valid chat.completion object for a successful call', async () => {
      const completionResult = makeCompletionResult();
      const engine: Partial<CompletionEngine> = {
        completion: jest.fn().mockResolvedValue(completionResult),
        stopCompletion: jest.fn(),
      };
      const server = buildServer(engine, mockModel);
      const socket = makeSocket();

      await server.invokeHandleRequest(socket, {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: {},
        body: JSON.stringify({
          messages: [{role: 'user', content: 'Hello!'}],
          stream: false,
        }),
      });

      const response = socket._written.join('');
      expect(response).toContain('200 OK');

      const bodyStart = response.indexOf('\r\n\r\n') + 4;
      const body = JSON.parse(response.slice(bodyStart));

      expect(body.object).toBe('chat.completion');
      expect(body.choices[0].message.role).toBe('assistant');
      expect(body.choices[0].message.content).toBe(completionResult.content);
      expect(body.choices[0].finish_reason).toBe('stop');
      expect(body.usage.completion_tokens).toBe(
        completionResult.tokens_predicted,
      );
    });

    it('sets finish_reason to "length" for stopped_limit', async () => {
      const completionResult = makeCompletionResult({
        stopped_eos: false,
        stopped_limit: 1,
      });
      const engine: Partial<CompletionEngine> = {
        completion: jest.fn().mockResolvedValue(completionResult),
        stopCompletion: jest.fn(),
      };
      const server = buildServer(engine, mockModel);
      const socket = makeSocket();

      await server.invokeHandleRequest(socket, {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: {},
        body: JSON.stringify({
          messages: [{role: 'user', content: 'Hello!'}],
          stream: false,
        }),
      });

      const response = socket._written.join('');
      const bodyStart = response.indexOf('\r\n\r\n') + 4;
      const body = JSON.parse(response.slice(bodyStart));
      expect(body.choices[0].finish_reason).toBe('length');
    });
  });

  // ---- Streaming ----

  describe('POST /v1/chat/completions — streaming', () => {
    it('writes SSE chunks and [DONE] sentinel', async () => {
      const completionResult = makeCompletionResult({content: 'Hello world'});
      const engine: Partial<CompletionEngine> = {
        completion: jest.fn().mockImplementation(async (params, callback) => {
          callback?.({token: 'Hello', content: 'Hello'});
          callback?.({token: ' world', content: 'Hello world'});
          return completionResult;
        }),
        stopCompletion: jest.fn(),
      };
      const server = buildServer(engine, mockModel);
      const socket = makeSocket();

      await server.invokeHandleRequest(socket, {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: {},
        body: JSON.stringify({
          messages: [{role: 'user', content: 'Hi'}],
          stream: true,
        }),
      });

      const allWritten = socket._written.join('');
      expect(allWritten).toContain('text/event-stream');
      expect(allWritten).toContain('data:');
      expect(allWritten).toContain('[DONE]');
    });
  });

  // ---- 404 / CORS ----

  describe('unknown routes and CORS', () => {
    it('returns 404 for unknown path', async () => {
      const server = buildServer();
      const socket = makeSocket();

      await server.invokeHandleRequest(socket, {
        method: 'GET',
        path: '/unknown',
        headers: {},
        body: '',
      });

      expect(socket._written.join('')).toContain('404');
    });

    it('returns 204 for OPTIONS pre-flight', async () => {
      const server = buildServer();
      const socket = makeSocket();

      await server.invokeHandleRequest(socket, {
        method: 'OPTIONS',
        path: '/v1/chat/completions',
        headers: {},
        body: '',
      });

      expect(socket._written.join('')).toContain('204');
    });
  });
});
