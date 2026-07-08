import * as vscode from "vscode";
import { Logger, LogLevel, getLogger, logWithFallback, tryGetLogger } from "../utils/logger";

jest.mock("vscode");

describe("Logger", () => {
  let mockOutputChannel: jest.Mocked<vscode.OutputChannel>;
  let mockConfig: jest.Mocked<vscode.WorkspaceConfiguration>;
  let mockOnDidChangeConfiguration: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset Logger singleton
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Logger as any).instance = null;

    mockOutputChannel = {
      appendLine: jest.fn(),
      show: jest.fn(),
      dispose: jest.fn(),
      name: "Test Channel",
    } as unknown as jest.Mocked<vscode.OutputChannel>;

    mockConfig = {
      get: jest.fn().mockReturnValue("INFO"),
    } as unknown as jest.Mocked<vscode.WorkspaceConfiguration>;

    mockOnDidChangeConfiguration = jest.fn();

    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue(
      mockConfig,
    );
    (vscode.workspace.onDidChangeConfiguration as jest.Mock) =
      mockOnDidChangeConfiguration;
  });

  afterEach(() => {
    // Clean up singleton after each test
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
(Logger as any).instance = null;
});

describe("constructor", () => {
	it("should create logger with default INFO level", () => {
		const logger = new Logger(mockOutputChannel);

		expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith(
			"justybase.logging",
		);
		expect(logger).toBeDefined();
	});

	it("should create logger with specified level", () => {
		const logger = new Logger(mockOutputChannel, LogLevel.DEBUG);

		expect(logger).toBeDefined();
	});

	it("should register configuration change listener", () => {
		new Logger(mockOutputChannel);

		expect(mockOnDidChangeConfiguration).toHaveBeenCalled();
	});

	it("should update log level when configuration changes", () => {
		let configChangeHandler:
			| ((e: vscode.ConfigurationChangeEvent) => void)
			| undefined;
		mockOnDidChangeConfiguration.mockImplementation(
			(handler: (e: vscode.ConfigurationChangeEvent) => void) => {
				configChangeHandler = handler;
			},
		);

		mockConfig.get.mockReturnValue("DEBUG");

		new Logger(mockOutputChannel);

		// Simulate configuration change
		const mockEvent = {
			affectsConfiguration: jest.fn().mockReturnValue(true),
		};
		if (configChangeHandler) {
			configChangeHandler(mockEvent);
		}

		expect(mockEvent.affectsConfiguration).toHaveBeenCalledWith(
			"justybase.logging.level",
		);
	});

	it("should not update log level if configuration change does not affect logging", () => {
		let configChangeHandler:
			| ((e: vscode.ConfigurationChangeEvent) => void)
			| undefined;
		mockOnDidChangeConfiguration.mockImplementation(
			(handler: (e: vscode.ConfigurationChangeEvent) => void) => {
				configChangeHandler = handler;
			},
		);

		new Logger(mockOutputChannel);

		// Simulate configuration change that doesn't affect logging
		const mockEvent = {
			affectsConfiguration: jest.fn().mockReturnValue(false),
		};
		if (configChangeHandler) {
			configChangeHandler(mockEvent);
		}

		expect(mockEvent.affectsConfiguration).toHaveBeenCalledWith(
			"justybase.logging.level",
		);
	});
});

describe("singleton pattern", () => {
	it("should create instance with initialize", () => {
		const logger = Logger.initialize(mockOutputChannel);

      expect(logger).toBeDefined();
      expect(Logger.getInstance()).toBe(logger);
    });

    it("should get existing instance without channel", () => {
      Logger.initialize(mockOutputChannel);
      const logger = Logger.getInstance();

      expect(logger).toBeDefined();
    });

    it("should throw error if getInstance called before initialization", () => {
      expect(() => Logger.getInstance()).toThrow(
        "Logger not initialized. Call getInstance with a channel first.",
      );
    });

    it("should create instance with getInstance when channel provided", () => {
      const logger = Logger.getInstance(mockOutputChannel);

      expect(logger).toBeDefined();
    });

    it("should return same instance on multiple calls", () => {
      const logger1 = Logger.initialize(mockOutputChannel);
      const logger2 = Logger.getInstance();

      expect(logger1).toBe(logger2);
    });
  });

  describe("log levels", () => {
    it("should log DEBUG message when level is DEBUG", () => {
      mockConfig.get.mockReturnValue("DEBUG");
      const logger = new Logger(mockOutputChannel);

      logger.debug("test message");

      expect(mockOutputChannel.appendLine).toHaveBeenCalled();
      const loggedMessage = mockOutputChannel.appendLine.mock.calls[0][0];
      expect(loggedMessage).toContain("[DEBUG]");
      expect(loggedMessage).toContain("test message");
    });

    it("should not log DEBUG message when level is INFO", () => {
      mockConfig.get.mockReturnValue("INFO");
      const logger = new Logger(mockOutputChannel);

      logger.debug("test message");

      expect(mockOutputChannel.appendLine).not.toHaveBeenCalled();
    });

    it("should log INFO message when level is INFO", () => {
      mockConfig.get.mockReturnValue("INFO");
      const logger = new Logger(mockOutputChannel);

      logger.info("test message");

      expect(mockOutputChannel.appendLine).toHaveBeenCalled();
      const loggedMessage = mockOutputChannel.appendLine.mock.calls[0][0];
      expect(loggedMessage).toContain("[INFO]");
      expect(loggedMessage).toContain("test message");
    });

    it("should not log INFO message when level is WARN", () => {
      mockConfig.get.mockReturnValue("WARN");
      const logger = new Logger(mockOutputChannel);

      logger.info("test message");

      expect(mockOutputChannel.appendLine).not.toHaveBeenCalled();
    });

    it("should log WARN message when level is WARN", () => {
      mockConfig.get.mockReturnValue("WARN");
      const logger = new Logger(mockOutputChannel);

      logger.warn("test warning");

      expect(mockOutputChannel.appendLine).toHaveBeenCalled();
      const loggedMessage = mockOutputChannel.appendLine.mock.calls[0][0];
      expect(loggedMessage).toContain("[WARN]");
      expect(loggedMessage).toContain("test warning");
    });

    it("should not log WARN message when level is ERROR", () => {
      mockConfig.get.mockReturnValue("ERROR");
      const logger = new Logger(mockOutputChannel);

      logger.warn("test warning");

      expect(mockOutputChannel.appendLine).not.toHaveBeenCalled();
    });

    it("should log ERROR message when level is ERROR", () => {
      mockConfig.get.mockReturnValue("ERROR");
      const logger = new Logger(mockOutputChannel);

      logger.error("test error");

      expect(mockOutputChannel.appendLine).toHaveBeenCalled();
      const loggedMessage = mockOutputChannel.appendLine.mock.calls[0][0];
      expect(loggedMessage).toContain("[ERROR]");
      expect(loggedMessage).toContain("test error");
    });

    it("should log all messages when level is DEBUG", () => {
      mockConfig.get.mockReturnValue("DEBUG");
      const logger = new Logger(mockOutputChannel);

      logger.debug("debug msg");
      logger.info("info msg");
      logger.warn("warn msg");
      logger.error("error msg");

      expect(mockOutputChannel.appendLine).toHaveBeenCalledTimes(4);
    });
  });

  describe("message formatting", () => {
    it("should format message with timestamp and level", () => {
      mockConfig.get.mockReturnValue("INFO");
      const logger = new Logger(mockOutputChannel);

      logger.info("test message");

      const loggedMessage = mockOutputChannel.appendLine.mock.calls[0][0];
      expect(loggedMessage).toMatch(
        /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[INFO\] test message$/,
      );
    });

    it("should format message with string arguments", () => {
      mockConfig.get.mockReturnValue("INFO");
      const logger = new Logger(mockOutputChannel);

      logger.info("message with", "arg1", "arg2");

      const loggedMessage = mockOutputChannel.appendLine.mock.calls[0][0];
      expect(loggedMessage).toContain("message with arg1 arg2");
    });

    it("should format message with object arguments", () => {
      mockConfig.get.mockReturnValue("INFO");
      const logger = new Logger(mockOutputChannel);

      const testObj = { key: "value" };
      logger.info("message with", testObj);

      const loggedMessage = mockOutputChannel.appendLine.mock.calls[0][0];
      expect(loggedMessage).toContain("message with");
      expect(loggedMessage).toContain('"key": "value"');
    });

    it("should format message with number arguments", () => {
      mockConfig.get.mockReturnValue("INFO");
      const logger = new Logger(mockOutputChannel);

      logger.info("count:", 42);

      const loggedMessage = mockOutputChannel.appendLine.mock.calls[0][0];
      expect(loggedMessage).toContain("count: 42");
    });

    it("should handle empty arguments", () => {
      mockConfig.get.mockReturnValue("INFO");
      const logger = new Logger(mockOutputChannel);

      logger.info("simple message");

      const loggedMessage = mockOutputChannel.appendLine.mock.calls[0][0];
      expect(loggedMessage).toBe(loggedMessage.trimEnd());
    });

    it("should handle unstringifiable objects securely", () => {
      mockConfig.get.mockReturnValue("INFO");
      const logger = new Logger(mockOutputChannel);

      const circularObj: Record<string, unknown> = {};
      circularObj.self = circularObj;
      logger.info("Circular", circularObj);

      const loggedMessage = mockOutputChannel.appendLine.mock.calls[0][0];
      expect(loggedMessage).toContain("[Circular]");
    });
  });

  describe("log level configuration parsing", () => {
    it("should parse DEBUG level from config", () => {
      mockConfig.get.mockReturnValue("DEBUG");
      const logger = new Logger(mockOutputChannel);

      logger.debug("test");

      expect(mockOutputChannel.appendLine).toHaveBeenCalled();
    });

    it("should parse lowercase debug level from config", () => {
      mockConfig.get.mockReturnValue("debug");
      const logger = new Logger(mockOutputChannel);

      logger.debug("test");

      expect(mockOutputChannel.appendLine).toHaveBeenCalled();
    });

    it("should parse WARN level from config", () => {
      mockConfig.get.mockReturnValue("WARN");
      const logger = new Logger(mockOutputChannel);

      logger.info("test");

      expect(mockOutputChannel.appendLine).not.toHaveBeenCalled();
    });

    it("should parse ERROR level from config", () => {
      mockConfig.get.mockReturnValue("ERROR");
      const logger = new Logger(mockOutputChannel);

      logger.warn("test");

      expect(mockOutputChannel.appendLine).not.toHaveBeenCalled();
    });

    it("should default to INFO for unknown level", () => {
      mockConfig.get.mockReturnValue("UNKNOWN");
      const logger = new Logger(mockOutputChannel);

      logger.info("test");

      expect(mockOutputChannel.appendLine).toHaveBeenCalled();
    });

    it("should use default value when config returns undefined", () => {
      mockConfig.get.mockImplementation(
        (_key: string, defaultValue: unknown) => defaultValue,
      );
      const logger = new Logger(mockOutputChannel);

      logger.info("test");

      expect(mockOutputChannel.appendLine).toHaveBeenCalled();
    });
  });

  describe("console output", () => {
    let consoleErrorSpy: jest.SpyInstance;
    let consoleWarnSpy: jest.SpyInstance;

    beforeEach(() => {
      consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
      consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();
    });

    afterEach(() => {
      consoleErrorSpy.mockRestore();
      consoleWarnSpy.mockRestore();
    });

    it("should output ERROR to console.error", () => {
      mockConfig.get.mockReturnValue("ERROR");
      const logger = new Logger(mockOutputChannel);

      logger.error("test error");

      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it("should output WARN to console.warn", () => {
      mockConfig.get.mockReturnValue("WARN");
      const logger = new Logger(mockOutputChannel);

      logger.warn("test warning");

      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it("should not output INFO to console", () => {
      mockConfig.get.mockReturnValue("INFO");
      const logger = new Logger(mockOutputChannel);

      logger.info("test info");

      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });
  });

  describe("show method", () => {
    it("should show output channel", () => {
      const logger = new Logger(mockOutputChannel);

      logger.show();

      expect(mockOutputChannel.show).toHaveBeenCalledWith(true);
    });
  });

  describe("dispose method", () => {
    it("should dispose output channel", () => {
      Logger.initialize(mockOutputChannel);
      const logger = Logger.getInstance();

      logger.dispose();

      expect(mockOutputChannel.dispose).toHaveBeenCalled();
    });

    it("should reset singleton instance on dispose", () => {
      Logger.initialize(mockOutputChannel);
      const logger = Logger.getInstance();

      logger.dispose();

      expect(() => Logger.getInstance()).toThrow("Logger not initialized");
    });

    it("should handle dispose when output channel is null", () => {
      const logger = new Logger(mockOutputChannel);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (logger as any).outputChannel = null;

      // Should not throw
      expect(() => logger.dispose()).not.toThrow();
    });
  });

  describe("getLogger helper", () => {
    it("should return logger instance", () => {
      Logger.initialize(mockOutputChannel);

      const logger = getLogger();

      expect(logger).toBeDefined();
      expect(logger).toBe(Logger.getInstance());
    });

    it("should throw if logger not initialized", () => {
      expect(() => getLogger()).toThrow("Logger not initialized");
    });
  });

  describe("tryGetLogger helper", () => {
    it("should return undefined if logger not initialized", () => {
      expect(tryGetLogger()).toBeUndefined();
    });

    it("should return logger instance when initialized", () => {
      Logger.initialize(mockOutputChannel);

      expect(tryGetLogger()).toBe(Logger.getInstance());
    });
  });

  describe("logWithFallback helper", () => {
    let consoleErrorSpy: jest.SpyInstance;
    let consoleWarnSpy: jest.SpyInstance;
    let consoleLogSpy: jest.SpyInstance;

    beforeEach(() => {
      consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
      consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();
      consoleLogSpy = jest.spyOn(console, "log").mockImplementation();
    });

    afterEach(() => {
      consoleErrorSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });

    it("should use console fallback when logger is not initialized", () => {
      logWithFallback("warn", "fallback warning", { source: "test" });

      expect(consoleWarnSpy).toHaveBeenCalledWith("fallback warning", {
        source: "test",
      });
    });

    it("should not mirror debug fallback to console when logger is not initialized", () => {
      logWithFallback("debug", "debug only");

      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("should use the initialized logger when available", () => {
      Logger.initialize(mockOutputChannel);
      const logger = Logger.getInstance();
      const warnSpy = jest.spyOn(logger, "warn");

      logWithFallback("warn", "central warning", { source: "test" });

      expect(warnSpy).toHaveBeenCalledWith("central warning", {
        source: "test",
      });
      expect(mockOutputChannel.appendLine).toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });
});
