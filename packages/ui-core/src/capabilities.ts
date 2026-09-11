import type { CapabilityDescriptor } from '@justybase/contracts';
import type { CapabilityPort } from './ports';

export class CapabilityUnavailableError extends Error {
  public readonly descriptor: CapabilityDescriptor;

  public constructor(descriptor: CapabilityDescriptor) {
    super(descriptor.reason ?? `Capability '${descriptor.key}' is ${descriptor.status}.`);
    this.name = 'CapabilityUnavailableError';
    this.descriptor = descriptor;
  }
}
/** Immutable-by-default capability registry owned by a product adapter. */
export class CapabilityRegistry implements CapabilityPort {
  private readonly descriptors: Map<string, CapabilityDescriptor>;
  private disposed = false;

  public constructor(descriptors: readonly CapabilityDescriptor[] = []) {
    this.descriptors = new Map(descriptors.map(descriptor => [descriptor.key, { ...descriptor }]));
  }

  public list(): readonly CapabilityDescriptor[] {
    return [...this.descriptors.values()].map(descriptor => ({ ...descriptor }));
  }

  public get(key: string): CapabilityDescriptor | undefined {
    const descriptor = this.descriptors.get(key);
    return descriptor ? { ...descriptor } : undefined;
  }

  public require(key: string): CapabilityDescriptor {
    const descriptor = this.descriptors.get(key);
    if (!descriptor) {
      throw new CapabilityUnavailableError({
        key,
        status: 'unsupported',
        owner: 'capability-registry',
        documentation: 'No descriptor was registered for this capability.',
        removalCondition: 'Register a product-owned capability descriptor.',
      });
    }
    if (descriptor.status !== 'available' && descriptor.status !== 'read-only') throw new CapabilityUnavailableError(descriptor);
    return { ...descriptor };
  }

  public set(descriptor: CapabilityDescriptor): void {
    if (this.disposed) throw new Error('Capability registry is disposed.');
    this.descriptors.set(descriptor.key, { ...descriptor });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.descriptors.clear();
  }
}
