/**
 * Unit tests must be hermetic. Integration and live Jest configurations
 * intentionally replace this setup file because those suites own their
 * database/network lifecycle explicitly.
 */
import { Socket } from 'node:net';

const guardMessage = 'Unit tests must not open network connections; use an integration/live Jest configuration.';
const blockedConnect = function (this: Socket): Socket {
    // Emit the failure on the next microtask instead of throwing synchronously.
    // Database drivers commonly arm a connection timeout before calling
    // `socket.connect`; an exception here bypasses their cleanup path and
    // leaves that timeout alive after the test has finished.
    queueMicrotask(() => this.emit('error', new Error(guardMessage)));
    return this;
};

// `Socket.connect` is the lowest common path for node database drivers and
// HTTP clients, including drivers loaded from optional companion extensions.
Socket.prototype.connect = blockedConnect as unknown as typeof Socket.prototype.connect;

if (typeof globalThis.fetch === 'function') {
    globalThis.fetch = (() => Promise.reject(new Error(guardMessage))) as typeof globalThis.fetch;
}
