import { describe, expect, it } from "vitest";

import { resolveAutomaticDelivery } from "~/sync/service.server";

describe("resolveAutomaticDelivery", () => {
  it("laesst Entwuerfe unangetastet", () => {
    expect(
      resolveAutomaticDelivery("draft", { recipient: "kunde@example.com", documentNo: "RE-1" }),
    ).toBeNull();
  });

  it("schreibt im Modus pdf nur fest", () => {
    expect(
      resolveAutomaticDelivery("pdf", { recipient: "kunde@example.com", documentNo: "RE-1" }),
    ).toEqual({ send_via: "pdf" });
  });

  it("versendet im Modus email an die Bestelladresse", () => {
    const delivery = resolveAutomaticDelivery("email", {
      recipient: "kunde@example.com",
      documentNo: "RE-1",
    });
    expect(delivery).toMatchObject({
      send_via: "email",
      email: { recipient: "kunde@example.com", subject: "Ihre Rechnung RE-1" },
    });
  });

  it("faellt ohne Empfaenger auf Festschreiben zurueck und meldet den Grund", () => {
    const reasons: string[] = [];
    const delivery = resolveAutomaticDelivery("email", {
      recipient: null,
      documentNo: "RE-1",
      onFallback: (reason) => reasons.push(reason),
    });
    expect(delivery).toEqual({ send_via: "pdf" });
    expect(reasons.join(" ")).toContain("keine E-Mail-Adresse");
  });

  it("behandelt unbekannte Werte wie Entwurf", () => {
    expect(
      resolveAutomaticDelivery("irgendwas", { recipient: "a@b.de", documentNo: null }),
    ).toBeNull();
  });
});
