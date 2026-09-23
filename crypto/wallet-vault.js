/**
 * Wallet & secrets vault.
 *
 * Private keys and per-user API secrets are AES-256-GCM encrypted with a
 * server-side master key that lives ONLY on disk (never in the database,
 * never logged, never returned by any bot command or API response). The
 * running trading process reads it once at startup to sign transactions and
 * decrypt user secrets automatically — this is what makes 24/7 autonomous
 * trading possible without the user being online.
 *
 * Threat model: a database dump alone reveals nothing (ciphertext only). An
 * attacker needs BOTH the DB and this key file (perm 600, outside git) to
 * recover a private key. Plaintext private keys are only ever exposed via the
 * explicit `/exportkey` Telegram command, gated by a typed confirmation from
 * that same telegramId, and are never written to logs.
 */

import fs from "fs";
import crypto from "crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { repoPath } from "../repo-root.js";

const MASTER_KEY_PATH = process.env.WALLET_MASTER_KEY_PATH || repoPath("secrets", "wallet.master.key");
const CURRENT_KEY_VERSION = 1;
const ALGO = "aes-256-gcm";

let _masterKeyCache = null;

/** Load the master key from disk, generating one on first run. */
function loadMasterKey() {
  if (_masterKeyCache) return _masterKeyCache;

  const dir = MASTER_KEY_PATH.slice(0, MASTER_KEY_PATH.lastIndexOf("/"));
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  if (!fs.existsSync(MASTER_KEY_PATH)) {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(MASTER_KEY_PATH, key.toString("base64"), { mode: 0o600 });
    _masterKeyCache = key;
    return key;
  }

  const raw = fs.readFileSync(MASTER_KEY_PATH, "utf8").trim();
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(`Wallet master key at ${MASTER_KEY_PATH} is not a valid 32-byte key.`);
  }
  _masterKeyCache = key;
  return key;
}

/** Derive a purpose-scoped subkey from the master key (defense in depth). */
function deriveKey(label, version = CURRENT_KEY_VERSION) {
  const master = loadMasterKey();
  return crypto.createHmac("sha256", master).update(`meridian:v${version}:${label}`).digest();
}

/**
 * Encrypt a plaintext string. Returns a JSON string bundle safe to store in
 * a single TEXT/VARCHAR column: {v, iv, tag, ciphertext} all base64.
 */
export function encryptField(plainText, label, version = CURRENT_KEY_VERSION) {
  if (plainText == null) return null;
  const key = deriveKey(label, version);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: version,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
}

/** Decrypt a bundle produced by encryptField(). Returns null on empty input. */
export function decryptField(bundleJson, label) {
  if (!bundleJson) return null;
  const bundle = JSON.parse(bundleJson);
  const key = deriveKey(label, bundle.v || 1);
  const iv = Buffer.from(bundle.iv, "base64");
  const tag = Buffer.from(bundle.tag, "base64");
  const ciphertext = Buffer.from(bundle.ciphertext, "base64");
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

const WALLET_LABEL = "wallet-private-key";

/** Generate a brand-new Solana wallet. Never persists the plaintext key. */
export function generateWallet() {
  const keypair = Keypair.generate();
  const publicKey = keypair.publicKey.toBase58();
  const secretKeyBase58 = bs58.encode(keypair.secretKey);
  return { publicKey, secretKeyBase58 };
}

/** Validate and normalize an imported base58 secret key without persisting plaintext. */
export function importWallet(secretKeyBase58) {
  const normalized = String(secretKeyBase58 || "").trim();
  if (!normalized) throw new Error("Private key is required");
  const keypair = Keypair.fromSecretKey(bs58.decode(normalized));
  return { publicKey: keypair.publicKey.toBase58(), secretKeyBase58: normalized };
}

/** Encrypt a base58 secret key for storage in Wallet.encryptedPrivateKey. */
export function encryptWalletSecretKey(secretKeyBase58) {
  return encryptField(secretKeyBase58, WALLET_LABEL);
}

/** Decrypt Wallet.encryptedPrivateKey back to the base58 secret key. */
export function decryptWalletSecretKey(encryptedPrivateKey) {
  return decryptField(encryptedPrivateKey, WALLET_LABEL);
}

/** Convenience: decrypt straight to a usable Keypair for signing. */
export function decryptWalletKeypair(encryptedPrivateKey) {
  const secretKeyBase58 = decryptWalletSecretKey(encryptedPrivateKey);
  return Keypair.fromSecretKey(bs58.decode(secretKeyBase58));
}

const SECRET_LABEL = "user-secret";

/** Encrypt a generic per-user secret (API key, RPC URL, etc). */
export function encryptUserSecret(plainText) {
  return encryptField(plainText, SECRET_LABEL);
}

/** Decrypt a generic per-user secret. */
export function decryptUserSecret(bundleJson) {
  return decryptField(bundleJson, SECRET_LABEL);
}
