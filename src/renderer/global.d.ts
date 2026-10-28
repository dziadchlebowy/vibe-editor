import type { VeApi } from '../shared/api.ts';

declare global {
  interface Window {
    ve: VeApi;
  }
}

export {};
