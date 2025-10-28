export const wixAuth = (req, res, next) => {
  const wixApiKey = process.env.WIX_API_KEY;
  const requestApiKey = req.headers["x-wix-api-key"];

  if (requestApiKey && requestApiKey === wixApiKey) {
    next();
  } else {
    res.status(401).json({ message: "Unauthorized: Invalid Wix API Key" });
  }
};
