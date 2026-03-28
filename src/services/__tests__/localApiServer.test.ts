import {ModelOrigin} from '../../utils/types';

const mockEngine = {
  completion: jest.fn(),
  stopCompletion: jest.fn(),
};

const mockModelStore = {
  activeModel: {
    id: 'local-1',
    origin: ModelOrigin.LOCAL,
    stopWords: ['</s>'],
  },
  models: [
    {id: 'local-1', origin: ModelOrigin.LOCAL, isDownloaded: true},
    {id: 'preset-1', origin: ModelOrigin.PRESET, isDownloaded: true},
    {id: 'remote-1', origin: ModelOrigin.REMOTE, isDownloaded: true},
  ],
  engine: mockEngine as any,
  context: {} as any,
  inferencing: false,
  isStreaming: false,
  registerCompletionPromise: jest.fn(),
  clearCompletionPromise: jest.fn(),
  setInferencing: jest.fn(function setInferencing(this: any, value: boolean) {
    this.inferencing = value;
  }),
  setIsStreaming: jest.fn(function setIsStreaming(this: any, value: boolean) {
    this.isStreaming = value;
  }),
};

jest.mock('../../store', () => ({
  modelStore: mockModelStore,
}));

const {handleApiRequest} = require('../localApiServer');

describe('localApiServer.handleApiRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockModelStore.inferencing = false;
    mockModelStore.isStreaming = false;
    mockModelStore.engine = mockEngine;
    mockModelStore.activeModel = {
      id: 'local-1',
      origin: ModelOrigin.LOCAL,
      stopWords: ['</s>'],
    };
    mockModelStore.context = {};
  });

  it('rejects when API key is missing', async () => {
    const response = await handleApiRequest(
      {url: '/v1/models', type: 'GET', headers: {}, requestId: 'req-1'},
      {port: 8000, apiKey: 'secret'},
    );

    expect(response.status).toBe(401);
  });

  it('returns available local models', async () => {
    const response = await handleApiRequest(
      {url: '/v1/models', type: 'GET', requestId: 'req-2'},
      {port: 8000},
    );

    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body);
    expect(payload.data).toEqual([
      {id: 'local-1', object: 'model', owned_by: 'pocketpal'},
      {id: 'preset-1', object: 'model', owned_by: 'pocketpal'},
    ]);
  });

  it('returns chat completion in OpenAI format', async () => {
    mockEngine.completion.mockImplementation((_params, _cb) =>
      Promise.resolve({
        content: 'Hello!',
        tokens_predicted: 2,
        tokens_evaluated: 1,
        stopped_eos: true,
      }),
    );

    const response = await handleApiRequest(
      {
        url: '/v1/chat/completions',
        type: 'POST',
        postData: JSON.stringify({
          messages: [{role: 'user', content: 'Hi'}],
        }),
        requestId: 'req-3',
      },
      {port: 8000},
    );

    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body);
    expect(payload.object).toBe('chat.completion');
    expect(payload.choices[0].message.content).toBe('Hello!');
    expect(payload.usage).toEqual({
      completion_tokens: 2,
      prompt_tokens: 1,
      total_tokens: 3,
    });
  });

  it('returns SSE payload when stream is true', async () => {
    mockEngine.completion.mockImplementation((_params, cb) => {
      cb?.({content: 'Hel'});
      return Promise.resolve({
        content: 'Hello',
        tokens_predicted: 2,
        tokens_evaluated: 1,
        stopped_eos: true,
      });
    });

    const response = await handleApiRequest(
      {
        url: '/v1/chat/completions',
        type: 'POST',
        postData: JSON.stringify({
          messages: [{role: 'user', content: 'Hi'}],
          stream: true,
        }),
        requestId: 'req-4',
      },
      {port: 8000},
    );

    expect(response.status).toBe(200);
    expect(response.contentType).toBe('text/event-stream');
    expect(response.body).toContain('data: [DONE]');
    expect(mockModelStore.setIsStreaming).toHaveBeenCalledWith(true);
  });

  it('returns busy error when model is inferencing', async () => {
    mockModelStore.inferencing = true;
    const response = await handleApiRequest(
      {
        url: '/v1/chat/completions',
        type: 'POST',
        postData: JSON.stringify({
          messages: [{role: 'user', content: 'Hi'}],
        }),
        requestId: 'req-5',
      },
      {port: 8000},
    );

    expect(response.status).toBe(409);
  });
});
