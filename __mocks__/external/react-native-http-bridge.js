let handler = null;

const httpBridge = {
  start: (_port, _serviceName, cb) => {
    handler = cb;
  },
  stop: () => {
    handler = null;
  },
  respond: jest.fn(),
  __triggerRequest: async req => {
    if (handler) {
      await handler(req);
    }
  },
};

module.exports = httpBridge;
