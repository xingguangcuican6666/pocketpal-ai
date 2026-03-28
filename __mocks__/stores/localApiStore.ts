export const mockLocalApiStore = {
  enabled: false,
  port: 8000,
  apiKey: null as string | null,
  running: false,
  lastError: null as string | null,
  setEnabled: jest.fn(),
  setPort: jest.fn(),
  setApiKey: jest.fn(),
  setError: jest.fn(),
};
