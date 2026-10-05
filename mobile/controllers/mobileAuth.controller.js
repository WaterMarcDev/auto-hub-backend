const mobileAuthService = require("../services/mobileAuth.service");

class MobileAuthController {
  /**
   * POST /api/v1/app/auth/register
   */
  async register(req, res, next) {
    try {
      const { fullName, email, password, phone, location } = req.body;
      const result = await mobileAuthService.register({
        fullName,
        email,
        password,
        phone,
        location,
      });

      res.status(201).json({
        success: true,
        message: "Account registered successfully",
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/app/auth/login
   */
  async login(req, res, next) {
    try {
      const { email, password, deviceInfo } = req.body;
      const result = await mobileAuthService.login({
        email,
        password,
        deviceInfo: deviceInfo || req.headers["user-agent"] || "Mobile Device",
      });

      res.status(200).json({
        success: true,
        message: "Logged in successfully",
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/app/auth/refresh-token
   */
  async refreshToken(req, res, next) {
    try {
      const { refreshToken, deviceInfo } = req.body;
      const result = await mobileAuthService.refreshToken({
        refreshToken,
        deviceInfo: deviceInfo || req.headers["user-agent"] || "Mobile Device",
      });

      res.status(200).json({
        success: true,
        message: "Token refreshed successfully",
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/app/auth/profile
   */
  async getProfile(req, res, next) {
    try {
      // req.appUser is already cached and attached by requireMobileAuth middleware
      res.status(200).json({
        success: true,
        data: {
          user: req.appUser,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * PUT /api/v1/app/auth/profile
   */
  async updateProfile(req, res, next) {
    try {
      const updatedUser = await mobileAuthService.updateProfile(req.appUserId, req.body);
      res.status(200).json({
        success: true,
        message: "Profile updated successfully",
        data: {
          user: updatedUser,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * PUT /api/v1/app/auth/settings
   */
  async updateSettings(req, res, next) {
    try {
      const updatedUser = await mobileAuthService.updateSettings(req.appUserId, req.body);
      res.status(200).json({
        success: true,
        message: "Settings updated successfully",
        data: {
          user: updatedUser,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/app/auth/logout
   */
  async logout(req, res, next) {
    try {
      const { refreshToken } = req.body;
      await mobileAuthService.logout(req.appUserId, refreshToken);
      res.status(200).json({
        success: true,
        message: "Logged out successfully",
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new MobileAuthController();
