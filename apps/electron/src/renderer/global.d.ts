import type { ElectronMenuMessage, ElectronRendererApi } from '@justybase/contracts';

declare global {
  interface Window {
    readonly justybaseElectron: ElectronRendererApi;
    readonly justybaseMenu?: {
      readonly onMenuAction: (handler: (message: ElectronMenuMessage) => void) => () => void;
    };
  }
}

export {};
