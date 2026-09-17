console.log("API KEY:", process.env.SENDGRID_API_KEY);
console.log("BASE URL:", process.env.BASE_URL);

const sendEmailService = require("../services/sendEmail.service");

// SEND REPLY
const sendReply = async (req, res) => {
  try {
    const savedReply = await sendEmailService.sendReply(req.body, req.files);

    // SOCKET EMIT
    const io = req.app.get("io");

    if (io) {
      io.emit("new_email", {
        email: savedReply,
        unread: false,
      });
    }

    res.json({
      success: true,
      data: savedReply,
    });
  } catch (err) {
    console.error("========== SEND REPLY ERROR ==========");

    console.error("MESSAGE:");
    console.error(err.message);

    console.error("STACK:");
    console.error(err.stack);

    console.log(JSON.stringify(err.response?.body, null, 2));
    console.error(err.response?.body);

    console.error("FULL ERROR:");
    console.error(err);

    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }

    res.status(500).json({
      error: err.message || "Failed to send email",
    });
  }
};

// FORWARD EMAIL
const forwardEmail = async (req, res) => {
  try {
    const savedForward = await sendEmailService.forwardEmail(req.body, req.files);

    // SOCKET EMIT
    const io = req.app.get("io");

    if (io) {
      io.emit("new_email", {
        email: savedForward,
        unread: false,
      });
    }

    res.json({
      success: true,
      data: savedForward,
    });
  } catch (err) {
    console.error("========== FORWARD ERROR ==========");

    console.error("MESSAGE:");
    console.error(err.message);

    console.error("STACK:");
    console.error(err.stack);

    console.error("SENDGRID:");
    console.error(err.response?.body);

    console.error("FULL ERROR:");
    console.error(err);

    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }

    res.status(500).json({
      error: err.message || "Failed to forward email",
    });
  }
};

module.exports = {
  sendReply,
  forwardEmail,
};
