const crypto = require("crypto");

// Field-level encryption for stored message content (transcript text).
// AES-256-GCM: random 96-bit IV per value, auth tag prevents tampering.
const ALGORITHM = "aes-256-gcm";
const KEY_ENV = "DB_ENCRYPTION_KEY";
const PREFIX = "enc1"; // format version tag, lets decryptText fall back for legacy plaintext rows

const rawKey = process.env[KEY_ENV];
if (!rawKey || Buffer.from(rawKey, "hex").length !== 32) {
  throw new Error(
    `❌ ${KEY_ENV} is missing or invalid. It must be a 64-character hex string ` +
      `(32 bytes) in .env. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  );
}
const KEY = Buffer.from(rawKey, "hex");

function encryptText(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    PREFIX,
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

function decryptText(stored) {
  if (typeof stored !== "string" || !stored.startsWith(`${PREFIX}:`)) {
    return stored; // legacy plaintext row written before encryption was added
  }
  const [, ivB64, tagB64, dataB64] = stored.split(":");
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

module.exports = { encryptText, decryptText };
