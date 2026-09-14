import { describe, expect, it } from "vitest";

import {
  findVatId,
  isEuCountry,
  normalizeVatId,
  resolveTaxCase,
  taxCaseLabel,
} from "~/sync/tax-cases";

const settings = {
  taxScheme: "standard",
  reverseChargeEnabled: true,
  reverseChargeNote: "Reverse Charge.",
  kleinunternehmerNote: "§ 19 UStG.",
  vatIdSource: "auto",
  vatIdKey: "vat_id",
};

const emptyOrder = {
  customAttributes: null,
  metafield: null,
  purchasingEntity: null,
  customer: null,
};

describe("normalizeVatId", () => {
  it("raeumt Schreibweisen auf", () => {
    expect(normalizeVatId(" de 123 456 789 ")).toBe("DE123456789");
    expect(normalizeVatId("ATU-1234567")).toBe("ATU1234567");
  });

  it("weist offensichtlich Falsches ab", () => {
    expect(normalizeVatId("12345")).toBeNull();
    expect(normalizeVatId("keine Nummer")).toBeNull();
    expect(normalizeVatId("")).toBeNull();
    expect(normalizeVatId(null)).toBeNull();
  });
});

describe("isEuCountry", () => {
  it("kennt Mitglieds- und Drittstaaten", () => {
    expect(isEuCountry("DE")).toBe(true);
    expect(isEuCountry("at")).toBe(true);
    expect(isEuCountry("CH")).toBe(false);
    expect(isEuCountry("GB")).toBe(false);
    expect(isEuCountry(null)).toBe(false);
  });
});

describe("findVatId", () => {
  it("liest das Bestellattribut aus dem Checkout", () => {
    expect(
      findVatId(
        { ...emptyOrder, customAttributes: [{ key: "vat_id", value: "ATU12345678" }] },
        settings,
      ),
    ).toBe("ATU12345678");
  });

  it("findet das Attribut auch bei abweichender Schreibweise", () => {
    expect(
      findVatId(
        { ...emptyOrder, customAttributes: [{ key: " VAT_ID ", value: "ATU12345678" }] },
        settings,
      ),
    ).toBe("ATU12345678");
  });

  it("nimmt das Metafeld der Bestellung", () => {
    expect(findVatId({ ...emptyOrder, metafield: { value: "FR12345678901" } }, settings)).toBe(
      "FR12345678901",
    );
  });

  it("faellt auf das Metafeld des Kunden zurueck", () => {
    expect(
      findVatId(
        {
          ...emptyOrder,
          customer: { metafield: { value: "NL123456789B01" } } as never,
        },
        settings,
      ),
    ).toBe("NL123456789B01");
  });

  it("nutzt bei B2B die Kennung des Unternehmens", () => {
    expect(
      findVatId(
        {
          ...emptyOrder,
          purchasingEntity: { company: { id: "1", name: "ACME", externalId: "BE0123456789" } },
        },
        settings,
      ),
    ).toBe("BE0123456789");
  });

  it("sucht bei fester Quelle nur dort", () => {
    expect(
      findVatId(
        { ...emptyOrder, metafield: { value: "FR12345678901" } },
        { ...settings, vatIdSource: "order_attribute" },
      ),
    ).toBeNull();
  });

  it("laesst sich abschalten", () => {
    expect(
      findVatId(
        { ...emptyOrder, metafield: { value: "FR12345678901" } },
        { ...settings, vatIdSource: "none" },
      ),
    ).toBeNull();
  });

  it("uebernimmt keinen Muell aus einem Freitextfeld", () => {
    expect(
      findVatId(
        { ...emptyOrder, customAttributes: [{ key: "vat_id", value: "weiss nicht" }] },
        settings,
      ),
    ).toBeNull();
  });
});

describe("resolveTaxCase", () => {
  const base = {
    settings,
    homeCountry: "DE",
    orderHasTax: true,
    order: emptyOrder,
  };

  it("bleibt im Inland bei der Regelbesteuerung", () => {
    const result = resolveTaxCase({ ...base, destination: { countryCodeV2: "DE" } });
    expect(result.taxCase).toBe("standard");
    expect(result.zeroRated).toBe(false);
    expect(result.note).toBe("");
  });

  it("erkennt die innergemeinschaftliche B2B-Lieferung", () => {
    const result = resolveTaxCase({
      ...base,
      destination: { countryCodeV2: "AT" },
      order: { ...emptyOrder, metafield: { value: "ATU12345678" } },
    });
    expect(result.taxCase).toBe("reverse_charge");
    expect(result.zeroRated).toBe(true);
    expect(result.note).toContain("Reverse Charge");
    expect(result.vatId).toBe("ATU12345678");
  });

  it("bleibt ohne USt-IdNr. bei der Regelbesteuerung", () => {
    // Privatkunde in Oesterreich: Versandhandel, keine Steuerbefreiung.
    const result = resolveTaxCase({ ...base, destination: { countryCodeV2: "AT" } });
    expect(result.taxCase).toBe("standard");
  });

  it("wendet Reverse Charge nicht im Inland an", () => {
    const result = resolveTaxCase({
      ...base,
      destination: { countryCodeV2: "DE" },
      order: { ...emptyOrder, metafield: { value: "DE123456789" } },
    });
    expect(result.taxCase).toBe("standard");
  });

  it("laesst sich abschalten", () => {
    const result = resolveTaxCase({
      ...base,
      settings: { ...settings, reverseChargeEnabled: false },
      destination: { countryCodeV2: "AT" },
      order: { ...emptyOrder, metafield: { value: "ATU12345678" } },
    });
    expect(result.taxCase).toBe("standard");
  });

  it("erkennt die Ausfuhrlieferung ins Drittland", () => {
    const result = resolveTaxCase({
      ...base,
      destination: { countryCodeV2: "CH" },
      orderHasTax: false,
    });
    expect(result.taxCase).toBe("export");
    expect(result.zeroRated).toBe(true);
  });

  it("behandelt ein Drittland mit ausgewiesener Steuer normal", () => {
    const result = resolveTaxCase({ ...base, destination: { countryCodeV2: "CH" } });
    expect(result.taxCase).toBe("standard");
  });

  it("schlaegt als Kleinunternehmer alles andere", () => {
    const result = resolveTaxCase({
      ...base,
      settings: { ...settings, taxScheme: "kleinunternehmer" },
      destination: { countryCodeV2: "AT" },
      order: { ...emptyOrder, metafield: { value: "ATU12345678" } },
    });
    expect(result.taxCase).toBe("kleinunternehmer");
    expect(result.note).toContain("19");
  });

  it("kommt ohne Zieladresse zurecht", () => {
    expect(resolveTaxCase({ ...base, destination: null }).taxCase).toBe("standard");
  });
});

describe("taxCaseLabel", () => {
  it("liefert lesbare Bezeichnungen", () => {
    expect(taxCaseLabel("reverse_charge")).toBe("Reverse Charge");
    expect(taxCaseLabel("kleinunternehmer")).toContain("19");
    expect(taxCaseLabel("standard")).toBe("Regelbesteuerung");
  });
});
