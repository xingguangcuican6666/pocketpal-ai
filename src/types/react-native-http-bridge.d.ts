declare module 'react-native-http-bridge' {
  type HttpRequest = {
    url: string;
    type: string;
    postData?: string;
    headers?: Record<string, string>;
    requestId: string;
  };

  type RequestHandler = (request: HttpRequest) => void | Promise<void>;

  const httpBridge: {
    start(port: number, serviceName: string, handler: RequestHandler): void;
    stop(): void;
    respond(
      requestId: string,
      status: number,
      contentType: string,
      body: string,
    ): void;
  };

  export default httpBridge;
}
