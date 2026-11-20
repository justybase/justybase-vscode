import { NetezzaReferenceProvider } from '../../dialects/netezza/copilot/NetezzaReferenceProvider';

const provider = new NetezzaReferenceProvider();

/**
 * Netezza reference text shared by the Copilot tools and the MCP server.
 * The provider is plain TypeScript (no `vscode` imports), so it is safe inside
 * the standalone MCP process.
 */
export function getNetezzaAssistantReference(topic: 'optimization' | 'nzplsql' | 'all' = 'all'): string {
  if (topic === 'nzplsql') return provider.getNetezzaReference('nzplsql');
  if (topic === 'optimization') return provider.getNetezzaReference('optimization');
  return provider.getNetezzaReference('all');
}
