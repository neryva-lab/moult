import { capability } from '@moult/runtime';

/** Versioned key-value storage provisioned by the storage plugin. */
export interface Storage {
  readonly get: (key: string) => string | undefined;
  readonly set: (key: string, value: string) => void;
}

/** Single-provider storage token owned by the active storage generation. */
export const storageCapability = capability<Storage>('demo.storage', '1.0.0');

/**
 * Multi-provider token: every provider publishes an array; consumers receive
 * the frozen concatenation, host providers first.
 */
export const analyticsCapability = capability<readonly string[]>('demo.analytics', '1.0.0', {
  multiple: true,
});

/** Optional logger capability; absence is a supported state. */
export const optionalLoggerCapability = capability<{ log: (m: string) => void }>(
  'demo.logger',
  '1.0.0',
);

/** Host-owned logger token, supplied at runtime construction. */
export const hostLoggerCapability = capability<{ log: (m: string) => void }>(
  'host.logger',
  '1.0.0',
);

/** Host-owned configuration token, supplied at runtime construction. */
export const hostConfigCapability = capability<{ env: string }>('host.config', '1.0.0');

/**
 * Versioned contract at v2: consumers requiring ^1.0.0 fail resolution with
 * INCOMPATIBLE_CAPABILITY.
 */
export const versionedCapability = capability<{ v: number }>('demo.versioned', '2.0.0');

/** The 1.0.0 variant of the versioned contract, for semver range coverage. */
export const versionedCapabilityV1 = capability<{ v: number }>('demo.versioned', '1.0.0');

/** Token linking the cascade root plugin to its dependent. */
export const cascadeRootCapability = capability<{ id: string }>('demo.cascade-root', '1.0.0');

/** Notification token provided by the dashboard plugin. */
export const notificationCapability = capability<{ notify: (msg: string) => void }>(
  'demo.notifications',
  '1.0.0',
);
