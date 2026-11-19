/**
 * Esbuild IIFE entry for the shared React Result Panel webview.
 *
 * This entry deliberately does not import the legacy DOM renderer. The shared
 * surface owns its bootstrap, state and rendering; the host only serves the
 * webview shell and postMessage bridge.
 */
import { mountSharedResultPanel } from './resultPanel/sharedView.js';

mountSharedResultPanel();
