import {runInAction} from 'mobx';

// Mock dependencies before importing the store
jest.mock('mobx-persist-store', () => ({
  makePersistable: jest.fn().mockReturnValue(Promise.resolve()),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

// Mock LocalApiServer so we can control its behaviour
const mockServerStart = jest.fn();
const mockServerStop = jest.fn();
const mockIsRunning = jest.fn().mockReturnValue(false);

jest.mock('../../services/LocalApiServer', () => ({
  LocalApiServer: jest.fn().mockImplementation(() => ({
    start: mockServerStart,
    stop: mockServerStop,
    get isRunning() {
      return mockIsRunning();
    },
  })),
}));

// Import the singleton after mocks are set
import {localServerStore} from '../LocalServerStore';

describe('LocalServerStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsRunning.mockReturnValue(false);

    // Reset observable state
    runInAction(() => {
      localServerStore.isEnabled = false;
      localServerStore.port = 8080;
      localServerStore.isRunning = false;
      localServerStore.serverError = null;
    });
  });

  describe('initial state', () => {
    it('is disabled by default', () => {
      expect(localServerStore.isEnabled).toBe(false);
    });

    it('uses port 8080 by default', () => {
      expect(localServerStore.port).toBe(8080);
    });

    it('is not running by default', () => {
      expect(localServerStore.isRunning).toBe(false);
    });

    it('has no error by default', () => {
      expect(localServerStore.serverError).toBeNull();
    });
  });

  describe('serverUrl computed', () => {
    it('returns the correct URL for the current port', () => {
      runInAction(() => {
        localServerStore.port = 8080;
      });
      expect(localServerStore.serverUrl).toBe('http://127.0.0.1:8080');
    });

    it('reflects port changes', () => {
      runInAction(() => {
        localServerStore.port = 9090;
      });
      expect(localServerStore.serverUrl).toBe('http://127.0.0.1:9090');
    });
  });

  describe('setEnabled', () => {
    it('sets isEnabled to true and starts the server', () => {
      localServerStore.setEnabled(true);
      expect(localServerStore.isEnabled).toBe(true);
      expect(mockServerStart).toHaveBeenCalledTimes(1);
    });

    it('sets isEnabled to false and stops the server', () => {
      // First enable
      localServerStore.setEnabled(true);
      jest.clearAllMocks();

      // Now disable
      localServerStore.setEnabled(false);
      expect(localServerStore.isEnabled).toBe(false);
      expect(mockServerStop).toHaveBeenCalledTimes(1);
    });
  });

  describe('setPort', () => {
    it('updates the port', () => {
      localServerStore.setPort(9000);
      expect(localServerStore.port).toBe(9000);
    });

    it('does not restart the server when it is not running', () => {
      // Server is not running (default)
      localServerStore.setPort(9001);
      expect(mockServerStart).not.toHaveBeenCalled();
      expect(mockServerStop).not.toHaveBeenCalled();
    });

    it('restarts the server when it is already running', () => {
      // Simulate server running
      runInAction(() => {
        localServerStore.isRunning = true;
      });
      mockIsRunning.mockReturnValue(true);

      // Give the store a live server reference by enabling first
      localServerStore.setEnabled(true);
      jest.clearAllMocks();

      // Change port — should restart
      localServerStore.setPort(9002);
      expect(mockServerStop).toHaveBeenCalledTimes(1);
      expect(mockServerStart).toHaveBeenCalledTimes(1);
    });
  });

  describe('startServer / stopServer', () => {
    it('calls server.start()', () => {
      localServerStore.startServer();
      expect(mockServerStart).toHaveBeenCalledTimes(1);
    });

    it('does not start a second server when already running', () => {
      mockIsRunning.mockReturnValue(true);
      // Simulate an existing server
      localServerStore.startServer(); // first call creates the server
      const firstCallCount = mockServerStart.mock.calls.length;

      localServerStore.startServer(); // second call should be no-op
      expect(mockServerStart.mock.calls.length).toBe(firstCallCount);
    });

    it('calls server.stop()', () => {
      localServerStore.startServer();
      localServerStore.stopServer();
      expect(mockServerStop).toHaveBeenCalledTimes(1);
    });
  });
});
