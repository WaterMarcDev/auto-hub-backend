const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

let _User = null;
const getUser = () => {
  if (!_User) {
    const s = new mongoose.Schema({ first_name: String, last_name: String, email: String, role: String }, { timestamps: true });
    _User = mongoose.models.User || mongoose.model("User", s);
  }
  return _User;
};

const auth = async (req, res, next) => {
  try {
    let token = req.cookies?.token || req.header("Authorization")?.replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "No token, authorization denied" });
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "fallback_secret");
    const user = await getUser().findById(decoded.userId).select("-password");
    if (!user) return res.status(401).json({ error: "Token is not valid" });
    req.user = user;
    next();
  } catch { res.status(401).json({ error: "Token is not valid" }); }
};

const wixAuth = (req, res, next) => {
  const key = req.headers["x-wix-api-key"];
  if (key && key === process.env.WIX_API_KEY) return next();
  res.status(401).json({ message: "Unauthorized: Invalid Wix API Key" });
};

module.exports = { auth, wixAuth };
