import { ValueTransformer } from 'typeorm';
import { EncryptionService } from './encryption.service';
import { DecryptionFailedException } from './decryption-failed.exception';

/**
 * Module-scoped reference to the Nest DI-managed EncryptionService instance.
 *
 * TypeORM column transformers are plain functions with no access to Nest's DI
 * container, so the DI-managed instance is registered here once at bootstrap
 * (see EncryptionService's constructor) and reused by every encrypted column.
 * This avoids maintaining a parallel hand-rolled singleton that could drift
 * from the DI-managed instance (e.g. under non-default injection scopes or
 * runtime key rotation).
 */
let encryptionServiceInstance: EncryptionService | null = null;

export function setEncryptionServiceInstance(
  service: EncryptionService,
): void {
  encryptionServiceInstance = service;
}

function getEncryptionService(): EncryptionService {
  if (!encryptionServiceInstance) {
    throw new Error(
      'EncryptionService has not been registered yet. Ensure the security module is initialized before using encrypted columns.',
    );
  }
  return encryptionServiceInstance;
}

export function encryptedColumnTransformer(
  fieldName: string,
): ValueTransformer {
  return {
    to(value: string | null): string | null {
      if (value == null || value === '') return value;
      if (value.startsWith('encv1:')) {
        return value;
      }

      return getEncryptionService().encrypt(value);
    },
    from(value: string | null): string | null {
      if (value == null || value === '') return value;
      try {
        return getEncryptionService().decrypt(value);
      } catch (error) {
        getEncryptionService().logDecryptionFailure(fieldName, error);
        throw new DecryptionFailedException(fieldName, error);
      }
    },
  };
}
