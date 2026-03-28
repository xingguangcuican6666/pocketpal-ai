import {makeAutoObservable, runInAction} from 'mobx';
import {makePersistable} from 'mobx-persist-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {LocalApiServer} from '../services/LocalApiServer';
import {modelStore} from './ModelStore';

const DEFAULT_PORT = 8080;

class LocalServerStore {
  /** Whether the user has enabled the local API server. */
  isEnabled: boolean = false;

  /** The port the server should listen on. */
  port: number = DEFAULT_PORT;

  /** True while the TCP server is actually listening. */
  isRunning: boolean = false;

  /** Human-readable error from the server, if any. */
  serverError: string | null = null;

  private server: LocalApiServer | null = null;

  constructor() {
    makeAutoObservable(this);

    makePersistable(this, {
      name: 'LocalServerStore',
      properties: ['isEnabled', 'port'],
      storage: AsyncStorage,
    });
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  setEnabled(value: boolean): void {
    this.isEnabled = value;
    if (value) {
      this.startServer();
    } else {
      this.stopServer();
    }
  }

  setPort(port: number): void {
    this.port = port;
    if (this.isRunning) {
      this.stopServer();
      this.startServer();
    }
  }

  startServer(): void {
    if (this.server?.isRunning) {
      return;
    }

    runInAction(() => {
      this.serverError = null;
    });

    this.server = new LocalApiServer(
      () => modelStore.engine,
      () => modelStore.activeModel,
      {port: this.port},
      {
        onStarted: port => {
          runInAction(() => {
            this.isRunning = true;
            this.serverError = null;
            this.port = port;
          });
        },
        onStopped: () => {
          runInAction(() => {
            this.isRunning = false;
          });
        },
        onError: err => {
          runInAction(() => {
            this.isRunning = false;
            this.serverError = err;
          });
        },
      },
    );

    this.server.start();
  }

  stopServer(): void {
    this.server?.stop();
    this.server = null;
  }

  // ---------------------------------------------------------------------------
  // Computed helpers
  // ---------------------------------------------------------------------------

  /** The localhost URL for clients to connect to. */
  get serverUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }
}

export const localServerStore = new LocalServerStore();
