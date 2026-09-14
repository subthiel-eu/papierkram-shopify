import type { ShopSettings } from "@prisma/client";

import prisma from "~/db.server";
import { decryptSecret, encryptSecret } from "~/lib/crypto.server";
import { PapierkramClient } from "~/papierkram/client.server";
import { PapierkramNotConfiguredError } from "~/papierkram/errors";
import type { MappingSettings } from "~/sync/mapper";

export type { ShopSettings };

/** Liest die Einstellungen eines Shops und legt sie beim ersten Zugriff an. */
export async function getSettings(shop: string): Promise<ShopSettings> {
  const existing = await prisma.shopSettings.findUnique({ where: { shop } });
  if (existing) return existing;
  return prisma.shopSettings.create({ data: { shop } });
}

export async function updateSettings(
  shop: string,
  data: Partial<Omit<ShopSettings, "id" | "shop" | "createdAt" | "updatedAt">>,
): Promise<ShopSettings> {
  return prisma.shopSettings.upsert({
    where: { shop },
    create: { shop, ...data },
    update: data,
  });
}

/** Speichert den API-Token verschluesselt. Leerer Wert loescht ihn. */
export async function setApiToken(shop: string, token: string | null) {
  return updateSettings(shop, {
    apiTokenCipher: token ? encryptSecret(token) : null,
    connectionOkAt: null,
  });
}

export function hasCredentials(settings: ShopSettings): boolean {
  return Boolean(settings.subdomain && settings.apiTokenCipher);
}

/** Entschluesselt den Token. Gibt null zurueck, wenn keiner gesetzt ist. */
export function readApiToken(settings: ShopSettings): string | null {
  if (!settings.apiTokenCipher) return null;
  try {
    return decryptSecret(settings.apiTokenCipher);
  } catch {
    // Falscher/rotierter Schluessel: lieber "nicht konfiguriert" melden als
    // mit Muell weiterzuarbeiten.
    return null;
  }
}

/**
 * Baut einen Papierkram-Client fuer den Shop. Der beobachtete Quota-Stand
 * wird nebenlaeufig zurueckgeschrieben.
 */
export function buildClient(settings: ShopSettings): PapierkramClient {
  const token = readApiToken(settings);
  if (!settings.subdomain || !token) {
    throw new PapierkramNotConfiguredError(
      "Bitte zuerst Papierkram-Subdomain und API-Token in den Einstellungen hinterlegen.",
    );
  }

  return new PapierkramClient({
    subdomain: settings.subdomain,
    apiToken: token,
    onQuota: (remaining) => {
      prisma.shopSettings
        .update({
          where: { shop: settings.shop },
          data: { remainingQuota: remaining },
        })
        .catch(() => {
          /* Quota-Anzeige ist nur informativ. */
        });
    },
  });
}

/** Convenience: Einstellungen laden und Client bauen. */
export async function clientFor(shop: string) {
  const settings = await getSettings(shop);
  return { settings, client: buildClient(settings) };
}

/** Projiziert die DB-Einstellungen auf das, was der Mapper braucht. */
export function toMappingSettings(settings: ShopSettings): MappingSettings {
  const grossMode =
    settings.grossMode === "gross" || settings.grossMode === "net"
      ? settings.grossMode
      : "auto";

  return {
    documentCurrency: settings.documentCurrency,
    allowForeignCurrency: settings.allowForeignCurrency,
    homeCountry: settings.homeCountry,
    taxScheme: settings.taxScheme,
    reverseChargeEnabled: settings.reverseChargeEnabled,
    reverseChargeNote: settings.reverseChargeNote,
    kleinunternehmerNote: settings.kleinunternehmerNote,
    vatIdSource: settings.vatIdSource,
    vatIdKey: settings.vatIdKey,
    grossMode,
    defaultVatRate: settings.defaultVatRate,
    includeShipping: settings.includeShipping,
    shippingLabel: settings.shippingLabel,
    includeTips: settings.includeTips,
    applyDiscounts: settings.applyDiscounts,
    documentNameTemplate: settings.documentNameTemplate,
    fallbackToPersonName: settings.fallbackToPersonName,
    paymentTermId: settings.paymentTermId,
    invoiceTemplateId: settings.invoiceTemplateId,
    estimateTemplateId: settings.estimateTemplateId,
    projectId: settings.projectId,
  };
}
