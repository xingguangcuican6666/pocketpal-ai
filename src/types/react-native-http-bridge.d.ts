declare module 'react-native-http-bridge' {
  type HttpRequest = {
    url: string;
    type: string;
    postData?: string;
    headers?: Record<string, string>;
  };

  type RequestHandler = (request: HttpRequest) => void | Promise<void>;

  const httpBridge: {
    start(port: number, handler: RequestHandler): void;
    stop(): void;
    respond(status: number, contentType: string, body: string): void;
  };

  export default httpBridge;
}
