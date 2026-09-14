import { beforeEach, describe, expect, it } from "vitest";

import prisma from "~/db.server";
import { setApiToken, updateSettings } from "~/models/settings.server";
import {
  enqueue,
  jobCounts,
  processDueJobs,
  recoverStaleJobs,
  retryJob,
} from "~/sync/queue.server";

const SHOP = "queue-test.myshopify.com";

async function reset() {
  await prisma.syncJob.deleteMany({ where: { shop: SHOP } });
  await prisma.logEntry.deleteMany({ where: { shop: SHOP } });
  await prisma.shopSettings.deleteMany({ where: { shop: SHOP } });
}

const job = () => prisma.syncJob.findFirst({ where: { shop: SHOP } });

beforeEach(async () => {
  await reset();
});

describe("enqueue", () => {
  it("legt einen Job an", async () => {
    await enqueue({ shop: SHOP, type: "order_invoice", payload: { orderGid: "gid://x/1" } });
    expect(await prisma.syncJob.count({ where: { shop: SHOP } })).toBe(1);
  });

  it("fasst gleiche Anlaesse ueber den Schluessel zusammen", async () => {
    for (let i = 0; i < 3; i++) {
      await enqueue({
        shop: SHOP,
        type: "order_invoice",
        payload: { orderGid: "gid://x/1" },
        dedupeKey: "invoice:gid://x/1",
      });
    }
    expect(await prisma.syncJob.count({ where: { shop: SHOP } })).toBe(1);
  });

  it("legt nach Abschluss auf denselben Schluessel wieder an", async () => {
    await enqueue({
      shop: SHOP,
      type: "refresh_document",
      payload: { kind: "invoice", shopifyGid: "gid://x/1" },
      dedupeKey: "refresh:gid://x/1",
    });
    await prisma.syncJob.updateMany({ where: { shop: SHOP }, data: { status: "done" } });

    await enqueue({
      shop: SHOP,
      type: "refresh_document",
      payload: { kind: "invoice", shopifyGid: "gid://x/1" },
      dedupeKey: "refresh:gid://x/1",
    });

    // Derselbe Datensatz, aber wieder offen - sonst wuerde die Tabelle wachsen.
    expect(await prisma.syncJob.count({ where: { shop: SHOP } })).toBe(1);
    expect((await job())!.status).toBe("pending");
  });

  it("beruecksichtigt eine Verzoegerung", async () => {
    const before = Date.now();
    await enqueue({
      shop: SHOP,
      type: "customer_upsert",
      payload: { customerGid: "gid://x/1" },
      delaySeconds: 90,
    });
    expect((await job())!.runAfter.getTime()).toBeGreaterThanOrEqual(before + 89_000);
  });
});

describe("processDueJobs", () => {
  it("laesst noch nicht faellige Jobs liegen", async () => {
    await enqueue({
      shop: SHOP,
      type: "order_invoice",
      payload: { orderGid: "gid://x/1" },
      delaySeconds: 600,
    });
    expect(await processDueJobs()).toBe(0);
    expect((await job())!.status).toBe("pending");
  });

  it("gibt bei fehlenden Zugangsdaten sofort auf", async () => {
    await enqueue({ shop: SHOP, type: "order_invoice", payload: { orderGid: "gid://x/1" } });

    await processDueJobs();

    const done = await job();
    // Ohne Token behebt sich nichts durch Wiederholen.
    expect(done!.status).toBe("failed");
    expect(done!.attempts).toBe(1);
    expect(done!.lastError).toMatch(/Zugangsdaten|eingerichtet/i);
  });

  it("wiederholt unbekannte Fehler mit wachsendem Abstand", async () => {
    await updateSettings(SHOP, { subdomain: "demo" });
    await setApiToken(SHOP, "token");
    await enqueue({ shop: SHOP, type: "order_invoice", payload: { orderGid: "gid://x/1" } });

    const before = Date.now();
    await processDueJobs();

    const retried = await job();
    // Es gibt keine Shopify-Sitzung, also scheitert der Job - aber
    // wiederholbar, damit ein Aussetzer keinen Beleg kostet.
    expect(retried!.status).toBe("pending");
    expect(retried!.attempts).toBe(1);
    expect(retried!.runAfter.getTime()).toBeGreaterThan(before);
    expect(retried!.startedAt).toBeNull();
  });

  it("gibt nach der letzten erlaubten Wiederholung auf", async () => {
    await updateSettings(SHOP, { subdomain: "demo" });
    await setApiToken(SHOP, "token");
    await enqueue({
      shop: SHOP,
      type: "order_invoice",
      payload: { orderGid: "gid://x/1" },
      maxAttempts: 1,
    });

    await processDueJobs();

    expect((await job())!.status).toBe("failed");
  });

  it("pausiert, wenn das Papierkram-Kontingent aufgebraucht ist", async () => {
    await updateSettings(SHOP, { subdomain: "demo", remainingQuota: 0 });
    await setApiToken(SHOP, "token");
    await enqueue({ shop: SHOP, type: "order_invoice", payload: { orderGid: "gid://x/1" } });

    const before = Date.now();
    await processDueJobs();

    const postponed = await job();
    expect(postponed!.status).toBe("pending");
    // Kein verbrauchter Versuch - sonst waere die Warteschlange nach fuenf
    // Durchlaeufen leer, ohne dass je etwas versucht wurde.
    expect(postponed!.attempts).toBe(0);
    expect(postponed!.runAfter.getTime()).toBeGreaterThan(before + 3_600_000);

    const warning = await prisma.logEntry.findFirst({ where: { shop: SHOP, level: "warning" } });
    expect(warning?.message).toMatch(/kontingent/i);
  });

  it("arbeitet weiter, solange genug Kontingent da ist", async () => {
    await updateSettings(SHOP, { subdomain: "demo", remainingQuota: 5000 });
    await setApiToken(SHOP, "token");
    await enqueue({ shop: SHOP, type: "order_invoice", payload: { orderGid: "gid://x/1" } });

    await processDueJobs();
    expect((await job())!.attempts).toBe(1);
  });
});

describe("recoverStaleJobs", () => {
  it("holt abgebrochene Vorgaenge zurueck in die Warteschlange", async () => {
    await enqueue({ shop: SHOP, type: "order_invoice", payload: { orderGid: "gid://x/1" } });
    // So sieht ein Job aus, dessen Prozess mittendrin gestorben ist.
    await prisma.syncJob.updateMany({
      where: { shop: SHOP },
      data: {
        status: "running",
        attempts: 1,
        startedAt: new Date(Date.now() - 60 * 60_000),
      },
    });

    expect(await recoverStaleJobs()).toBe(1);

    const recovered = await job();
    expect(recovered!.status).toBe("pending");
    expect(recovered!.startedAt).toBeNull();
  });

  it("laesst frisch gestartete Vorgaenge in Ruhe", async () => {
    await enqueue({ shop: SHOP, type: "order_invoice", payload: { orderGid: "gid://x/1" } });
    await prisma.syncJob.updateMany({
      where: { shop: SHOP },
      data: { status: "running", startedAt: new Date() },
    });

    expect(await recoverStaleJobs()).toBe(0);
    expect((await job())!.status).toBe("running");
  });

  it("gibt auf, wenn das Versuchsbudget erschoepft ist", async () => {
    await enqueue({
      shop: SHOP,
      type: "order_invoice",
      payload: { orderGid: "gid://x/1" },
      maxAttempts: 2,
    });
    await prisma.syncJob.updateMany({
      where: { shop: SHOP },
      data: {
        status: "running",
        attempts: 2,
        startedAt: new Date(Date.now() - 60 * 60_000),
      },
    });

    await recoverStaleJobs();

    const failed = await job();
    expect(failed!.status).toBe("failed");
    expect(failed!.lastError).toMatch(/unterbrochen/i);
  });
});

describe("retryJob", () => {
  it("setzt einen gescheiterten Vorgang zurueck", async () => {
    await enqueue({ shop: SHOP, type: "order_invoice", payload: { orderGid: "gid://x/1" } });
    await prisma.syncJob.updateMany({
      where: { shop: SHOP },
      data: { status: "failed", attempts: 5, lastError: "kaputt" },
    });

    await retryJob(SHOP, (await job())!.id);

    const reset = await job();
    expect(reset!.status).toBe("pending");
    expect(reset!.attempts).toBe(0);
    expect(reset!.lastError).toBeNull();
  });

  it("zaehlt die Zustaende fuer die Uebersicht", async () => {
    await enqueue({ shop: SHOP, type: "order_invoice", payload: { orderGid: "gid://a/1" } });
    await enqueue({ shop: SHOP, type: "customer_upsert", payload: { customerGid: "gid://b/1" } });
    const counts = await jobCounts(SHOP);
    expect(counts.pending).toBe(2);
    expect(counts.failed).toBe(0);
  });
});
