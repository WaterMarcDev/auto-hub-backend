const { body, validationResult } = require("express-validator");

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: "Validation failed",
      details: errors.array().map((e) => ({
        field: e.path || e.param,
        message: e.msg,
      })),
    });
  }
  next();
};

const registerValidation = [
  body("fullName")
    .trim()
    .notEmpty()
    .withMessage("Full name is required")
    .isLength({ min: 2, max: 100 })
    .withMessage("Full name must be between 2 and 100 characters"),
  body("email")
    .trim()
    .notEmpty()
    .withMessage("Email is required")
    .isEmail()
    .withMessage("Must be a valid email address")
    .normalizeEmail(),
  body("password")
    .notEmpty()
    .withMessage("Password is required")
    .isLength({ min: 6 })
    .withMessage("Password must be at least 6 characters long"),
  body("phone")
    .optional({ checkFalsy: true })
    .trim()
    .isString(),
  body("location")
    .optional({ checkFalsy: true })
    .trim()
    .isString(),
  handleValidationErrors,
];

const loginValidation = [
  body("email")
    .trim()
    .notEmpty()
    .withMessage("Email is required")
    .isEmail()
    .withMessage("Must be a valid email address")
    .normalizeEmail(),
  body("password")
    .notEmpty()
    .withMessage("Password is required"),
  handleValidationErrors,
];

const refreshTokenValidation = [
  body("refreshToken")
    .trim()
    .notEmpty()
    .withMessage("Refresh token is required"),
  handleValidationErrors,
];

const updateProfileValidation = [
  body("fullName")
    .optional()
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage("Full name must be between 2 and 100 characters"),
  body("phone")
    .optional()
    .trim()
    .isString(),
  body("location")
    .optional()
    .trim()
    .isString(),
  body("avatarUrl")
    .optional({ nullable: true })
    .trim()
    .isString(),
  body("accountType")
    .optional()
    .isIn(["buyer", "seller", "both"])
    .withMessage("Account type must be buyer, seller, or both"),
  handleValidationErrors,
];

module.exports = {
  registerValidation,
  loginValidation,
  refreshTokenValidation,
  updateProfileValidation,
  handleValidationErrors,
};
