import type { DocumentLink } from "@prisma/client";

import prisma from "~/db.server";

export type DocumentKind = "invoice" | "estimate" | "company";
export type { DocumentLink };

/** Legt die Verknuepfung Shopify-Objekt <-> Papierkram-Beleg an oder aktualisiert sie. */
export async function upsertLink(args: {
  shop: string;
  kind: DocumentKind;
  shopifyGid: string;
  papierkramId: number;
  shopifyLabel?: string | null;
  documentNo?: string | null;
  state?: string | null;
  totalGross?: number | null;
  currency?: string | null;
  url?: string | null;
  metafieldsHash?: string | null;
}): Promise<DocumentLink> {
  const { shop, kind, shopifyGid, ...rest } = args;
  return prisma.documentLink.upsert({
    where: { shop_kind_shopifyGid: { shop, kind, shopifyGid } },
    create: { shop, kind, shopifyGid, ...rest },
    update: rest,
  });
}

/** Zustand einer Verknuepfung, solange der Beleg noch angelegt wird. */
export const RESERVED_STATE = "creating";

/**
 * Fehler, wenn zu demselben Objekt bereits ein Beleg entsteht.
 *
 * Ohne Reservierung koennten ein Webhook-Job und ein Klick in der Bestellung
 * gleichzeitig durch die Pruefung laufen und zwei Belege in Papierkram
 * anlegen - von denen nur einer verknuepft bliebe.
 */
export class LinkInProgressError extends Error {
  constructor(kind: DocumentKind) {
    super(
      kind === "estimate"
        ? "Zu diesem Entwurf wird gerade ein Angebot angelegt. Bitte einen Moment warten."
        : "Zu dieser Bestellung wird gerade eine Rechnung angelegt. Bitte einen Moment warten.",
    );
    this.name = "LinkInProgressError";
  }
}

/**
 * Reserviert die Verknuepfung, bevor Papierkram aufgerufen wird.
 *
 * Der Unique-Index auf (shop, kind, shopifyGid) ist der eigentliche
 * Wechselschutz: der zweite Versuch scheitert beim Einfuegen.
 */
export async function reserveLink(args: {
  shop: string;
  kind: DocumentKind;
  shopifyGid: string;
  shopifyLabel?: string | null;
}): Promise<void> {
  try {
    await prisma.documentLink.create({
      data: {
        shop: args.shop,
        kind: args.kind,
        shopifyGid: args.shopifyGid,
        shopifyLabel: args.shopifyLabel ?? null,
        // 0 ist keine gueltige Papierkram-ID und markiert die Reservierung.
        papierkramId: 0,
        state: RESERVED_STATE,
      },
    });
  } catch {
    throw new LinkInProgressError(args.kind);
  }
}

/** Gibt eine Reservierung frei, wenn der Beleg nicht zustande kam. */
export async function releaseReservation(
  shop: string,
  kind: DocumentKind,
  shopifyGid: string,
): Promise<void> {
  await prisma.documentLink.deleteMany({
    where: { shop, kind, shopifyGid, state: RESERVED_STATE, papierkramId: 0 },
  });
}

export async function findLink(
  shop: string,
  kind: DocumentKind,
  shopifyGid: string,
): Promise<DocumentLink | null> {
  return prisma.documentLink.findUnique({
    where: { shop_kind_shopifyGid: { shop, kind, shopifyGid } },
  });
}

/** Alle Belege zu einem Shopify-Objekt (Bestellung, Entwurf, Kunde). */
export async function linksForShopifyObject(
  shop: string,
  shopifyGid: string,
): Promise<DocumentLink[]> {
  return prisma.documentLink.findMany({
    where: { shop, shopifyGid },
    orderBy: { createdAt: "desc" },
  });
}

export async function listLinks(
  shop: string,
  options: { kind?: DocumentKind; limit?: number; offset?: number } = {},
) {
  const where = { shop, ...(options.kind ? { kind: options.kind } : {}) };
  const [items, total] = await Promise.all([
    prisma.documentLink.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: options.limit ?? 50,
      skip: options.offset ?? 0,
    }),
    prisma.documentLink.count({ where }),
  ]);
  return { items, total };
}

export async function deleteLink(shop: string, id: string) {
  await prisma.documentLink.deleteMany({ where: { shop, id } });
}

/** Zuordnung Shopify-Variante/Produkt -> Papierkram-Position. */
export async function propositionMap(shop: string): Promise<Map<string, number>> {
  const rows = await prisma.propositionMapping.findMany({ where: { shop } });
  return new Map(rows.map((row) => [row.shopifyGid, row.propositionId]));
}
