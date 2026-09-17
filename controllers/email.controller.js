const emailService = require("../services/email.service");

// handleInboundEmail
const handleInboundEmail = async (req, res) => {
  try {
    const email = await emailService.processInboundEmail({
      body: req.body,
      files: req.files,
      headers: req.headers,
    });

    // For real time
    const io = req.app.get("io"); // get socket instance

    if (io) {
      io.emit("new_email", {
        email,
        unread: true,
      });
    }

    res.status(200).json({
      message: "Email stored successfully",
      data: email,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to process inbound email" });
  }
};

// TEMP TEST FUNCTION
const testCreateEmail = async (req, res) => {
  try {
    console.log("SUBJECT:", req.body.subject);
    const email = await emailService.createTestEmail();

    res.json({
      message: "Test email inserted",
      data: email,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to insert email" });
  }
};

// GET ALL
const getEmails = async (req, res) => {
  try {
    const emails = await emailService.getAllEmails();

    res.json(emails);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch emails" });
  }
};

module.exports = {
  testCreateEmail,
  getEmails,
  handleInboundEmail,
};
