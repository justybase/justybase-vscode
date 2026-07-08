/**
 * Structured Logging Utility
 * Provides centralized logging with configurable log levels and formatting
 */

import * as vscode from 'vscode';
import { affectsExtensionConfiguration, getExtensionConfiguration } from '../compatibility/configuration';

export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3
}

export type LoggerMethod = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
    private outputChannel: vscode.OutputChannel;
    private level: LogLevel;
    private static instance: Logger | null = null;
    private static MAX_DUPLICATE_ERRORS = 50;

    private recentErrors = new Map<string, { count: number; lastSeen: number }>();

    constructor(outputChannel: vscode.OutputChannel, level?: LogLevel) {
        this.outputChannel = outputChannel;
        this.level = level ?? this.getConfiguredLogLevel();

        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (affectsExtensionConfiguration(e, 'logging.level')) {
                this.level = this.getConfiguredLogLevel();
            }
        });
    }

    /**
     * Get or create the singleton logger instance
     */
    public static getInstance(channel?: vscode.OutputChannel): Logger {
        if (!Logger.instance && channel) {
            Logger.instance = new Logger(channel);
        }
        if (!Logger.instance) {
            throw new Error('Logger not initialized. Call getInstance with a channel first.');
        }
        return Logger.instance;
    }

    public static tryGetInstance(): Logger | undefined {
        return Logger.instance ?? undefined;
    }

    /**
     * Initialize the logger (to be called once during extension activation)
     */
    public static initialize(channel: vscode.OutputChannel): Logger {
        Logger.instance = new Logger(channel);
        return Logger.instance;
    }

    private getConfiguredLogLevel(): LogLevel {
        const config = getExtensionConfiguration('logging');
        const levelStr = (config.get<string>('level', 'INFO') ?? 'INFO').toUpperCase();

        switch (levelStr) {
            case 'DEBUG':
                return LogLevel.DEBUG;
            case 'INFO':
                return LogLevel.INFO;
            case 'WARN':
                return LogLevel.WARN;
            case 'ERROR':
                return LogLevel.ERROR;
            default:
                return LogLevel.INFO;
        }
    }

    private formatMessage(level: string, message: string, args: unknown[]): string {
        const timestamp = new Date().toISOString();
        const formattedArgs = args.length > 0
            ? ' ' + args.map(arg => {
                if (arg instanceof Error) {
                    return `${arg.message}${arg.stack ? '\n' + arg.stack : ''}`;
                }
                if (typeof arg === 'object' && arg !== null) {
                    try {
                        const cache = new Set();
                        return JSON.stringify(arg, (_key, value) => {
                            if (typeof value === 'object' && value !== null) {
                                if (cache.has(value)) {
                                    return '[Circular]';
                                }
                                cache.add(value);
                            }
                            return value;
                        }, 2);
                    } catch {
                        return '[Unstringifiable Object]';
                    }
                }
                return String(arg);
            }).join(' ')
            : '';

        return `[${timestamp}] [${level}] ${message}${formattedArgs}`;
    }

    private log(level: LogLevel, levelStr: string, message: string, args: unknown[]): void {
        if (level < this.level) {
            return; // Don't log if below configured level
        }

        const formatted = this.formatMessage(levelStr, message, args);
        this.outputChannel.appendLine(formatted);

        // Also log to console for debugging in development
        if (level >= LogLevel.ERROR) {
            console.error(formatted);
        } else if (level >= LogLevel.WARN) {
            console.warn(formatted);
        }
    }

    public debug(message: string, ...args: unknown[]): void {
        this.log(LogLevel.DEBUG, 'DEBUG', message, args);
    }

    public info(message: string, ...args: unknown[]): void {
        this.log(LogLevel.INFO, 'INFO', message, args);
    }

    public warn(message: string, ...args: unknown[]): void {
        this.log(LogLevel.WARN, 'WARN', message, args);
    }

    public error(message: string, ...args: unknown[]): void {
        // Deduplicate: skip if same message + first arg was logged within last 5s
        const now = Date.now();
        const key = message + (args.length > 0 && typeof args[0] === 'string' ? args[0] : '');
        const prev = this.recentErrors.get(key);
        if (prev && now - prev.lastSeen < 5000) {
            prev.count++;
            prev.lastSeen = now;
            if (prev.count <= Logger.MAX_DUPLICATE_ERRORS) {
                this.log(LogLevel.ERROR, 'ERROR', message, args);
            } else if (prev.count === Logger.MAX_DUPLICATE_ERRORS + 1) {
                this.log(LogLevel.ERROR, 'ERROR', `Suppressing further duplicates (same error occurred ${prev.count} times)`, []);
            }
            return;
        }
        // Flush suppressed count from previous entry
        if (prev && prev.count > Logger.MAX_DUPLICATE_ERRORS) {
            this.log(LogLevel.WARN, 'WARN', `(Suppressed ${prev.count - Logger.MAX_DUPLICATE_ERRORS} duplicate errors)`, []);
        }
        this.recentErrors.set(key, { count: 1, lastSeen: now });
        this.log(LogLevel.ERROR, 'ERROR', message, args);
    }

    /**
     * Show the output channel
     */
    public show(): void {
        this.outputChannel.show(true);
    }

    /**
     * Dispose the logger
     */
    public dispose(): void {
        if (this.outputChannel) {
            this.outputChannel.dispose();
        }
        Logger.instance = null;
    }
}

/**
 * Helper function to get the logger instance (convenience wrapper)
 */
export function getLogger(): Logger {
    return Logger.getInstance();
}

export function tryGetLogger(): Logger | undefined {
    return Logger.tryGetInstance();
}

function logToConsole(level: LoggerMethod, message: string, args: unknown[]): void {
    if (level === 'error') {
        console.error(message, ...args);
        return;
    }

    if (level === 'warn') {
        console.warn(message, ...args);
    }
}

export function logWithFallback(level: LoggerMethod, message: string, ...args: unknown[]): void {
    const logger = tryGetLogger();
    if (!logger) {
        logToConsole(level, message, args);
        return;
    }

    switch (level) {
        case 'debug':
            logger.debug(message, ...args);
            return;
        case 'info':
            logger.info(message, ...args);
            return;
        case 'warn':
            logger.warn(message, ...args);
            return;
        case 'error':
            logger.error(message, ...args);
            return;
    }
}
