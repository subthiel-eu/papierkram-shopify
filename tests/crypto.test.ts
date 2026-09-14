import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decryptSecret, encryptSecret, maskSecret } from "~/lib/crypto.server";
import { money, round, toNumber, unitPrice } from "~/lib/money";

const originalKey = process.env.PAPIERKRAM_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.PAPIERKRAM_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

afterEach(() => {
  process.env.PAPIERKRAM_ENCRYPTION_KEY = originalKey;
});

describe("Token-Verschluesselung", () => {
  it("verschluesselt und entschluesselt verlustfrei", () => {
    const token = "pk_live_0123456789abcdef";
    expect(decryptSecret(encryptSecret(token))).toBe(token);
  });

  it("erzeugt bei gleichem Klartext unterschiedliche Chiffrate", () => {
    expect(encryptSecret("gleich")).not.toBe(encryptSecret("gleich"));
  });

  it("erkennt manipulierte Daten", () => {
    const cipher = encryptSecret("geheim");
    const [iv, tag, data] = cipher.split(":");
    const tampered = [iv, tag, Buffer.from("boesartig").toString("base64")].join(":");
    expect(() => decryptSecret(tampered)).toThrow();
    expect(() => decryptSecret(`${iv}:${tag}`)).toThrow(/Format/);
    expect(data.length).toBeGreaterThan(0);
  });

  it("scheitert mit falschem Schluessel", () => {
    const cipher = encryptSecret("geheim");
    process.env.PAPIERKRAM_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    expect(() => decryptSecret(cipher)).toThrow();
  });

  it("verlangt einen 32 Byte langen Schluessel", () => {
    process.env.PAPIERKRAM_ENCRYPTION_KEY = Buffer.from("zu kurz").toString("base64");
    expect(() => encryptSecret("x")).toThrow(/32 Byte/);
  });

  it("maskiert bis auf die letzten vier Zeichen", () => {
    expect(maskSecret("abcdefgh")).toMatch(/\*+efgh$/);
    expect(maskSecret("ab")).toBe("****");
  });
});

describe("Geldbetraege", () => {
  it("liest Shopify-Strings", () => {
    expect(toNumber("12.90")).toBe(12.9);
    expect(toNumber(null)).toBe(0);
    expect(toNumber("keine Zahl")).toBe(0);
  });

  it("rundet kaufmaennisch auf Cent", () => {
    expect(money(2.675)).toBe(2.68);
    expect(money(1.005)).toBe(1.01);
    expect(money(-1.005)).toBe(-1.01);
  });

  it("laesst Stueckpreise feiner aufgeloest", () => {
    expect(unitPrice(100 / 3)).toBe(33.3333);
    expect(round(1.23456789, 6)).toBe(1.234568);
  });
});
