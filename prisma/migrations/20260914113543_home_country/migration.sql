-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ShopSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "subdomain" TEXT,
    "apiTokenCipher" TEXT,
    "connectionOkAt" DATETIME,
    "remainingQuota" INTEGER,
    "invoiceMode" TEXT NOT NULL DEFAULT 'draft',
    "paymentTermId" INTEGER,
    "invoiceTemplateId" INTEGER,
    "estimateTemplateId" INTEGER,
    "projectId" INTEGER,
    "grossMode" TEXT NOT NULL DEFAULT 'auto',
    "defaultVatRate" REAL NOT NULL DEFAULT 19,
    "documentCurrency" TEXT NOT NULL DEFAULT 'EUR',
    "allowForeignCurrency" BOOLEAN NOT NULL DEFAULT false,
    "includeShipping" BOOLEAN NOT NULL DEFAULT true,
    "shippingLabel" TEXT NOT NULL DEFAULT 'Versandkosten',
    "includeTips" BOOLEAN NOT NULL DEFAULT true,
    "applyDiscounts" BOOLEAN NOT NULL DEFAULT true,
    "syncCustomers" BOOLEAN NOT NULL DEFAULT true,
    "updateCustomers" BOOLEAN NOT NULL DEFAULT false,
    "fallbackToPersonName" BOOLEAN NOT NULL DEFAULT true,
    "invoiceEmailSubject" TEXT NOT NULL DEFAULT 'Ihre Rechnung {{beleg_nr}}',
    "invoiceEmailBody" TEXT NOT NULL DEFAULT 'Guten Tag,

im Anhang finden Sie Ihre Rechnung {{beleg_nr}}. Bitte beachten Sie die Zahlungsmodalitaeten im Dokument.

Vielen Dank fuer Ihren Auftrag!',
    "estimateEmailSubject" TEXT NOT NULL DEFAULT 'Ihr Angebot {{beleg_nr}}',
    "estimateEmailBody" TEXT NOT NULL DEFAULT 'Guten Tag,

im Anhang finden Sie unser Angebot {{beleg_nr}}. Bei Rueckfragen melden Sie sich gerne.

Mit freundlichen Gruessen',
    "skipTag" TEXT NOT NULL DEFAULT 'papierkram:skip',
    "forceTag" TEXT NOT NULL DEFAULT 'papierkram:invoice',
    "homeCountry" TEXT NOT NULL DEFAULT 'DE',
    "taxScheme" TEXT NOT NULL DEFAULT 'standard',
    "reverseChargeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "reverseChargeNote" TEXT NOT NULL DEFAULT 'Steuerschuldnerschaft des Leistungsempfaengers (Reverse Charge) gemaess Art. 196 MwStSystRL.',
    "kleinunternehmerNote" TEXT NOT NULL DEFAULT 'Gemaess § 19 UStG wird keine Umsatzsteuer berechnet.',
    "vatIdSource" TEXT NOT NULL DEFAULT 'auto',
    "vatIdKey" TEXT NOT NULL DEFAULT 'vat_id',
    "reconcileEnabled" BOOLEAN NOT NULL DEFAULT false,
    "reconcileIntervalHours" INTEGER NOT NULL DEFAULT 6,
    "reconcileLastRunAt" DATETIME,
    "paidTag" TEXT NOT NULL DEFAULT 'papierkram:bezahlt',
    "overdueTag" TEXT NOT NULL DEFAULT 'papierkram:ueberfaellig',
    "documentNameTemplate" TEXT NOT NULL DEFAULT 'Shopify Bestellung {{order_name}}',
    "writeMetafields" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ShopSettings" ("allowForeignCurrency", "apiTokenCipher", "applyDiscounts", "connectionOkAt", "createdAt", "defaultVatRate", "documentCurrency", "documentNameTemplate", "estimateEmailBody", "estimateEmailSubject", "estimateTemplateId", "fallbackToPersonName", "forceTag", "grossMode", "id", "includeShipping", "includeTips", "invoiceEmailBody", "invoiceEmailSubject", "invoiceMode", "invoiceTemplateId", "kleinunternehmerNote", "overdueTag", "paidTag", "paymentTermId", "projectId", "reconcileEnabled", "reconcileIntervalHours", "reconcileLastRunAt", "remainingQuota", "reverseChargeEnabled", "reverseChargeNote", "shippingLabel", "shop", "skipTag", "subdomain", "syncCustomers", "taxScheme", "updateCustomers", "updatedAt", "vatIdKey", "vatIdSource", "writeMetafields") SELECT "allowForeignCurrency", "apiTokenCipher", "applyDiscounts", "connectionOkAt", "createdAt", "defaultVatRate", "documentCurrency", "documentNameTemplate", "estimateEmailBody", "estimateEmailSubject", "estimateTemplateId", "fallbackToPersonName", "forceTag", "grossMode", "id", "includeShipping", "includeTips", "invoiceEmailBody", "invoiceEmailSubject", "invoiceMode", "invoiceTemplateId", "kleinunternehmerNote", "overdueTag", "paidTag", "paymentTermId", "projectId", "reconcileEnabled", "reconcileIntervalHours", "reconcileLastRunAt", "remainingQuota", "reverseChargeEnabled", "reverseChargeNote", "shippingLabel", "shop", "skipTag", "subdomain", "syncCustomers", "taxScheme", "updateCustomers", "updatedAt", "vatIdKey", "vatIdSource", "writeMetafields" FROM "ShopSettings";
DROP TABLE "ShopSettings";
ALTER TABLE "new_ShopSettings" RENAME TO "ShopSettings";
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
