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
}): Promise<DocumentLink> {
  const { shop, kind, shopifyGid, ...rest } = args;
  return prisma.documentLink.upsert({
    where: { shop_kind_shopifyGid: { shop, kind, shopifyGid } },
    create: { shop, kind, shopifyGid, ...rest },
    update: rest,
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
