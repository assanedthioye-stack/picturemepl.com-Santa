import { argon2id, argon2Verify } from 'hash-wasm';

/** Same PHC format as the booth's @node-rs/argon2 hashes (argon2id, m=19456, t=2, p=1). */
export function hashPin(pin: string): Promise<string> {
  return argon2id({
    password: pin, salt: crypto.getRandomValues(new Uint8Array(16)),
    parallelism: 1, iterations: 2, memorySize: 19456, hashLength: 32, outputType: 'encoded',
  });
}

export function verifyPin(pin: string, hash: string): Promise<boolean> {
  return argon2Verify({ password: pin, hash }).catch(() => false);
}
