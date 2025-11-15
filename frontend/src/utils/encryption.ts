/**
 * Encryption utilities for private keys
 * Uses Web Crypto API for secure encryption/decryption
 */

/**
 * Derive a key from a password using PBKDF2
 */
async function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000, // High iteration count for security
      hash: "SHA-256"
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypt a private key with a password
 * Returns: base64(encryptedData) + ":" + base64(salt) + ":" + base64(iv)
 */
export async function encryptPrivateKey(
  privateKey: string,
  password: string
): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(privateKey);

  // Generate random salt and IV
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 12 bytes for GCM

  // Derive key from password
  const key = await deriveKeyFromPassword(password, salt);

  // Encrypt
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv
    },
    key,
    data
  );

  // Combine: encryptedData:salt:iv (all base64)
  const encryptedArray = new Uint8Array(encrypted);
  const encryptedB64 = btoa(String.fromCharCode(...encryptedArray));
  const saltB64 = btoa(String.fromCharCode(...salt));
  const ivB64 = btoa(String.fromCharCode(...iv));

  return `${encryptedB64}:${saltB64}:${ivB64}`;
}

/**
 * Decrypt a private key with a password
 * Input format: base64(encryptedData) + ":" + base64(salt) + ":" + base64(iv)
 */
export async function decryptPrivateKey(
  encryptedData: string,
  password: string
): Promise<string> {
  const parts = encryptedData.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted data format");
  }

  const [encryptedB64, saltB64, ivB64] = parts;

  // Decode from base64
  const encrypted = Uint8Array.from(
    atob(encryptedB64),
    (c) => c.charCodeAt(0)
  );
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));

  // Derive key from password
  const key = await deriveKeyFromPassword(password, salt);

  // Decrypt
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: iv
    },
    key,
    encrypted
  );

  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}

/**
 * Check if a string is encrypted (has the format encrypted:salt:iv)
 */
export function isEncrypted(data: string): boolean {
  return data.includes(":") && data.split(":").length === 3;
}


