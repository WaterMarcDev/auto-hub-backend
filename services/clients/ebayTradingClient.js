const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

class EbayTradingClient {
    constructor() {
        this.parser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: "",
        });
    }

    /**
     * FAIL CLOSED: resolved fresh on every call rather than cached at
     * construction, and never defaults to production. A missing/invalid
     * EBAY_ENVIRONMENT throws here instead of silently targeting
     * production — this is the same environment ambiguity this class
     * previously resolved with `|| "production"`.
     */
    _getEndpoint() {
        const environment = (process.env.EBAY_ENVIRONMENT || "")
            .toLowerCase()
            .trim();
        if (environment !== "sandbox" && environment !== "production") {
            throw new Error(
                "EBAY_ENVIRONMENT is missing or invalid (must be exactly \"production\" or \"sandbox\") — refusing to guess which eBay environment to call."
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
                        "X-EBAY-API-SITEID": "0",
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

        // return this.parser.parse(response.data);
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
}

module.exports = EbayTradingClient;