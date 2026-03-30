import httpBridge from 'react-native-http-bridge';

import {modelStore} from '../store';
import {defaultCompletionParams} from '../utils/completionSettingsVersions';
import {toApiCompletionParams} from '../utils/completionTypes';
import {ModelOrigin} from '../utils/types';

export type LocalApiServerConfig = {
  port: number;
  apiKey?: string | null;
};

type HttpRequest = {
  url: string;
  type: string;
  postData?: string;
  headers?: Record<string, string>;
  requestId: string;
};

type ApiResponse = {
  status: number;
  contentType: string;
  body: string;
};

let isRunning = false;
let activeConfig: LocalApiServerConfig | null = null;

function buildJsonResponse(status: number, payload: any): ApiResponse {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(payload),
  };
}

function buildError(
  status: number,
  message: string,
  type = 'invalid_request_error',
) {
  return buildJsonResponse(status, {
    error: {
      message,
      type,
    },
  });
}

function normalizeMessages(
  messages: any,
): Array<{role: string; content: any}> | null {
  if (Array.isArray(messages)) {
    return messages;
  }

  // Some clients may accidentally send an object with numeric keys (e.g., {"0": {...}, "1": {...}})
  // instead of a JSON array. Coerce such shapes into an array to prevent downstream errors like
  // "Object is an object, expected an array".
  if (messages && typeof messages === 'object') {
    const numericKeys = Object.keys(messages)
      .filter(k => /^\d+$/.test(k))
      .map(k => Number(k))
      .sort((a, b) => a - b);

    if (numericKeys.length) {
      return numericKeys.map(k => (messages as any)[k]);
    }
  }

  return null;
}

function parseRequestBody<T = any>(raw?: string): T | null {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function normalizeAuth(headers: Record<string, string> | undefined) {
  if (!headers) {
    return undefined;
  }
  return headers.Authorization || headers.authorization;
}

function mapFinishReason(result: any): string | null {
  if (result.interrupted) {
    return 'interrupted';
  }
  if (result.stopped_limit) {
    return 'length';
  }
  if (result.stopped_eos) {
    return 'stop';
  }
  return null;
}

function buildUsage(result: any) {
  const promptTokens = result.tokens_evaluated;
  const completionTokens = result.tokens_predicted;
  const totalTokens =
    promptTokens != null && completionTokens != null
      ? promptTokens + completionTokens
      : undefined;

  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

function toNumber(value: any, fallback: number) {
  if (typeof value === 'number') {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function handleChatCompletion(
  body: any,
  created: number,
): Promise<ApiResponse> {
  if (!body || !Array.isArray(body.messages)) {
    return buildError(400, 'messages array is required');
  }

  const activeModel = modelStore.activeModel;
  if (!activeModel || activeModel.origin === ModelOrigin.REMOTE) {
    return buildError(400, 'A local model must be loaded to serve requests');
  }

  if (!modelStore.engine || !modelStore.context) {
    return buildError(503, 'Model is not ready');
  }

  if (modelStore.inferencing || modelStore.isStreaming) {
    return buildError(409, 'Model is busy with another request');
  }

  if (body.model && body.model !== activeModel.id) {
    return buildError(
      400,
      `Requested model "${body.model}" is not the active local model`,
    );
  }

  const nPredict = toNumber(
    body.max_tokens || body.max_completion_tokens,
    defaultCompletionParams.n_predict ?? 0,
  );

  const completionParams = toApiCompletionParams({
    ...defaultCompletionParams,
    messages: body.messages,
    temperature:
      body.temperature !== undefined
        ? body.temperature
        : defaultCompletionParams.temperature,
    top_p:
      body.top_p !== undefined ? body.top_p : defaultCompletionParams.top_p,
    n_predict: nPredict,
    stop:
      Array.isArray(body.stop) && body.stop.length
        ? body.stop
        : activeModel.stopWords || defaultCompletionParams.stop,
  });

  if (completionParams.enable_thinking) {
    completionParams.reasoning_format = 'auto';
  }

  let accumulated = '';
  let accumulatedReasoning = '';
  const streamChunks: string[] = [];

  modelStore.setInferencing(true);
  try {
    const completionPromise = modelStore.engine.completion(
      completionParams,
      body.stream
        ? data => {
            if (data?.content) {
              accumulated += data.content;
            }
            if (data?.reasoning_content) {
              accumulatedReasoning += data.reasoning_content;
            }

            const chunkPayload = {
              id: `chatcmpl-${created}`,
              object: 'chat.completion.chunk',
              created,
              model: activeModel.id,
              choices: [
                {
                  index: 0,
                  delta: {
                    content: data?.content,
                    reasoning_content: data?.reasoning_content,
                  },
                  finish_reason: null,
                },
              ],
            };

            streamChunks.push(`data: ${JSON.stringify(chunkPayload)}\n\n`);
            modelStore.setIsStreaming(true);
          }
        : undefined,
    );

    if (modelStore.context) {
      modelStore.registerCompletionPromise(completionPromise);
    }

    const result = await completionPromise;
    modelStore.clearCompletionPromise();

    const finishReason = mapFinishReason(result);
    const baseContent = result.content || accumulated;
    const reasoningContent = result.reasoning_content || accumulatedReasoning;

    if (body.stream) {
      const finalChunk = {
        id: `chatcmpl-${created}`,
        object: 'chat.completion.chunk',
        created,
        model: activeModel.id,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: finishReason,
          },
        ],
      };

      streamChunks.push(`data: ${JSON.stringify(finalChunk)}\n\n`);
      streamChunks.push('data: [DONE]\n\n');

      return {
        status: 200,
        contentType: 'text/event-stream',
        body: streamChunks.join(''),
      };
    }

    const message: Record<string, any> = {
      role: 'assistant',
      content: baseContent,
    };
    if (reasoningContent) {
      message.reasoning_content = reasoningContent;
    }

    const response = {
      id: `chatcmpl-${created}`,
      object: 'chat.completion',
      created,
      model: activeModel.id,
      choices: [
        {
          index: 0,
          message,
          finish_reason: finishReason,
        },
      ],
      usage: buildUsage(result),
    };

    return buildJsonResponse(200, response);
  } catch (error: any) {
    modelStore.clearCompletionPromise();
    const message = error?.message || 'Unknown error during completion';
    return buildError(500, message, 'server_error');
  } finally {
    modelStore.setInferencing(false);
    modelStore.setIsStreaming(false);
  }
}

async function handleModelsRequest(): Promise<ApiResponse> {
  const models = modelStore.models.filter(
    m => m.origin !== ModelOrigin.REMOTE && m.isDownloaded,
  );

  const data = models.map(m => ({
    id: m.id,
    object: 'model',
    owned_by: 'pocketpal',
  }));

  return buildJsonResponse(200, {
    object: 'list',
    data,
  });
}

export async function handleApiRequest(
  request: HttpRequest,
  config: LocalApiServerConfig,
): Promise<ApiResponse> {
  const created = Math.floor(Date.now() / 1000);

  const authHeader = normalizeAuth(request.headers);
  if (config.apiKey && authHeader !== `Bearer ${config.apiKey}`) {
    return buildError(
      401,
      'Unauthorized: invalid or missing API key',
      'authentication_error',
    );
  }

  let path = request.url || '/';
  try {
    path = new URL(path, 'http://localhost').pathname;
  } catch {
    // ignore, use raw path
  }

  if (request.type === 'GET' && path === '/v1/models') {
    return handleModelsRequest();
  }

  if (request.type === 'POST' && path === '/v1/chat/completions') {
    const body = parseRequestBody(request.postData);
    if (!body) {
      return buildError(400, 'Invalid JSON body');
    }

    const normalizedModelId =
      typeof body.model === 'string' && body.model.trim()
        ? body.model.trim()
        : undefined;
    const activeModel = modelStore.activeModel;

    // If a model is specified and differs from the active one, return a clear error
    if (
      normalizedModelId &&
      activeModel &&
      normalizedModelId !== activeModel.id
    ) {
      return buildError(
        400,
        `Requested model "${normalizedModelId}" is not the active local model`,
      );
    }

    // Provide a more actionable error when the model context/engine is missing
    if (!modelStore.engine || !modelStore.context) {
      return buildError(
        503,
        'Model is not loaded. Open the app and load a local model before using the API.',
      );
    }

    // Ensure messages is an array to avoid downstream errors
    const normalizedMessages = normalizeMessages(body.messages);
    if (!normalizedMessages) {
      return buildError(400, 'messages array is required');
    }
    body.messages = normalizedMessages;

    return handleChatCompletion(body, created);
  }

  return buildError(404, 'Not found', 'invalid_request_error');
}

function respond(requestId: string, response: ApiResponse) {
  httpBridge.respond(
    requestId,
    response.status,
    response.contentType,
    response.body,
  );
}

export function startLocalApiServer(
  config: LocalApiServerConfig,
  onError?: (error: Error) => void,
) {
  if (isRunning) {
    stopLocalApiServer();
  }

  activeConfig = config;
  try {
    httpBridge.start(config.port, 'http-server', async request => {
      try {
        const response = await handleApiRequest(request, config);
        respond(request.requestId, response);
      } catch (error: any) {
        respond(
          request.requestId,
          buildError(500, error?.message || 'Internal server error'),
        );
      }
    });
    isRunning = true;
  } catch (error: any) {
    isRunning = false;
    activeConfig = null;
    onError?.(error);
    throw error;
  }
}

export function stopLocalApiServer() {
  if (isRunning) {
    httpBridge.stop();
  }
  isRunning = false;
  activeConfig = null;
}

export function isLocalApiServerRunning() {
  return isRunning;
}

export function getActiveConfig() {
  return activeConfig;
}
