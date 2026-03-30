import {makeAutoObservable, runInAction} from 'mobx';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {makePersistable} from 'mobx-persist-store';

import {
  startLocalApiServer,
  stopLocalApiServer,
  isLocalApiServerRunning,
} from '../services/localApiServer';

const DEFAULT_PORT = 8000;

class LocalApiStore {
  enabled = false;
  port = DEFAULT_PORT;
  apiKey: string | null = null;
  running = false;
  lastError: string | null = null;

  constructor() {
    makeAutoObservable(this);

    makePersistable(this, {
      name: 'LocalApiStore',
      properties: ['enabled', 'port', 'apiKey'],
      storage: AsyncStorage,
    }).then(() => {
      if (this.enabled) {
        this.startServer();
      }
    });
  }

  setEnabled(value: boolean) {
    this.enabled = value;
    if (value) {
      this.startServer();
    } else {
      this.stopServer();
    }
  }

  setPort(port: number) {
    const normalized = this.normalizePort(port);
    this.port = normalized;
    if (this.enabled) {
      this.restartServer();
    }
  }

  setApiKey(key: string) {
    this.apiKey = key?.trim() ? key.trim() : null;
    if (this.enabled) {
      this.restartServer();
    }
  }

  setRunning(value: boolean) {
    this.running = value;
  }

  setError(message?: string) {
    this.lastError = message || null;
  }

  normalizePort(port: number) {
    if (!Number.isFinite(port) || port <= 0) {
      return DEFAULT_PORT;
    }
    if (port > 65535) {
      return 65535;
    }
    return Math.floor(port);
  }

  async startServer() {
    try {
      startLocalApiServer({port: this.port, apiKey: this.apiKey}, error =>
        this.setError(error?.message),
      );
      runInAction(() => {
        this.setRunning(true);
        this.setError(undefined);
      });
    } catch (error: any) {
      runInAction(() => {
        this.setRunning(false);
        this.setError(error?.message);
      });
    }
  }

  stopServer() {
    stopLocalApiServer();
    this.setRunning(false);
  }

  async restartServer() {
    if (!this.enabled) {
      return;
    }
    this.stopServer();
    await this.startServer();
  }

  refreshRunningState() {
    this.setRunning(isLocalApiServerRunning());
  }
}

export const localApiStore = new LocalApiStore();
