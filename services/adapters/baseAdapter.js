/**
 * Base Platform Adapter
 *
 * Defines the standard interface that all platform adapters must implement.
 *
 * Each platform adapter should extend this interface and implement:
 *   - sendMessage()
 *   - fetchMessages()
 *   - fetchProfile()
 *   - verifyWebhook()
 *   - processWebhook()
 *   - refreshToken()
 *   - connect()
 *   - disconnect()
 *   - exchangeAuthorizationCode()
 *   - registerWebhook()
 *   - receiveWebhook()
 *   - markAsRead()
 *   - healthCheck()
 *   - fetchBusinessAccount()
 *   - fetchPhoneNumber()
 *
 * @abstract
 */
class BaseAdapter {
  constructor(platformName) {
    this.platformName = platformName;
  }

  /**
   * Send a message to a customer on this platform.
   * @param {Object} conversation - Conversation document
   * @param {string} text - Message text
   * @param {Array} [attachments] - Attachment objects
   * @param {Object} [options] - Additional options
   * @returns {Promise<{platformMessageId: string, status: string}>}
   */
  async sendMessage(conversation, text, attachments = [], options = {}) {
    throw new Error(`sendMessage() not implemented for ${this.platformName}`);
  }

  /**
   * Fetch messages from this platform for a conversation.
   * @param {Object} conversation - Conversation document
   * @param {Date} [since] - Fetch messages since this date
   * @returns {Promise<Array>} Message objects
   */
  async fetchMessages(conversation, since = null) {
    throw new Error(`fetchMessages() not implemented for ${this.platformName}`);
  }

  /**
   * Fetch a customer's profile from this platform.
   * @param {string} platformUserId - Platform user ID
   * @returns {Promise<Object>} Profile with name, picture, etc.
   */
  async fetchProfile(platformUserId) {
    throw new Error(`fetchProfile() not implemented for ${this.platformName}`);
  }

  /**
   * Verify a webhook signature from this platform.
   * @param {Object} payload - Webhook payload
   * @param {string} signature - Signature header
   * @returns {boolean}
   */
  verifyWebhook(payload, signature) {
    throw new Error(`verifyWebhook() not implemented for ${this.platformName}`);
  }

  /**
   * Process an incoming webhook payload from this platform.
   * @param {Object} payload - Webhook payload
   * @returns {Promise<Object>} Processing result
   */
  async processWebhook(payload) {
    throw new Error(`processWebhook() not implemented for ${this.platformName}`);
  }

  /**
   * Refresh an expired OAuth token for this platform.
   * @param {Object} account - IntegrationAccount document
   * @returns {Promise<Object>} Updated account with new tokens
   */
  async refreshToken(account) {
    throw new Error(`refreshToken() not implemented for ${this.platformName}`);
  }

  // ─── New Abstract Methods (Phase 1) ──────────────────────────────────

  /**
   * Initiate an OAuth connection flow.
   * Returns the OAuth authorization URL the user should be redirected to.
   *
   * @param {Object} [options] - Platform-specific options
   * @returns {Promise<string>} OAuth authorization URL
   */
  async connect(options = {}) {
    throw new Error(`connect() not implemented for ${this.platformName}`);
  }

  /**
   * Disconnect and revoke access for this platform.
   *
   * @param {Object} account - IntegrationAccount document
   * @returns {Promise<boolean>} Whether disconnection succeeded
   */
  async disconnect(account) {
    throw new Error(`disconnect() not implemented for ${this.platformName}`);
  }

  /**
   * Exchange an authorization code for an access token.
   *
   * @param {string} code - Authorization code from OAuth callback
   * @param {Object} [options] - Additional options (redirectUri, etc.)
   * @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number}>}
   */
  async exchangeAuthorizationCode(code, options = {}) {
    throw new Error(`exchangeAuthorizationCode() not implemented for ${this.platformName}`);
  }

  /**
   * Register a webhook subscription for this platform.
   *
   * @param {Object} account - IntegrationAccount document
   * @returns {Promise<boolean>} Whether registration succeeded
   */
  async registerWebhook(account) {
    throw new Error(`registerWebhook() not implemented for ${this.platformName}`);
  }

  /**
   * Receive and process an incoming webhook event.
   * This is the entry point for all incoming messages from the platform.
   *
   * @param {Object} payload - Raw webhook payload
   * @returns {Promise<Object>} Processing result with events array
   */
  async receiveWebhook(payload) {
    throw new Error(`receiveWebhook() not implemented for ${this.platformName}`);
  }

  /**
   * Mark a message as read on this platform.
   *
   * @param {string} messageId - Platform message ID to mark as read
   * @param {Object} [options] - Additional options
   * @returns {Promise<boolean>}
   */
  async markAsRead(messageId, options = {}) {
    throw new Error(`markAsRead() not implemented for ${this.platformName}`);
  }

  /**
   * Perform a health check against the platform API.
   *
   * @param {Object} account - IntegrationAccount document
   * @returns {Promise<{healthy: boolean, details: Object}>}
   */
  async healthCheck(account) {
    throw new Error(`healthCheck() not implemented for ${this.platformName}`);
  }

  /**
   * Fetch the business account details from this platform.
   *
   * @param {Object} account - IntegrationAccount document
   * @returns {Promise<{businessAccountId: string, businessName: string}>}
   */
  async fetchBusinessAccount(account) {
    throw new Error(`fetchBusinessAccount() not implemented for ${this.platformName}`);
  }

  /**
   * Fetch the phone number(s) associated with this platform account.
   *
   * @param {Object} account - IntegrationAccount document
   * @returns {Promise<Array<{phoneNumberId: string, displayPhoneNumber: string}>>}
   */
  async fetchPhoneNumber(account) {
    throw new Error(`fetchPhoneNumber() not implemented for ${this.platformName}`);
  }
}

module.exports = BaseAdapter;