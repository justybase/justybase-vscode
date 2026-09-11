import { randomBytes } from 'node:crypto';
import type { OpaqueCredentialRequestId } from '@justybase/contracts';

export interface CredentialProvider {
  request(purpose: 'login' | 'connection'): Promise<string | undefined>;
}
/** Main-process-only credential broker. Renderer code sees only opaque IDs. */
export class MainCredentialBroker {
  private readonly values = new Map<OpaqueCredentialRequestId, string>();
  private disposed = false;

  public constructor(private readonly provider?: CredentialProvider) {}

  public async request(purpose: 'login' | 'connection'): Promise<OpaqueCredentialRequestId> {
    if (this.disposed) throw new Error('Credential broker is disposed.');
    const value = await this.provider?.request(purpose);
    if (!value) throw new Error('AUTH_CREDENTIAL_UNAVAILABLE');
    const requestId = randomBytes(18).toString('base64url') as OpaqueCredentialRequestId;
    this.values.set(requestId, value);
    return requestId;
  }

  public consume(requestId: OpaqueCredentialRequestId): string | undefined {
    if (this.disposed) return undefined;
    const value = this.values.get(requestId);
    this.values.delete(requestId);
    return value;
  }

  public revoke(requestId: OpaqueCredentialRequestId): void {
    this.values.delete(requestId);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.values.clear();
  }
}
