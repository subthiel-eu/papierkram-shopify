import { runGraphql, type AdminGraphqlClient } from "./admin-client";
import {
  METAFIELD_DEFINITION_CREATE_MUTATION,
  METAFIELDS_SET_MUTATION,
} from "./queries";

export const NAMESPACE = "papierkram";

interface MetafieldInput {
  ownerId: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
}

interface UserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

/**
 * Definitionen sorgen dafuer, dass die Werte im Shopify-Admin sichtbar sind und
 * in Flow/Liquid/Exporten als benannte Felder auftauchen.
 */
const DEFINITIONS = [
  { ownerType: "ORDER", key: "invoice_id", name: "Papierkram Rechnungs-ID", type: "single_line_text_field" },
  { ownerType: "ORDER", key: "invoice_no", name: "Papierkram Rechnungsnummer", type: "single_line_text_field" },
  { ownerType: "ORDER", key: "invoice_state", name: "Papierkram Rechnungsstatus", type: "single_line_text_field" },
  { ownerType: "ORDER", key: "invoice_url", name: "Papierkram Rechnungslink", type: "url" },
  { ownerType: "ORDER", key: "invoice_total", name: "Papierkram Rechnungsbetrag", type: "single_line_text_field" },
  { ownerType: "DRAFTORDER", key: "estimate_id", name: "Papierkram Angebots-ID", type: "single_line_text_field" },
  { ownerType: "DRAFTORDER", key: "estimate_no", name: "Papierkram Angebotsnummer", type: "single_line_text_field" },
  { ownerType: "DRAFTORDER", key: "estimate_url", name: "Papierkram Angebotslink", type: "url" },
  { ownerType: "CUSTOMER", key: "contact_id", name: "Papierkram Kontakt-ID", type: "single_line_text_field" },
  { ownerType: "CUSTOMER", key: "contact_no", name: "Papierkram Kundennummer", type: "single_line_text_field" },
  { ownerType: "CUSTOMER", key: "contact_url", name: "Papierkram Kontaktlink", type: "url" },
] as const;

/**
 * Legt alle Metafeld-Definitionen an. Bereits vorhandene Definitionen melden
 * TAKEN und werden uebersprungen.
 */
export async function ensureMetafieldDefinitions(admin: AdminGraphqlClient) {
  const created: string[] = [];
  const skipped: string[] = [];

  for (const definition of DEFINITIONS) {
    try {
      const data = await runGraphql<{
        metafieldDefinitionCreate: {
          createdDefinition: { id: string; key: string } | null;
          userErrors: UserError[];
        };
      }>(admin, METAFIELD_DEFINITION_CREATE_MUTATION, {
        definition: {
          namespace: NAMESPACE,
          key: definition.key,
          name: definition.name,
          ownerType: definition.ownerType,
          type: definition.type,
        },
      });

      const errors = data.metafieldDefinitionCreate.userErrors;
      if (errors.length > 0) {
        // TAKEN bedeutet: existiert schon - das ist der Normalfall.
        if (errors.every((error) => error.code === "TAKEN")) {
          skipped.push(definition.key);
        } else {
          throw new Error(errors.map((error) => error.message).join("; "));
        }
      } else {
        created.push(definition.key);
      }
    } catch (error) {
      // Einzelne fehlende Definition darf die Installation nicht blockieren.
      console.warn(
        `[papierkram] Metafeld-Definition ${definition.ownerType}.${definition.key} nicht angelegt:`,
        error,
      );
    }
  }

  return { created, skipped };
}

/** Schreibt Metafelder. Leere Werte werden ausgelassen. */
export async function setMetafields(
  admin: AdminGraphqlClient,
  ownerId: string,
  values: Record<string, string | number | null | undefined>,
): Promise<UserError[]> {
  const metafields: MetafieldInput[] = Object.entries(values)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => ({
      ownerId,
      namespace: NAMESPACE,
      key,
      type: key.endsWith("_url") ? "url" : "single_line_text_field",
      value: String(value),
    }));

  if (metafields.length === 0) return [];

  const data = await runGraphql<{
    metafieldsSet: { userErrors: UserError[] };
  }>(admin, METAFIELDS_SET_MUTATION, { metafields });

  return data.metafieldsSet.userErrors;
}
