import { describe, expect, it, vi } from "vitest";

import {
  ShopifyAuthError,
  ShopifyGraphqlError,
  ShopifyThrottledError,
  runGraphql,
} from "~/sync/admin-client";

const noSleep = () => Promise.resolve();

type GraphqlArgs = [query: string, options?: { variables?: Record<string, unknown> }];

function admin(responses: Array<() => Response>) {
  let call = 0;
  const graphql = vi.fn(async (..._args: GraphqlArgs) =>
    responses[Math.min(call++, responses.length - 1)](),
  );
  return { client: { graphql }, graphql };
}

const ok = (data: unknown) =>
  new Response(JSON.stringify({ data }), { status: 200 });

const throttled = () =>
  new Response(
    JSON.stringify({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }),
    { status: 200 },
  );

describe("runGraphql", () => {
  it("gibt die Daten zurueck", async () => {
    const { client } = admin([() => ok({ shop: { name: "Demo" } })]);
    const data = await runGraphql<{ shop: { name: string } }>(client, "query {}", undefined, {
      sleep: noSleep,
    });
    expect(data.shop.name).toBe("Demo");
  });

  it("reicht Variablen durch", async () => {
    const { client, graphql } = admin([() => ok({ order: null })]);
    await runGraphql(client, "query {}", { id: "gid://x/1" }, { sleep: noSleep });
    expect(graphql.mock.calls[0][1]).toEqual({ variables: { id: "gid://x/1" } });
  });

  it("wiederholt bei Drosselung und liefert danach das Ergebnis", async () => {
    const { client, graphql } = admin([throttled, () => ok({ order: { id: "1" } })]);
    const data = await runGraphql<{ order: { id: string } }>(client, "query {}", undefined, {
      sleep: noSleep,
    });
    expect(data.order.id).toBe("1");
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it("wiederholt auch bei HTTP 429", async () => {
    const { client, graphql } = admin([
      () => new Response("", { status: 429 }),
      () => ok({ order: { id: "1" } }),
    ]);
    await runGraphql(client, "query {}", undefined, { sleep: noSleep });
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it("gibt bei dauerhafter Drosselung auf", async () => {
    const { client, graphql } = admin([throttled]);
    await expect(
      runGraphql(client, "query {}", undefined, { sleep: noSleep }),
    ).rejects.toThrow(ShopifyThrottledError);
    expect(graphql).toHaveBeenCalledTimes(4);
  });

  it("behandelt entzogene Berechtigung als dauerhaften Fehler", async () => {
    const { client, graphql } = admin([() => new Response("", { status: 401 })]);
    await expect(
      runGraphql(client, "query {}", undefined, { sleep: noSleep }),
    ).rejects.toThrow(ShopifyAuthError);
    // Wiederholen waere hier reine Zeitverschwendung.
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("wiederholt fachliche Fehler nicht", async () => {
    const { client, graphql } = admin([
      () =>
        new Response(JSON.stringify({ errors: [{ message: "Field nope doesn't exist" }] }), {
          status: 200,
        }),
    ]);
    await expect(
      runGraphql(client, "query {}", undefined, { sleep: noSleep }),
    ).rejects.toThrow(ShopifyGraphqlError);
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("meldet eine Antwort ohne Daten", async () => {
    const { client } = admin([() => new Response(JSON.stringify({}), { status: 200 })]);
    await expect(
      runGraphql(client, "query {}", undefined, { sleep: noSleep }),
    ).rejects.toThrow(/keine Daten/);
  });
});
