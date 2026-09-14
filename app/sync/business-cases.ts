/**
 * Katalog der Geschaeftsfaelle und der Webhooks, die sie ausloesen koennen.
 *
 * Die App abonniert alle hier gelisteten Topics fest (Shopify erlaubt keine
 * shop-spezifischen Abos ueber die App-Konfiguration). Welches Topic welchen
 * Geschaeftsfall ausloest, entscheidet pro Shop die Regeltabelle - siehe
 * app/models/rules.server.ts.
 */

export type BusinessCase =
  | "invoice_create"
  | "estimate_create"
  | "customer_sync"
  | "document_refresh"
  | "refund_notice"
  | "cancel_notice";

/** Wie ein Beleg nach dem Anlegen behandelt wird. */
export type DocumentMode = "draft" | "pdf" | "email";

export interface TopicDefinition {
  /** Schreibweise in shopify.app.toml. */
  topic: string;
  /** Schreibweise, in der authenticate.webhook() das Topic liefert. */
  event: string;
  label: string;
  hint?: string;
}

export interface BusinessCaseDefinition {
  key: BusinessCase;
  label: string;
  description: string;
  /** Erlaubt der Fall eine Nachbehandlung (Entwurf/festschreiben/senden)? */
  supportsMode: boolean;
  topics: TopicDefinition[];
}

const ORDERS_CREATE: TopicDefinition = {
  topic: "orders/create",
  event: "ORDERS_CREATE",
  label: "Bestellung eingegangen",
  hint: "Feuert unabhaengig davon, ob bezahlt wurde.",
};

const ORDERS_PAID: TopicDefinition = {
  topic: "orders/paid",
  event: "ORDERS_PAID",
  label: "Bestellung bezahlt",
  hint: "Feuert, sobald Shopify die Zahlung als vollstaendig meldet.",
};

const ORDERS_FULFILLED: TopicDefinition = {
  topic: "orders/fulfilled",
  event: "ORDERS_FULFILLED",
  label: "Bestellung vollstaendig versendet",
  hint: "Teillieferungen loesen das nicht aus.",
};

const ORDERS_PARTIALLY_FULFILLED: TopicDefinition = {
  topic: "orders/partially_fulfilled",
  event: "ORDERS_PARTIALLY_FULFILLED",
  label: "Bestellung teilweise versendet",
};

const FULFILLMENTS_CREATE: TopicDefinition = {
  topic: "fulfillments/create",
  event: "FULFILLMENTS_CREATE",
  label: "Einzelne Lieferung erstellt",
  hint: "Feuert je Lieferung. Pro Bestellung entsteht trotzdem nur ein Beleg.",
};

const ORDERS_UPDATED: TopicDefinition = {
  topic: "orders/updated",
  event: "ORDERS_UPDATED",
  label: "Bestellung geaendert",
};

const ORDERS_CANCELLED: TopicDefinition = {
  topic: "orders/cancelled",
  event: "ORDERS_CANCELLED",
  label: "Bestellung storniert",
};

const REFUNDS_CREATE: TopicDefinition = {
  topic: "refunds/create",
  event: "REFUNDS_CREATE",
  label: "Erstattung gebucht",
};

const DRAFT_ORDERS_CREATE: TopicDefinition = {
  topic: "draft_orders/create",
  event: "DRAFT_ORDERS_CREATE",
  label: "Entwurf angelegt",
};

const DRAFT_ORDERS_UPDATE: TopicDefinition = {
  topic: "draft_orders/update",
  event: "DRAFT_ORDERS_UPDATE",
  label: "Entwurf geaendert",
};

const CUSTOMERS_CREATE: TopicDefinition = {
  topic: "customers/create",
  event: "CUSTOMERS_CREATE",
  label: "Kunde angelegt",
};

const CUSTOMERS_UPDATE: TopicDefinition = {
  topic: "customers/update",
  event: "CUSTOMERS_UPDATE",
  label: "Kunde geaendert",
};

export const BUSINESS_CASES: BusinessCaseDefinition[] = [
  {
    key: "invoice_create",
    label: "Rechnung aus Bestellung",
    description:
      "Legt eine Papierkram-Rechnung an. Pro Bestellung entsteht hoechstens ein Beleg, egal wie viele Ausloeser aktiv sind.",
    supportsMode: true,
    topics: [
      ORDERS_CREATE,
      ORDERS_PAID,
      ORDERS_FULFILLED,
      ORDERS_PARTIALLY_FULFILLED,
      FULFILLMENTS_CREATE,
    ],
  },
  {
    key: "estimate_create",
    label: "Angebot aus Bestellentwurf",
    description:
      "Legt ein Papierkram-Angebot an. Abgeschlossene Entwuerfe werden uebersprungen, dafuer gibt es eine Rechnung.",
    supportsMode: true,
    topics: [DRAFT_ORDERS_CREATE, DRAFT_ORDERS_UPDATE],
  },
  {
    key: "customer_sync",
    label: "Kontakt abgleichen",
    description:
      "Legt den Shopify-Kunden als Papierkram-Kontakt an. Unabhaengig davon entsteht der Kontakt ohnehin, sobald ein Beleg erzeugt wird.",
    supportsMode: false,
    topics: [CUSTOMERS_CREATE, CUSTOMERS_UPDATE],
  },
  {
    key: "document_refresh",
    label: "Belegstatus aus Papierkram holen",
    description:
      "Papierkram bietet keine Webhooks. Statusaenderungen wie bezahlt oder storniert erfaehrt die App nur durch Nachfragen.",
    supportsMode: false,
    topics: [ORDERS_UPDATED, ORDERS_PAID, ORDERS_CANCELLED, REFUNDS_CREATE],
  },
  {
    key: "refund_notice",
    label: "Hinweis bei Erstattung",
    description:
      "Die Papierkram-API kennt keine Gutschriften. Statt still etwas Falsches zu buchen, entsteht ein Protokolleintrag mit Belegverweis.",
    supportsMode: false,
    topics: [REFUNDS_CREATE],
  },
  {
    key: "cancel_notice",
    label: "Hinweis bei Stornierung",
    description:
      "Protokolliert, dass zu einer stornierten Bestellung noch eine Rechnung in Papierkram steht.",
    supportsMode: false,
    topics: [ORDERS_CANCELLED],
  },
];

/**
 * Voreinstellung eines frisch installierten Shops.
 *
 * Nichts, was Belege erzeugt, ist von Haus aus aktiv - eine App, die
 * ungefragt Rechnungen schreibt, waere ein unangenehmer Ueberraschungsgast.
 * Die reinen Lese- und Hinweisfaelle sind an.
 */
export const DEFAULT_ENABLED: Array<{
  businessCase: BusinessCase;
  topic: string;
  delaySeconds?: number;
}> = [
  { businessCase: "document_refresh", topic: "orders/updated", delaySeconds: 30 },
  { businessCase: "document_refresh", topic: "orders/cancelled" },
  { businessCase: "document_refresh", topic: "refunds/create", delaySeconds: 30 },
  { businessCase: "refund_notice", topic: "refunds/create" },
  { businessCase: "cancel_notice", topic: "orders/cancelled" },
];

/** Alle Topics, die die App abonnieren muss. */
export function allTopics(): string[] {
  const seen = new Set<string>();
  for (const businessCase of BUSINESS_CASES) {
    for (const topic of businessCase.topics) seen.add(topic.topic);
  }
  return [...seen].sort();
}

const EVENT_TO_TOPIC = new Map<string, string>(
  BUSINESS_CASES.flatMap((businessCase) =>
    businessCase.topics.map((topic) => [topic.event, topic.topic] as const),
  ),
);

/**
 * Uebersetzt die Topic-Schreibweise von authenticate.webhook() (ORDERS_CREATE)
 * in die Shopify-Schreibweise (orders/create). Bewusst als Tabelle statt als
 * Zeichenersetzung: DRAFT_ORDERS_CREATE wuerde sonst falsch aufgeteilt.
 */
export function topicFromEvent(event: string): string | null {
  return EVENT_TO_TOPIC.get(event) ?? null;
}

export function findBusinessCase(key: string): BusinessCaseDefinition | undefined {
  return BUSINESS_CASES.find((businessCase) => businessCase.key === key);
}

/** Prueft, ob die Kombination im Katalog vorgesehen ist. */
export function isKnownPair(businessCase: string, topic: string): boolean {
  const definition = findBusinessCase(businessCase);
  return Boolean(definition?.topics.some((entry) => entry.topic === topic));
}

/** Welche Art von Shopify-Objekt liefert ein Topic? */
export function subjectOf(topic: string): "order" | "draft_order" | "customer" | null {
  if (topic.startsWith("draft_orders/")) return "draft_order";
  if (topic.startsWith("customers/")) return "customer";
  if (topic.startsWith("orders/") || topic.startsWith("fulfillments/")) return "order";
  return null;
}

/**
 * Liest die GID des betroffenen Objekts aus dem Webhook-Rumpf.
 *
 * Die meisten Topics liefern admin_graphql_api_id des Objekts selbst;
 * refunds/create und fulfillments/create beziehen sich dagegen auf eine
 * Bestellung und fuehren nur deren numerische ID.
 */
export function subjectGid(topic: string, payload: unknown): string | null {
  const record = (payload ?? {}) as Record<string, unknown>;

  if (topic === "refunds/create" || topic === "fulfillments/create") {
    const orderId = record.order_id;
    return orderId ? `gid://shopify/Order/${orderId}` : null;
  }

  const gid = record.admin_graphql_api_id;
  return typeof gid === "string" && gid.length > 0 ? gid : null;
}
