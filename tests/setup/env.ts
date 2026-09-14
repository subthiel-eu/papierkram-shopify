// Ohne diese Werte wirft shopifyApp() schon beim Import des Moduls.
process.env.SHOPIFY_API_KEY ??= "test-api-key";
process.env.SHOPIFY_API_SECRET ??= "test-api-secret";
process.env.SHOPIFY_APP_URL ??= "https://papierkram.test";
process.env.SCOPES ??= "read_orders,write_orders";
process.env.PAPIERKRAM_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
// Der Hintergrund-Worker soll in Tests nicht nebenher Jobs abarbeiten.
process.env.SYNC_WORKER_DISABLED ??= "true";
