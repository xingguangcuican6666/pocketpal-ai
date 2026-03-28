import {makeAutoObservable} from 'mobx';

class MockLocalServerStore {
  isEnabled: boolean = false;
  port: number = 8080;
  isRunning: boolean = false;
  serverError: string | null = null;

  setEnabled: jest.Mock;
  setPort: jest.Mock;
  startServer: jest.Mock;
  stopServer: jest.Mock;

  constructor() {
    makeAutoObservable(this);

    this.setEnabled = jest.fn((value: boolean) => {
      this.isEnabled = value;
    });
    this.setPort = jest.fn((port: number) => {
      this.port = port;
    });
    this.startServer = jest.fn();
    this.stopServer = jest.fn();
  }

  get serverUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }
}

export const mockLocalServerStore = new MockLocalServerStore();
