/**
 * Shopify API Client — Placeholder
 *
 * Stub for future Shopify Storefront API / Admin API integration.
 * Will support:
 *   - Storefront API for chat
 *   - Admin API for orders
 *   - Webhook verification
 */
class ShopifyApiClient {
  constructor() {
    this.baseUrl = "https://{shop}.myshopify.com/admin/api/2024-01";
    this.timeout = 30000;
  }
}

module.exports = { ShopifyApiClient };