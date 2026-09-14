-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" DATETIME,
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false
);

-- CreateTable
CREATE TABLE "ShopSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "subdomain" TEXT,
    "apiTokenCipher" TEXT,
    "connectionOkAt" DATETIME,
    "remainingQuota" INTEGER,
    "invoiceMode" TEXT NOT NULL DEFAULT 'draft',
    "invoiceTrigger" TEXT NOT NULL DEFAULT 'manual',
    "estimateFromDraftOrders" BOOLEAN NOT NULL DEFAULT false,
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

-- CreateTable
CREATE TABLE "DocumentLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "shopifyGid" TEXT NOT NULL,
    "shopifyLabel" TEXT,
    "papierkramId" INTEGER NOT NULL,
    "documentNo" TEXT,
    "state" TEXT,
    "totalGross" REAL,
    "currency" TEXT,
    "url" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SyncJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "runAfter" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "dedupeKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "LogEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PropositionMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyGid" TEXT NOT NULL,
    "shopifyLabel" TEXT,
    "propositionId" INTEGER NOT NULL,
    "propositionNo" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");

-- CreateIndex
CREATE INDEX "DocumentLink_shop_kind_idx" ON "DocumentLink"("shop", "kind");

-- CreateIndex
CREATE INDEX "DocumentLink_shop_papierkramId_idx" ON "DocumentLink"("shop", "papierkramId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentLink_shop_kind_shopifyGid_key" ON "DocumentLink"("shop", "kind", "shopifyGid");

-- CreateIndex
CREATE INDEX "SyncJob_status_runAfter_idx" ON "SyncJob"("status", "runAfter");

-- CreateIndex
CREATE INDEX "SyncJob_shop_status_idx" ON "SyncJob"("shop", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SyncJob_shop_dedupeKey_key" ON "SyncJob"("shop", "dedupeKey");

-- CreateIndex
CREATE INDEX "LogEntry_shop_createdAt_idx" ON "LogEntry"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "LogEntry_shop_level_idx" ON "LogEntry"("shop", "level");

-- CreateIndex
CREATE UNIQUE INDEX "PropositionMapping_shop_shopifyGid_key" ON "PropositionMapping"("shop", "shopifyGid");
