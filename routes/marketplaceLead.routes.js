/**
 * @deprecated Renamed to routes/marketplaceListing.routes.js. This file is
 * kept as a backward-compatible re-export so any existing require() of the
 * old path keeps working — new code should require
 * "./marketplaceListing.routes" directly. The mounted URL path
 * (/api/marketplace-leads, see server.js) is unchanged.
 */
module.exports = require("./marketplaceListing.routes");
