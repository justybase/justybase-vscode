import type { ElectronRendererApi } from '@justybase/contracts';

declare global {
  interface Window {
    readonly justybaseElectron: ElectronRendererApi;
  }
}

export {};
