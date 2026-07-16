/**
 * Google API Client — Placeholder
 *
 * Stub for future Google Ads / Google Business Messages integration.
 * Will support:
 *   - OAuth 2.0 flow
 *   - Google Ads API
 *   - Google Business Messages API
 */
class GoogleApiClient {
  constructor() {
    this.baseUrl = "https://googleads.googleapis.com/v18";
    this.timeout = 30000;
  }
}

module.exports = { GoogleApiClient };