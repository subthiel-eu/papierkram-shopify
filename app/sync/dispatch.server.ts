import { activeRulesForTopic, type WebhookRule } from "~/models/rules.server";
import { findLink } from "~/models/links.server";
import { logInfo, logWarning } from "~/models/log.server";
import { getSettings, hasCredentials } from "~/models/settings.server";

import {
  findBusinessCase,
  subjectGid,
  subjectOf,
  type BusinessCase,
  type DocumentMode,
} from "./business-cases";
import { enqueue } from "./queue.server";

export interface DispatchResult {
  /** Warum nichts passiert ist - fuer Protokoll und Tests. */
  skipped?: string;
  /** Welche Geschaeftsfaelle eingeplant wurden. */
  dispatched: BusinessCase[];
}

/**
 * Setzt einen eingehenden Webhook in Jobs um.
 *
 * Welches Topic welchen Geschaeftsfall ausloest, steht in der Regeltabelle des
 * Shops. Die Guards hier sind das, was sich nicht sinnvoll konfigurieren
 * laesst: ein abgeschlossener Entwurf braucht kein Angebot, und ein
 * Statusabgleich ohne verknuepften Beleg waere ein leerer API-Aufruf.
 */
export async function dispatchWebhook(args: {
  shop: string;
  topic: string;
  payload: unknown;
}): Promise<DispatchResult> {
  const { shop, topic, payload } = args;

  const gid = subjectGid(topic, payload);
  if (!gid) return { skipped: "Kein Shopify-Objekt im Webhook-Rumpf.", dispatched: [] };

  const settings = await getSettings(shop);
  if (!hasCredentials(settings)) {
    // Ohne Zugangsdaten waere jeder Job ein garantierter Fehlschlag.
    return { skipped: "Papierkram ist fuer diesen Shop nicht eingerichtet.", dispatched: [] };
  }

  const tags = parseTags(payload);
  if (settings.skipTag && tags.includes(settings.skipTag.toLowerCase())) {
    return { skipped: `Tag "${settings.skipTag}" gesetzt.`, dispatched: [] };
  }

  const rules = await activeRulesForTopic(shop, topic);
  const forced =
    Boolean(settings.forceTag) &&
    tags.includes(settings.forceTag.toLowerCase()) &&
    subjectOf(topic) === "order";

  if (rules.length === 0 && !forced) {
    return { skipped: `Kein Geschaeftsfall auf ${topic} geschaltet.`, dispatched: [] };
  }

  const dispatched: BusinessCase[] = [];

  // Der Erzwingen-Tag ersetzt einen fehlenden Ausloeser, aber keine Regel:
  // ist "Rechnung aus Bestellung" bereits geschaltet, greift die echte Regel.
  if (forced && !rules.some((rule) => rule.businessCase === "invoice_create")) {
    const handled = await applyRule({
      shop,
      topic,
      payload,
      gid,
      rule: {
        businessCase: "invoice_create",
        topic,
        enabled: true,
        delaySeconds: 0,
        mode: null,
      } as WebhookRule,
      businessCase: "invoice_create",
    });
    if (handled) dispatched.push("invoice_create");
  }

  for (const rule of rules) {
    const businessCase = rule.businessCase as BusinessCase;
    if (!findBusinessCase(businessCase)) continue;

    const handled = await applyRule({ shop, topic, payload, gid, rule, businessCase });
    if (handled) dispatched.push(businessCase);
  }

  return { dispatched };
}

async function applyRule(args: {
  shop: string;
  topic: string;
  payload: unknown;
  gid: string;
  rule: WebhookRule;
  businessCase: BusinessCase;
}): Promise<boolean> {
  const { shop, topic, payload, gid, rule, businessCase } = args;
  const record = (payload ?? {}) as Record<string, unknown>;
  const label = typeof record.name === "string" ? record.name : gid;

  switch (businessCase) {
    case "invoice_create": {
      // Ein bestehender Beleg macht jeden weiteren Ausloeser gegenstandslos.
      if (await findLink(shop, "invoice", gid)) return false;

      await enqueue({
        shop,
        type: "order_invoice",
        payload: { orderGid: gid, mode: modeOf(rule) },
        // Ein Schluessel je Bestellung: mehrere aktive Ausloeser erzeugen
        // trotzdem nur einen Beleg.
        dedupeKey: `invoice:${gid}`,
        delaySeconds: rule.delaySeconds,
      });
      await logInfo(
        shop,
        "order.queued",
        `Bestellung ${label} zur Rechnungserstellung eingeplant (Ausloeser: ${topic}).`,
      );
      return true;
    }

    case "estimate_create": {
      // Abgeschlossene Entwuerfe sind bereits Bestellungen - dafuer gibt es
      // eine Rechnung, kein Angebot.
      const status = typeof record.status === "string" ? record.status.toLowerCase() : null;
      if (record.order_id || status === "completed") return false;
      if (await findLink(shop, "estimate", gid)) return false;

      await enqueue({
        shop,
        type: "draft_order_estimate",
        payload: { draftOrderGid: gid, mode: modeOf(rule) },
        dedupeKey: `estimate:${gid}`,
        delaySeconds: rule.delaySeconds,
      });
      return true;
    }

    case "customer_sync": {
      await enqueue({
        shop,
        type: "customer_upsert",
        payload: { customerGid: gid },
        dedupeKey: `customer:${gid}`,
        delaySeconds: rule.delaySeconds,
      });
      return true;
    }

    case "document_refresh": {
      const kind = (await findLink(shop, "invoice", gid))
        ? "invoice"
        : (await findLink(shop, "estimate", gid))
          ? "estimate"
          : null;
      if (!kind) return false;

      await enqueue({
        shop,
        type: "refresh_document",
        payload: { kind, shopifyGid: gid },
        dedupeKey: `refresh:${kind}:${gid}`,
        delaySeconds: rule.delaySeconds,
      });
      return true;
    }

    case "refund_notice": {
      const link = await findLink(shop, "invoice", gid);
      if (!link) return false;

      const amount =
        (record.transactions as Array<{ amount?: string }> | undefined)?.reduce(
          (sum, transaction) => sum + Number(transaction.amount ?? 0),
          0,
        ) ?? 0;

      await logWarning(
        shop,
        "refund.received",
        `Erstattung ueber ${amount.toFixed(2)} zu Bestellung ${link.shopifyLabel ?? gid}. ` +
          `Bitte die Rechnung ${link.documentNo ?? `#${link.papierkramId}`} in Papierkram ` +
          `stornieren oder eine Gutschrift anlegen.`,
        { url: link.url, amount },
      );
      return true;
    }

    case "cancel_notice": {
      const link = await findLink(shop, "invoice", gid);
      if (!link) return false;

      await logWarning(
        shop,
        "order.cancelled",
        `Bestellung ${link.shopifyLabel ?? label} wurde storniert. Die Papierkram-Rechnung ` +
          `${link.documentNo ?? `#${link.papierkramId}`} bleibt bestehen - bitte dort ` +
          `stornieren, falls gewuenscht.`,
        { url: link.url },
      );
      return true;
    }

    default:
      return false;
  }
}

/**
 * Tags aus dem Webhook-Rumpf. Shopify liefert sie als kommagetrennte Liste,
 * damit ist kein zusaetzlicher API-Aufruf noetig.
 */
function parseTags(payload: unknown): string[] {
  const raw = (payload as { tags?: unknown } | null)?.tags;
  if (typeof raw === "string") {
    return raw.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  }
  if (Array.isArray(raw)) {
    return raw.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean);
  }
  return [];
}

/** Regel-Modus, sonst die Voreinstellung des Shops (im Worker aufgeloest). */
function modeOf(rule: WebhookRule): DocumentMode | undefined {
  const mode = rule.mode;
  return mode === "draft" || mode === "pdf" || mode === "email" ? mode : undefined;
}
