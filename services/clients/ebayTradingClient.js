const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

class EbayTradingClient {
    constructor() {
        this.parser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: "",
        });
    }

    _getEndpoint() {
        const environment = (process.env.EBAY_ENVIRONMENT || "")
            .toLowerCase()
            .trim();

        if (environment !== "sandbox" && environment !== "production") {
            throw new Error(
                'EBAY_ENVIRONMENT is missing or invalid (must be exactly "production" or "sandbox") — refusing to guess which eBay environment to call.'
            );
        }

        return environment === "sandbox"
            ? "https://api.sandbox.ebay.com/ws/api.dll"
            : "https://api.ebay.com/ws/api.dll";
    }

    async call(accessToken, callName, xml) {
        try {
            const response = await axios.post(
                this._getEndpoint(),
                xml,
                {
                    headers: {
                        "Content-Type": "text/xml",
                        "X-EBAY-API-CALL-NAME": callName,
                        "X-EBAY-API-COMPATIBILITY-LEVEL": "1231",
                        "X-EBAY-API-SITEID":
                            process.env.EBAY_TRADING_SITE_ID || "0",
                        "X-EBAY-API-IAF-TOKEN": accessToken,
                    },
                    timeout: 30000,
                }
            );

            return this.parser.parse(response.data);
        } catch (error) {
            console.error("[EBAY_TRADING_API]", {
                callName,
                status: error.response?.status,
                data: error.response?.data,
                message: error.message,
            });

            throw error;
        }
    }

    async getManualListings(accessToken, page = 1) {
        const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
    <ActiveList>
        <Include>true</Include>
        <Pagination>
            <EntriesPerPage>200</EntriesPerPage>
            <PageNumber>${page}</PageNumber>
        </Pagination>
    </ActiveList>

    <Version>1231</Version>
</GetMyeBaySellingRequest>`;

        return this.call(
            accessToken,
            "GetMyeBaySelling",
            xml
        );
    }

    /**
     * Fetch ONE page of the seller's CURRENT ACTIVE listings.
     *
     * This is the authoritative "what is live on this seller account right
     * now" read: GetMyeBaySelling's ActiveList container returns only items
     * eBay itself currently considers active. It is deliberately used instead
     * of the Inventory API's GET /sell/inventory/v1/inventory_item, which
     * returns every inventory record the seller has ever stored — including
     * items with no published offer, so it cannot answer "is this listing
     * active?".
     *
     * Returns the parsed page together with eBay's OWN pagination numbers
     * (GetMyeBaySellingResponse.ActiveList.PaginationResult), so the caller
     * pages until TotalNumberOfPages rather than assuming page 1 is enough.
     * The previous implementation called this with no page argument at all,
     * which permanently capped the active-listing feed at the first 200 items
     * no matter how many the seller actually had.
     *
     * @param {string} accessToken - valid eBay user access token
     * @param {number} [page=1] - 1-based page number
     * @param {number} [entriesPerPage=200] - items per page (eBay caps at 200)
     * @returns {Promise<{items: Array<Object>, totalEntries: number, totalPages: number, ack: string|null}>}
     */
    async getActiveListingsPage(accessToken, page = 1, entriesPerPage = 200) {
        const safeEntries = Math.min(Math.max(parseInt(entriesPerPage, 10) || 200, 1), 200);
        const safePage = Math.max(parseInt(page, 10) || 1, 1);

        const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
    <ActiveList>
        <Include>true</Include>
        <Pagination>
            <EntriesPerPage>${safeEntries}</EntriesPerPage>
            <PageNumber>${safePage}</PageNumber>
        </Pagination>
    </ActiveList>

    <Version>1231</Version>
</GetMyeBaySellingRequest>`;

        const parsed = await this.call(accessToken, "GetMyeBaySelling", xml);

        const response = parsed?.GetMyeBaySellingResponse;
        const activeList = response?.ActiveList;
        const rawItems = activeList?.ItemArray?.Item;

        // A single result is returned as an object rather than an array by
        // fast-xml-parser; an empty page omits ItemArray entirely.
        const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

        const pagination = activeList?.PaginationResult || {};
        const totalEntries = Number(pagination.TotalNumberOfEntries) || items.length;
        const totalPages = Number(pagination.TotalNumberOfPages) || 1;

        return {
            items,
            totalEntries,
            totalPages,
            ack: response?.Ack != null ? String(response.Ack) : null,
        };
    }

    async reviseFixedPriceItem(accessToken, xml) {
        return this.call(
            accessToken,
            "ReviseFixedPriceItem",
            xml
        );
    }

    async endFixedPriceItem(accessToken, xml) {
        return this.call(
            accessToken,
            "EndFixedPriceItem",
            xml
        );
    }

    async getItem(accessToken, xml) {
        return this.call(
            accessToken,
            "GetItem",
            xml
        );
    }

    async getSellerList(accessToken, xml) {
        return this.call(
            accessToken,
            "GetSellerList",
            xml
        );
    }
}

// ─── Shared Trading-API item field extractors ─────────────────────────────
// fast-xml-parser hands back either a plain string or an object carrying
// attributes (e.g. CurrentPrice has a currencyID attribute plus a #text
// value), so every consumer needs the same defensive unwrapping. Declared
// once here and used by BOTH the eBay adapter's listing upsert and the
// reconciliation service, so the two can never drift apart.

/** Real eBay item number (ItemID) for a Trading-API listing, or null. */
EbayTradingClient.extractItemId = function (item) {
    if (!item) return null;
    const id = item.ItemID ?? item.ItemId ?? null;
    return id != null && String(id).trim() !== "" ? String(id).trim() : null;
};

/** Seller SKU for a Trading-API listing, or null when eBay returns none. */
EbayTradingClient.extractSku = function (item) {
    if (!item) return null;
    const sku = item.SKU ?? null;
    return sku != null && String(sku).trim() !== "" ? String(sku).trim() : null;
};

/** Listing title, falling back to SKU then ItemID. */
EbayTradingClient.extractTitle = function (item) {
    if (!item) return null;
    const title = item.Title;
    if (title != null && String(title).trim() !== "") return String(title).trim();
    return EbayTradingClient.extractSku(item) || EbayTradingClient.extractItemId(item) || null;
};

/** Numeric current price, or 0 when eBay does not report one. */
EbayTradingClient.extractPrice = function (item) {
    const raw = item?.SellingStatus?.CurrentPrice;
    if (raw == null) {
        // Some listing shapes expose the price at the top level instead.
        const flat = item?.CurrentPrice;
        const flatValue = flat && typeof flat === "object" ? flat["#text"] : flat;
        const flatNum = Number(flatValue);
        return Number.isFinite(flatNum) ? flatNum : 0;
    }
    const value = typeof raw === "object" ? raw["#text"] : raw;
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
};

/** ISO currency code for the listing (defaults to USD, matching the model). */
EbayTradingClient.extractCurrency = function (item) {
    const raw = item?.SellingStatus?.CurrentPrice ?? item?.CurrentPrice;
    const code = raw && typeof raw === "object" ? raw.currencyID : null;
    return code ? String(code) : "USD";
};

/** Available quantity, or 0 when eBay does not report one. */
EbayTradingClient.extractQuantity = function (item) {
    const raw = item?.QuantityAvailable ?? item?.Quantity ?? 0;
    const num = Number(raw);
    return Number.isFinite(num) ? num : 0;
};

/** Raw eBay ListingStatusCodeType (Active / Completed / Ended), or null. */
EbayTradingClient.extractListingStatus = function (item) {
    const status = item?.SellingStatus?.ListingStatus;
    return status != null && String(status).trim() !== "" ? String(status).trim() : null;
};

module.exports = EbayTradingClient;