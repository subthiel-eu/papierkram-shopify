import type { WebhookRule } from "@prisma/client";

import prisma from "~/db.server";
import {
  BUSINESS_CASES,
  DEFAULT_ENABLED,
  isKnownPair,
  type BusinessCase,
  type DocumentMode,
} from "~/sync/business-cases";

export type { WebhookRule };

/**
 * Liefert alle Regeln eines Shops und legt beim ersten Zugriff die
 * Voreinstellung an. So ist die Tabelle immer vollstaendig und die
 * Oberflaeche muss keine fehlenden Kombinationen behandeln.
 */
export async function getRules(shop: string): Promise<WebhookRule[]> {
  const existing = await prisma.webhookRule.findMany({ where: { shop } });

  const missing: Array<{
    businessCase: string;
    topic: string;
    enabled: boolean;
    delaySeconds: number;
  }> = [];

  const known = new Set(existing.map((rule) => `${rule.businessCase}|${rule.topic}`));

  for (const businessCase of BUSINESS_CASES) {
    for (const topic of businessCase.topics) {
      if (known.has(`${businessCase.key}|${topic.topic}`)) continue;
      const preset = DEFAULT_ENABLED.find(
        (entry) => entry.businessCase === businessCase.key && entry.topic === topic.topic,
      );
      missing.push({
        businessCase: businessCase.key,
        topic: topic.topic,
        enabled: Boolean(preset),
        delaySeconds: preset?.delaySeconds ?? 0,
      });
    }
  }

  if (missing.length === 0) return existing;

  // Upsert statt createMany: SQLite unterstuetzt skipDuplicates nicht, und
  // zwei gleichzeitige Requests sollen sich nicht gegenseitig mit einem
  // Unique-Fehler abschiessen.
  for (const rule of missing) {
    await prisma.webhookRule.upsert({
      where: {
        shop_businessCase_topic: {
          shop,
          businessCase: rule.businessCase,
          topic: rule.topic,
        },
      },
      create: { shop, ...rule },
      update: {},
    });
  }

  return prisma.webhookRule.findMany({ where: { shop } });
}

/** Aktive Regeln zu einem eingehenden Topic. */
export async function activeRulesForTopic(
  shop: string,
  topic: string,
): Promise<WebhookRule[]> {
  await getRules(shop);
  return prisma.webhookRule.findMany({
    where: { shop, topic, enabled: true },
  });
}

export interface RuleUpdate {
  businessCase: BusinessCase | string;
  topic: string;
  enabled: boolean;
  delaySeconds?: number;
  mode?: DocumentMode | null;
}

/** Schreibt die in der Oberflaeche gesetzten Regeln zurueck. */
export async function saveRules(shop: string, updates: RuleUpdate[]) {
  const valid = updates.filter((update) => isKnownPair(update.businessCase, update.topic));

  for (const update of valid) {
    const data = {
      enabled: update.enabled,
      delaySeconds: clampDelay(update.delaySeconds),
      mode: update.mode ?? null,
    };
    await prisma.webhookRule.upsert({
      where: {
        shop_businessCase_topic: {
          shop,
          businessCase: update.businessCase,
          topic: update.topic,
        },
      },
      create: { shop, businessCase: update.businessCase, topic: update.topic, ...data },
      update: data,
    });
  }

  return valid.length;
}

/** Zwischen 0 und 24 Stunden; alles andere ist mit Sicherheit ein Tippfehler. */
function clampDelay(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.round(value as number), 0), 86_400);
}

/** Ist fuer einen Geschaeftsfall ueberhaupt ein Ausloeser aktiv? */
export function hasActiveTrigger(rules: WebhookRule[], businessCase: BusinessCase): boolean {
  return rules.some((rule) => rule.businessCase === businessCase && rule.enabled);
}

/** Lesbare Zusammenfassung der aktiven Ausloeser, z.B. fuer die Uebersicht. */
export function summarizeTriggers(
  rules: WebhookRule[],
  businessCase: BusinessCase,
): string[] {
  return rules
    .filter((rule) => rule.businessCase === businessCase && rule.enabled)
    .map((rule) => rule.topic)
    .sort();
}
