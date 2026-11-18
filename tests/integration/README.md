# Integration tests (in-memory MongoDB)

Real backend code against a throwaway in-memory MongoDB. eBay/Wix HTTP calls
are mocked. Nothing touches a real database or marketplace.

One-time setup (dev only, not added to package.json):

```powershell
cd veridex-auto-hub-backend
npm install --no-save mongodb-memory-server@10
```

Run:

```powershell
$env:EBAY_QUANTITY_SYNC_AUTORUN="false"; $env:EBAY_NOTIFICATION_AUTORUN="false"
node tests/integration/ebayInventorySync.test.js          # 78 checks: ledger, eBay sales, cancellations, refunds/returns, CRM sale, CRM→eBay sync, webhooks, reconciliation, real-time
node tests/integration/scrapPurchaseAndSoldStatus.test.js # 65 checks: Scrap Purchase → Element Hub, eBay/Wix sold status, Sold Products API, Master Parts filter
```

Exit code 0 = all passed.
