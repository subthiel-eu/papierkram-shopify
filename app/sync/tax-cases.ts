import type { Address, Customer, Order } from "./shopify-types";

/**
 * Steuerliche Sonderfaelle, die mehr brauchen als 0 %.
 *
 * Ein Beleg mit 0 % ohne den vorgeschriebenen Hinweis ist rechnerisch richtig
 * und als Rechnung trotzdem unvollstaendig. Deshalb liefert die Ermittlung
 * hier immer beides: Satz und Text.
 */
export type TaxCase =
  | "standard"
  | "kleinunternehmer"
  | "reverse_charge"
  | "export";

export interface TaxCaseSettings {
  /** standard | kleinunternehmer */
  taxScheme: string;
  reverseChargeEnabled: boolean;
  reverseChargeNote: string;
  kleinunternehmerNote: string;
}

export interface TaxCaseResult {
  taxCase: TaxCase;
  /** true = alle Positionen mit 0 % ausweisen. */
  zeroRated: boolean;
  /** Pflichthinweis fuer den Beleg, leer bei "standard". */
  note: string;
  /** USt-IdNr. des Empfaengers, sofern gefunden. */
  vatId: string | null;
}

/** EU-Mitgliedstaaten nach ISO-3166-1 alpha-2, Stand 2026. */
const EU_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
  "SI", "ES", "SE",
]);

export function isEuCountry(code: string | null | undefined): boolean {
  return code ? EU_COUNTRIES.has(code.trim().toUpperCase()) : false;
}

/**
 * Gueltige Praefixe einer USt-IdNr.
 *
 * Nicht deckungsgleich mit den ISO-Codes: Griechenland fuehrt EL statt GR,
 * und Nordirland hat mit XI ein eigenes Praefix.
 */
const VAT_PREFIXES = new Set([...EU_COUNTRIES, "EL", "XI"]);

/**
 * Grobe Formpruefung einer USt-IdNr.: bekanntes Laenderpraefix, 2 bis 12
 * weitere Zeichen, darunter mindestens eine Ziffer.
 *
 * Bewusst keine Pruefsummen- oder VIES-Pruefung - das gehoert in den
 * Bestellprozess, nicht in die Belegerzeugung. Die Ziffernbedingung ist
 * trotzdem noetig: ohne sie wuerde aus dem Freitext "weiss nicht" ein
 * scheinbar gueltiges "WEISSNICHT".
 */
export function normalizeVatId(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const value = raw.replace(/[\s.\-/]/g, "").toUpperCase();
  if (!/^[A-Z]{2}[0-9A-Z]{2,12}$/.test(value)) return null;

  const prefix = value.slice(0, 2);
  const rest = value.slice(2);
  if (!VAT_PREFIXES.has(prefix)) return null;
  return /\d/.test(rest) ? value : null;
}

export interface VatIdSourceSettings {
  /** auto | order_attribute | order_metafield | customer_metafield | none */
  vatIdSource: string;
  /** Schluessel bzw. "namespace.key". */
  vatIdKey: string;
}

/**
 * Sucht die USt-IdNr. des Kunden.
 *
 * Shopify legt sie je nach Aufbau des Shops unterschiedlich ab: als
 * Bestellattribut aus dem Checkout, als Metafeld an Bestellung oder Kunde,
 * oder bei B2B am Unternehmen. "auto" sieht der Reihe nach ueberall nach,
 * damit kein Shop erst umgebaut werden muss.
 */
export function findVatId(
  order: Pick<Order, "customAttributes" | "metafield" | "purchasingEntity" | "customer">,
  settings: VatIdSourceSettings,
): string | null {
  const source = settings.vatIdSource;
  if (source === "none") return null;

  const key = settings.vatIdKey.trim();
  const attributeKey = key.includes(".") ? key.split(".").pop()! : key;

  const fromAttribute = () =>
    order.customAttributes?.find(
      (attribute) => attribute.key.trim().toLowerCase() === attributeKey.toLowerCase(),
    )?.value ?? null;

  const fromOrderMetafield = () => order.metafield?.value ?? null;
  const fromCustomerMetafield = () => order.customer?.metafield?.value ?? null;
  const fromCompany = () =>
    order.purchasingEntity?.company?.externalId ??
    order.purchasingEntity?.company?.name ??
    null;

  const candidates =
    source === "order_attribute"
      ? [fromAttribute]
      : source === "order_metafield"
        ? [fromOrderMetafield]
        : source === "customer_metafield"
          ? [fromCustomerMetafield]
          : // auto
            [fromAttribute, fromOrderMetafield, fromCustomerMetafield, fromCompany];

  for (const candidate of candidates) {
    const value = normalizeVatId(candidate());
    if (value) return value;
  }
  return null;
}

/**
 * Ermittelt den Steuerfall einer Bestellung.
 *
 * Reihenfolge ist wichtig: die Kleinunternehmerregelung gilt fuer alle
 * Umsaetze und schlaegt deshalb alles andere.
 */
export function resolveTaxCase(args: {
  settings: TaxCaseSettings & VatIdSourceSettings;
  /** Sitz des Haendlers, z.B. "DE". */
  homeCountry: string;
  /** Lieferland aus der Rechnungs- bzw. Lieferadresse. */
  destination: Pick<Address, "countryCodeV2"> | null;
  /** Faellt in der Bestellung ueberhaupt Steuer an? */
  orderHasTax: boolean;
  order: Pick<Order, "customAttributes" | "metafield" | "purchasingEntity" | "customer">;
}): TaxCaseResult {
  const { settings } = args;
  const vatId = findVatId(args.order, settings);
  const destination = args.destination?.countryCodeV2?.trim().toUpperCase() ?? null;
  const home = args.homeCountry.trim().toUpperCase();

  if (settings.taxScheme === "kleinunternehmer") {
    return {
      taxCase: "kleinunternehmer",
      zeroRated: true,
      note: settings.kleinunternehmerNote,
      vatId,
    };
  }

  // Innergemeinschaftliche B2B-Lieferung: anderes EU-Land plus gueltige
  // USt-IdNr. Ohne die Nummer bleibt es eine normale Lieferung mit Steuer.
  if (
    settings.reverseChargeEnabled &&
    vatId &&
    destination &&
    destination !== home &&
    isEuCountry(destination) &&
    isEuCountry(home)
  ) {
    return {
      taxCase: "reverse_charge",
      zeroRated: true,
      note: settings.reverseChargeNote,
      vatId,
    };
  }

  // Drittland und Shopify weist keine Steuer aus: Ausfuhrlieferung.
  if (destination && !isEuCountry(destination) && destination !== home && !args.orderHasTax) {
    return {
      taxCase: "export",
      zeroRated: true,
      note: "Steuerfreie Ausfuhrlieferung.",
      vatId,
    };
  }

  return { taxCase: "standard", zeroRated: false, note: "", vatId };
}

/** Lesbare Bezeichnung fuer Protokoll und Oberflaeche. */
export function taxCaseLabel(taxCase: TaxCase): string {
  switch (taxCase) {
    case "kleinunternehmer":
      return "Kleinunternehmer (§ 19 UStG)";
    case "reverse_charge":
      return "Reverse Charge";
    case "export":
      return "Ausfuhrlieferung";
    default:
      return "Regelbesteuerung";
  }
}

export type { Customer };
