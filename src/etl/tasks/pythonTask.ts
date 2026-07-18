/**
 * Python Task Executor
 * Executes Python scripts as part of ETL workflows
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EtlNode, EtlNodeExecutionResult, PythonNodeConfig } from '../etlTypes';
import { ExecutionContext, IPythonRunner, IVariableResolver } from '../interfaces';
import { BaseTaskExecutor } from './baseTaskExecutor';

/**
 * Python execution result
 */
export interface PythonResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

/**
 * Default Python runner implementation
 */
class DefaultPythonRunner implements IPythonRunner {
    async run(
        interpreter: string,
        args: string[],
        env: NodeJS.ProcessEnv,
        timeout?: number
    ): Promise<PythonResult> {
        return new Promise((resolve) => {
            const proc: ChildProcess = spawn(interpreter, args, { env, shell: false });

            let stdout = '';
            let stderr = '';

            proc.stdout?.on('data', (data) => {
                stdout += data.toString();
            });

            proc.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            proc.on('close', (code) => {
                resolve({
                    exitCode: code ?? 1,
                    stdout: stdout.trim(),
                    stderr: stderr.trim()
                });
            });

            proc.on('error', (err) => {
                resolve({
                    exitCode: 1,
                    stdout: '',
                    stderr: `Failed to start Python: ${err.message}`
                });
            });

            // Handle timeout
            if (timeout && timeout > 0) {
                setTimeout(() => {
                    proc.kill();
                    resolve({
                        exitCode: 1,
                        stdout: stdout.trim(),
                        stderr: `Execution timed out after ${timeout} seconds`
                    });
                }, timeout * 1000);
            }
        });
    }
}

/**
 * Python interpreter finder
 */
export interface IPythonInterpreterFinder {
    find(): string;
}

/**
 * Default interpreter finder
 */
class DefaultInterpreterFinder implements IPythonInterpreterFinder {
    find(): string {
        // On Windows, try 'py' launcher first
        if (process.platform === 'win32') {
            return 'py';
        }
        return 'python3';
    }
}

/**
 * Python Task Executor
 * Executes Python scripts with injectable runner and interpreter finder
 */
export class PythonTaskExecutor extends BaseTaskExecutor<PythonNodeConfig> {
    private runner: IPythonRunner;
    private interpreterFinder: IPythonInterpreterFinder;

    constructor(
        variableResolver?: IVariableResolver,
        runner?: IPythonRunner,
        interpreterFinder?: IPythonInterpreterFinder
    ) {
        super(variableResolver);
        this.runner = runner || new DefaultPythonRunner();
        this.interpreterFinder = interpreterFinder || new DefaultInterpreterFinder();
    }

    async execute(
        node: EtlNode,
        context: ExecutionContext
    ): Promise<EtlNodeExecutionResult> {
        const config = this.getConfig(node);
        const startTime = new Date();

        // Validate configuration
        if (!config.script && !config.scriptPath) {
            return this.createError(node.id, startTime, 'Python script or script path is required');
        }

        return this.safeExecute(node.id, startTime, async () => {
            const interpreter = config.interpreter || this.interpreterFinder.find();
            this.reportProgress(context, `Using Python interpreter: ${interpreter}`);

            // Prepare script
            const { scriptPath, tempScript } = await this.prepareScript(config, context);

            try {
                this.reportProgress(context, `Executing Python script: ${path.basename(scriptPath)}`);

                // Build arguments and environment
                const args = [
                    ...(config.interpreterArgs || []),
                    scriptPath,
                    ...(config.arguments || []),
                ];
                const env = this.buildEnvironment(context.variables);

                // Execute Python
                const result = await this.runWithProgress(
                    interpreter,
                    args,
                    env,
                    context,
                    config.timeout
                );

                // Return result based on exit code
                if (result.exitCode === 0) {
                    return this.createSuccess(node.id, startTime, { output: result.stdout });
                } else {
                    return this.resultBuilder(node.id)
                        .error(result.stderr || `Python exited with code ${result.exitCode}`)
                        .withOutput(result.stdout)
                        .build();
                }
            } finally {
                // Cleanup temp script
                if (tempScript) {
                    await this.cleanupTempScript(scriptPath);
                }
            }
        });
    }

    /**
     * Prepare script file (use existing or write temp file)
     */
    private async prepareScript(
        config: PythonNodeConfig,
        context: ExecutionContext
    ): Promise<{ scriptPath: string; tempScript: boolean }> {
        if (config.scriptPath) {
            const scriptPath = this.resolveVariables(config.scriptPath, context);
            if (!fs.existsSync(scriptPath)) {
                throw new Error(`Script file not found: ${scriptPath}`);
            }
            return { scriptPath, tempScript: false };
        }

        // Write inline script to temp file
        const script = this.resolveVariables(config.script, context);
        const scriptPath = path.join(os.tmpdir(), `etl_script_${Date.now()}.py`);
        await fs.promises.writeFile(scriptPath, script, 'utf-8');
        return { scriptPath, tempScript: true };
    }

    /**
     * Build environment with ETL variables
     */
    private buildEnvironment(variables: Record<string, string>): NodeJS.ProcessEnv {
        return {
            ...process.env,
            ...Object.fromEntries(
                Object.entries(variables).map(([k, v]) => [`ETL_VAR_${k.toUpperCase()}`, v])
            )
        };
    }

    /**
     * Run Python with progress reporting
     */
    private async runWithProgress(
        interpreter: string,
        args: string[],
        env: NodeJS.ProcessEnv,
        context: ExecutionContext,
        timeout?: number
    ): Promise<PythonResult> {
        // For simple runner, we run and report after
        const result = await this.runner.run(interpreter, args, env, timeout);

        // Report output lines as progress
        if (result.stdout) {
            for (const line of result.stdout.split('\n').slice(0, 10)) {
                if (line.trim()) {
                    this.reportProgress(context, `[Python] ${line.trim()}`);
                }
            }
        }

        if (result.stderr) {
            for (const line of result.stderr.split('\n').slice(0, 5)) {
                if (line.trim()) {
                    this.reportProgress(context, `[Python ERROR] ${line.trim()}`);
                }
            }
        }

        return result;
    }

    /**
     * Cleanup temporary script file
     */
    private async cleanupTempScript(scriptPath: string): Promise<void> {
        try {
            await fs.promises.unlink(scriptPath);
        } catch {
            // Ignore cleanup errors
        }
    }
}
