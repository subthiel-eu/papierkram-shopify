import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";

import prisma from "~/db.server";
import { buildClient, getSettings, hasCredentials } from "~/models/settings.server";
import type { Proposition } from "~/papierkram/types";
import { authenticate } from "~/shopify.server";
import { runGraphql } from "~/sync/admin-client";
import { PRODUCT_VARIANTS_QUERY } from "~/sync/queries";
import { describeError } from "~/sync/service.server";

interface VariantNode {
  id: string;
  title: string | null;
  sku: string | null;
  displayName: string;
  price: string;
  product: { id: string; title: string };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const search = new URL(request.url).searchParams.get("q") ?? "";

  const settings = await getSettings(shop);

  let propositions: Proposition[] = [];
  let loadError: string | null = null;
  if (hasCredentials(settings)) {
    try {
      const client = buildClient(settings);
      propositions = await client.listAll<Proposition>(
        (params) => client.listPropositions(params),
        { maxPages: 5 },
      );
    } catch (error) {
      loadError = describeError(error);
    }
  }

  const variantData = await runGraphql<{
    productVariants: { nodes: VariantNode[] };
  }>(admin, PRODUCT_VARIANTS_QUERY, {
    first: 50,
    query: search || null,
  });

  const mappings = await prisma.propositionMapping.findMany({ where: { shop } });
  const byGid = new Map(mappings.map((row) => [row.shopifyGid, row.propositionId]));

  return json({
    search,
    loadError,
    configured: hasCredentials(settings),
    propositions: propositions.map((proposition) => ({
      id: proposition.id,
      name: proposition.name,
      articleNo: proposition.article_no,
    })),
    variants: variantData.productVariants.nodes.map((variant) => ({
      id: variant.id,
      displayName: variant.displayName,
      sku: variant.sku,
      price: variant.price,
      propositionId: byGid.get(variant.id) ?? null,
    })),
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();

  const shopifyGid = String(form.get("shopifyGid") ?? "");
  const label = String(form.get("label") ?? "");
  const raw = String(form.get("propositionId") ?? "").trim();

  if (!shopifyGid) {
    return json({ ok: false, message: "Keine Variante angegeben." }, { status: 400 });
  }

  try {
    if (raw === "") {
      await prisma.propositionMapping.deleteMany({ where: { shop, shopifyGid } });
      return json({ ok: true, message: "Zuordnung entfernt." });
    }

    const propositionId = Number(raw);
    if (!Number.isFinite(propositionId)) {
      return json({ ok: false, message: "Ungueltige Position." }, { status: 400 });
    }

    await prisma.propositionMapping.upsert({
      where: { shop_shopifyGid: { shop, shopifyGid } },
      create: { shop, shopifyGid, shopifyLabel: label, propositionId },
      update: { shopifyLabel: label, propositionId },
    });
    return json({ ok: true, message: "Zuordnung gespeichert." });
  } catch (error) {
    return json({ ok: false, message: describeError(error) }, { status: 400 });
  }
}

export default function Propositions() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <s-page heading="Positionen zuordnen">
      {actionData ? (
        <s-banner tone={actionData.ok ? "success" : "critical"}>
          <s-paragraph>{actionData.message}</s-paragraph>
        </s-banner>
      ) : null}

      {data.loadError ? (
        <s-banner tone="warning" heading="Papierkram-Positionen nicht geladen">
          <s-paragraph>{data.loadError}</s-paragraph>
        </s-banner>
      ) : null}

      <s-section heading="Wofuer ist das?">
        <s-paragraph>
          Ohne Zuordnung uebernimmt die App Name, Preis und Steuersatz direkt aus
          der Bestellung. Ist eine Shopify-Variante hier mit einer
          Papierkram-Position verknuepft, erscheint der Beleg stattdessen mit der
          hinterlegten Artikelnummer aus Papierkram.
        </s-paragraph>
      </s-section>

      <s-section heading="Varianten">
        <Form method="get">
          <s-stack direction="inline" gap="base" alignItems="end">
            <s-text-field
              label="Suche"
              name="q"
              value={data.search}
              placeholder="Produktname oder SKU"
            />
            <s-button type="submit">Suchen</s-button>
          </s-stack>
        </Form>

        <s-divider />

        {data.variants.length === 0 ? (
          <s-paragraph>Keine Varianten gefunden.</s-paragraph>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header>Variante</s-table-header>
              <s-table-header>SKU</s-table-header>
              <s-table-header>Papierkram-Position</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.variants.map((variant) => (
                <s-table-row key={variant.id}>
                  <s-table-cell>{variant.displayName}</s-table-cell>
                  <s-table-cell>{variant.sku ?? "-"}</s-table-cell>
                  <s-table-cell>
                    <Form method="post">
                      <input type="hidden" name="shopifyGid" value={variant.id} />
                      <input type="hidden" name="label" value={variant.displayName} />
                      <s-stack direction="inline" gap="small" alignItems="end">
                        <s-select
                          label="Position"
                          labelAccessibilityVisibility="exclusive"
                          name="propositionId"
                          value={variant.propositionId ? String(variant.propositionId) : ""}
                        >
                          <s-option value="">Aus Bestellung uebernehmen</s-option>
                          {data.propositions.map((proposition) => (
                            <s-option key={proposition.id} value={String(proposition.id)}>
                              {proposition.articleNo
                                ? `${proposition.articleNo} - ${proposition.name}`
                                : proposition.name}
                            </s-option>
                          ))}
                        </s-select>
                        <s-button type="submit" variant="tertiary" loading={busy}>
                          Speichern
                        </s-button>
                      </s-stack>
                    </Form>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
