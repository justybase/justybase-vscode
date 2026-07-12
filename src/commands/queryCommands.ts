/**
 * Query Commands public facade
 * Keeps backward-compatible exports while implementation lives under commands/query/.
 */

export type {
    QueryCommandsDependencies,
    ConfigurationProvider,
    UIService
} from './query/queryCommandTypes';

export {
    DefaultUIService,
    DefaultConfigurationProvider
} from './query/queryCommandTypes';

export {
    stripLeadingComments,
    detectRiskyStatements,
    formatRiskyStatementMessage,
    confirmSafeExecuteWithDeps,
    handleExecutionCompletionWithDeps
} from './query/queryCommandSafety';

export { registerQueryCommands } from './query/queryCommandRegistration';
