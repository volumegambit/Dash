import { describe, expect, it } from 'vitest';
import { decrypt, deriveKey, encrypt, generateSalt } from './crypto.js';

describe('crypto', () => {
  const password = 'test-password-123';

  describe('generateSalt', () => {
    it('returns a 32-byte buffer', () => {
      const salt = generateSalt();
      expect(salt).toBeInstanceOf(Buffer);
      expect(salt.length).toBe(32);
    });

    it('generates unique salts', () => {
      const salt1 = generateSalt();
      const salt2 = generateSalt();
      expect(salt1.equals(salt2)).toBe(false);
    });
  });

  describe('deriveKey', () => {
    it('returns a 32-byte buffer', () => {
      const salt = generateSalt();
      const key = deriveKey(password, salt);
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it('produces deterministic output for same inputs', () => {
      const salt = generateSalt();
      const key1 = deriveKey(password, salt);
      const key2 = deriveKey(password, salt);
      expect(key1.equals(key2)).toBe(true);
    });

    it('produces different keys for different passwords', () => {
      const salt = generateSalt();
      const key1 = deriveKey('password-a', salt);
      const key2 = deriveKey('password-b', salt);
      expect(key1.equals(key2)).toBe(false);
    });

    it('produces different keys for different salts', () => {
      const salt1 = generateSalt();
      const salt2 = generateSalt();
      const key1 = deriveKey(password, salt1);
      const key2 = deriveKey(password, salt2);
      expect(key1.equals(key2)).toBe(false);
    });
  });

  describe('encrypt / decrypt round-trip', () => {
    it('round-trips a simple string', () => {
      const salt = generateSalt();
      const key = deriveKey(password, salt);
      const plaintext = 'hello world';
      const payload = encrypt(plaintext, key, salt);
      const result = decrypt(payload, key);
      expect(result).toBe(plaintext);
    });

    it('round-trips JSON data', () => {
      const salt = generateSalt();
      const key = deriveKey(password, salt);
      const data = JSON.stringify({ 'api-key': 'sk-abc123', 'bot-token': 'tok-xyz' });
      const payload = encrypt(data, key, salt);
      const result = decrypt(payload, key);
      expect(result).toBe(data);
    });

    it('round-trips empty string', () => {
      const salt = generateSalt();
      const key = deriveKey(password, salt);
      const payload = encrypt('', key, salt);
      const result = decrypt(payload, key);
      expect(result).toBe('');
    });

    it('produces version 1 payload with base64 fields', () => {
      const salt = generateSalt();
      const key = deriveKey(password, salt);
      const payload = encrypt('data', key, salt);
      expect(payload.version).toBe(1);
      expect(typeof payload.salt).toBe('string');
      expect(typeof payload.iv).toBe('string');
      expect(typeof payload.tag).toBe('string');
      expect(typeof payload.ciphertext).toBe('string');
    });

    it('generates unique IVs on each encrypt', () => {
      const salt = generateSalt();
      const key = deriveKey(password, salt);
      const p1 = encrypt('same data', key, salt);
      const p2 = encrypt('same data', key, salt);
      expect(p1.iv).not.toBe(p2.iv);
    });
  });

  describe('decrypt failures', () => {
    it('throws on wrong key', () => {
      const salt = generateSalt();
      const key = deriveKey(password, salt);
      const wrongKey = deriveKey('wrong-password', salt);
      const payload = encrypt('secret', key, salt);
      expect(() => decrypt(payload, wrongKey)).toThrow();
    });

    it('throws on tampered ciphertext', () => {
      const salt = generateSalt();
      const key = deriveKey(password, salt);
      const payload = encrypt('secret', key, salt);
      const tampered = { ...payload, ciphertext: `AAAA${payload.ciphertext.slice(4)}` };
      expect(() => decrypt(tampered, key)).toThrow();
    });

    it('throws on tampered tag', () => {
      const salt = generateSalt();
      const key = deriveKey(password, salt);
      const payload = encrypt('secret', key, salt);
      const buf = Buffer.from(payload.tag, 'base64');
      buf[0] ^= 0xff;
      const tampered = { ...payload, tag: buf.toString('base64') };
      expect(() => decrypt(tampered, key)).toThrow();
    });

    it('throws on tampered IV', () => {
      const salt = generateSalt();
      const key = deriveKey(password, salt);
      const payload = encrypt('secret', key, salt);
      const buf = Buffer.from(payload.iv, 'base64');
      buf[0] ^= 0xff;
      const tampered = { ...payload, iv: buf.toString('base64') };
      expect(() => decrypt(tampered, key)).toThrow();
    });
  });
});
