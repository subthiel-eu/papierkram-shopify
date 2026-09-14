/*
  Warnings:

  - You are about to drop the column `estimateFromDraftOrders` on the `ShopSettings` table. All the data in the column will be lost.
  - You are about to drop the column `invoiceTrigger` on the `ShopSettings` table. All the data in the column will be lost.

*/
-- CreateTable
CREATE TABLE "WebhookRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "businessCase" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "delaySeconds" INTEGER NOT NULL DEFAULT 0,
    "mode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

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
    "includeShipping" BOOLEAN NOT NULL DEFAULT true,
    "shippingLabel" TEXT NOT NULL DEFAULT 'Versandkosten',
    "includeTips" BOOLEAN NOT NULL DEFAULT true,
    "applyDiscounts" BOOLEAN NOT NULL DEFAULT true,
    "syncCustomers" BOOLEAN NOT NULL DEFAULT true,
    "updateCustomers" BOOLEAN NOT NULL DEFAULT false,
    "fallbackToPersonName" BOOLEAN NOT NULL DEFAULT true,
    "documentNameTemplate" TEXT NOT NULL DEFAULT 'Shopify Bestellung {{order_name}}',
    "writeMetafields" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ShopSettings" ("apiTokenCipher", "applyDiscounts", "connectionOkAt", "createdAt", "defaultVatRate", "documentNameTemplate", "estimateTemplateId", "fallbackToPersonName", "grossMode", "id", "includeShipping", "includeTips", "invoiceMode", "invoiceTemplateId", "paymentTermId", "projectId", "remainingQuota", "shippingLabel", "shop", "subdomain", "syncCustomers", "updateCustomers", "updatedAt", "writeMetafields") SELECT "apiTokenCipher", "applyDiscounts", "connectionOkAt", "createdAt", "defaultVatRate", "documentNameTemplate", "estimateTemplateId", "fallbackToPersonName", "grossMode", "id", "includeShipping", "includeTips", "invoiceMode", "invoiceTemplateId", "paymentTermId", "projectId", "remainingQuota", "shippingLabel", "shop", "subdomain", "syncCustomers", "updateCustomers", "updatedAt", "writeMetafields" FROM "ShopSettings";
DROP TABLE "ShopSettings";
ALTER TABLE "new_ShopSettings" RENAME TO "ShopSettings";
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "WebhookRule_shop_topic_enabled_idx" ON "WebhookRule"("shop", "topic", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookRule_shop_businessCase_topic_key" ON "WebhookRule"("shop", "businessCase", "topic");
