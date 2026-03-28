/**
 * Jest mock for react-native-tcp-socket.
 * Provides a minimal no-op TcpSocket API used by LocalApiServer.
 */

const createMockSocket = () => ({
  write: jest.fn(),
  destroy: jest.fn(),
  on: jest.fn(),
  end: jest.fn(),
});

const createMockServer = () => {
  const callbacks: Record<string, Function> = {};
  const server = {
    listen: jest.fn((_options: any, cb?: Function) => {
      if (cb) {
        cb();
      }
      return server;
    }),
    close: jest.fn((cb?: Function) => {
      if (cb) {
        cb();
      }
      return server;
    }),
    on: jest.fn((event: string, cb: Function) => {
      callbacks[event] = cb;
      return server;
    }),
    _emit: (event: string, ...args: any[]) => {
      if (callbacks[event]) {
        callbacks[event](...args);
      }
    },
  };
  return server;
};

const TcpSocket = {
  createServer: jest.fn((_handler?: Function) => createMockServer()),
  createConnection: jest.fn(() => createMockSocket()),
};

export default TcpSocket;
export {TcpSocket};
