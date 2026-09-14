import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

/**
 * Der Papierkram-API-Token liegt verschluesselt in der Datenbank. Der Schluessel
 * kommt aus PAPIERKRAM_ENCRYPTION_KEY (32 Byte, base64- oder hex-kodiert).
 */
function key(): Buffer {
  const raw = process.env.PAPIERKRAM_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "PAPIERKRAM_ENCRYPTION_KEY fehlt. Erzeugen mit: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  const buf = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(
      `PAPIERKRAM_ENCRYPTION_KEY muss 32 Byte lang sein (ist ${buf.length}).`,
    );
  }
  return buf;
}

/** Verschluesselt einen Klartext zu "iv:authTag:ciphertext" (alles base64). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    enc.toString("base64"),
  ].join(":");
}

/** Gegenstueck zu encryptSecret. Wirft bei manipulierten Daten. */
export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(":");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Ungueltiges Format des verschluesselten Tokens.");
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    key(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Zeigt nur die letzten vier Zeichen eines Tokens an. */
export function maskSecret(plain: string): string {
  if (plain.length <= 4) return "****";
  return `${"*".repeat(Math.min(plain.length - 4, 24))}${plain.slice(-4)}`;
}
