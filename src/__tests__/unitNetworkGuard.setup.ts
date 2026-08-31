/**
 * Unit tests must be hermetic. Integration and live Jest configurations
 * intentionally replace this setup file because those suites own their
 * database/network lifecycle explicitly.
 */
import { Socket } from 'node:net';

const guardMessage = 'Unit tests must not open network connections; use an integration/live Jest configuration.';
const blockedConnect = (): never => {
    throw new Error(guardMessage);
};

// `Socket.connect` is the lowest common path for node database drivers and
// HTTP clients, including drivers loaded from optional companion extensions.
Socket.prototype.connect = blockedConnect as typeof Socket.prototype.connect;

if (typeof globalThis.fetch === 'function') {
    globalThis.fetch = blockedConnect as typeof globalThis.fetch;
}
