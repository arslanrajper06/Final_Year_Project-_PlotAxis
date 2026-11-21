require("dotenv").config();
const express = require("express");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const { PLOTS, buildInstallmentPlan } = require("./data");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// 1. MySQL Connection Pool
const db = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "plotaxis_db",
  timezone: "Z",
});

// 2. Email Transporter (Nodemailer)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

function requireCustomer(req, res, next) {
  const authorization = req.get("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return res.status(401).json({ message: "Please log in to continue." });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || "secret");
    const customerId = Number(payload.id);
    if (!Number.isSafeInteger(customerId) || customerId < 1) {
      return res.status(401).json({ message: "Invalid session." });
    }
    req.customer = { id: customerId, email: payload.email };
    next();
  } catch (error) {
    return res.status(401).json({ message: "Your session has expired. Please log in again." });
  }
}

function requireAdmin(req, res, next) {
  const configuredKey = process.env.ADMIN_API_KEY || "";
  const suppliedKey = req.get("x-admin-key") || "";
  if (!configuredKey) {
    return res.status(503).json({ message: "Admin API is not configured. Set ADMIN_API_KEY in .env." });
  }
  const configured = Buffer.from(configuredKey);
  const supplied = Buffer.from(suppliedKey);
  if (configured.length !== supplied.length || !crypto.timingSafeEqual(configured, supplied)) {
    return res.status(401).json({ message: "Admin authorization failed." });
  }
  next();
}

function serializeReservation(row) {
  let booking;
  try {
    booking = typeof row.booking_data === "string" ? JSON.parse(row.booking_data) : row.booking_data;
  } catch (error) {
    throw new Error(`Invalid stored booking data for ${row.booking_id}.`);
  }
  if (!booking || typeof booking !== "object" || !Array.isArray(booking.installments)) {
    throw new Error(`Invalid stored booking data for ${row.booking_id}.`);
  }

  booking.serverManaged = true;
  booking.paymentStatus = row.status;
  booking.paymentExpiresAt = new Date(row.expires_at).toISOString();
  booking.extensionUsed = Boolean(row.extension_used);
  booking.paymentVerifiedAt = row.payment_verified_at
    ? new Date(row.payment_verified_at).toISOString()
    : null;
  booking.cancelled = row.status === "cancelled";
  booking.cancellationPending = Boolean(row.cancel_at && row.status !== "cancelled");
  booking.cancellationEffectiveAt = row.cancel_at
    ? new Date(row.cancel_at).toISOString()
    : null;

  const downPayment = booking.installments.find(item => item.id === "down");
  if (downPayment) {
    downPayment.paid = row.status === "payment_verified";
    if (downPayment.paid && row.payment_verified_at) {
      downPayment.paidDate = new Date(row.payment_verified_at).toISOString().slice(0, 10);
    } else {
      delete downPayment.paidDate;
    }
  }
  return booking;
}

async function getCustomerReservations(userId) {
  const [rows] = await db.query(
    "SELECT * FROM plot_reservations WHERE user_id = ? ORDER BY reserved_at DESC",
    [userId]
  );
  return rows.map(serializeReservation);
}

function escapeEmailHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sendReservationEmail(email, subject, text) {
  const info = await transporter.sendMail({
    from: `"PlotAxis Portal" <${process.env.EMAIL_USER}>`,
    to: email,
    subject,
    text,
    html: `<div style="font-family: Arial, sans-serif; line-height: 1.6;">${escapeEmailHtml(text).replace(/\n/g, "<br>")}</div>`,
  });
  const wasAccepted = (info.accepted || []).some(
    address => String(address).toLowerCase() === email.toLowerCase()
  );
  if (!wasAccepted || (info.rejected || []).some(address =>
    String(address).toLowerCase() === email.toLowerCase()
  )) {
    throw new Error(`Reservation email was not accepted for ${email}.`);
  }
}

const CERTIFICATE_DOCUMENT_TYPES = new Set([
  "society_registration",
  "noc",
  "approved_layout_plan",
  "land_ownership",
]);

function normalizeCertificateMetadata(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const fields = {
    societyName: [body.societyName, 120],
    documentType: [body.documentType, 40],
    title: [body.title, 180],
    issuingAuthority: [body.issuingAuthority, 180],
    approvalNumber: [body.approvalNumber, 120],
  };
  const metadata = {};
  for (const [field, [value, maxLength]] of Object.entries(fields)) {
    if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) return null;
    metadata[field] = value.trim();
  }
  if (!CERTIFICATE_DOCUMENT_TYPES.has(metadata.documentType)) return null;
  return metadata;
}

function certificateMimeType(request, file) {
  if (!Buffer.isBuffer(file) || !file.length) return null;
  const mimeType = (request.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (mimeType === "application/pdf" && file.subarray(0, 5).toString() === "%PDF-") return mimeType;
  if (mimeType === "image/png"
    && file.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return mimeType;
  if (mimeType === "image/jpeg" && file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff) return mimeType;
  return null;
}

function certificateFileName(request) {
  const providedName = request.get("x-file-name") || "certificate";
  return providedName.replace(/[/\\]/g, "_").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180) || "certificate";
}

async function recordCertificateView(request, certificateId, viewerType, customerId = null) {
  await db.query(
    `INSERT INTO certificate_views
       (certificate_id, customer_id, viewer_type, admin_name, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      certificateId,
      customerId,
      viewerType,
      viewerType === "admin" ? String(request.get("x-admin-name") || "admin").trim().slice(0, 100) : null,
      String(request.ip || "").slice(0, 45) || null,
      String(request.get("user-agent") || "").slice(0, 512) || null,
    ]
  );
}

let reservationJobRunning = false;
async function runReservationExpiryJob() {
  if (reservationJobRunning) return;
  reservationJobRunning = true;
  try {
    const [rows] = await db.query(
      `SELECT r.*, u.full_name, u.email
       FROM plot_reservations r
       JOIN users u ON u.id = r.user_id
       WHERE (r.status = 'pending' AND (
         r.expires_at <= UTC_TIMESTAMP(3)
         OR (r.cancel_at IS NOT NULL AND r.cancel_at <= UTC_TIMESTAMP(3))
         OR (r.cancel_at IS NULL AND r.reminder_24_sent_at IS NULL
             AND r.reserved_at <= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 24 HOUR))
         OR (r.cancel_at IS NULL AND r.reminder_48_sent_at IS NULL
             AND r.reserved_at <= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 48 HOUR))
       ))
       OR (r.status = 'payment_verified' AND r.cancel_at IS NOT NULL
           AND r.cancel_at <= UTC_TIMESTAMP(3))
       OR (r.status = 'cancelled' AND r.cancellation_reason = 'expiry'
           AND r.expiry_notice_sent_at IS NULL)`
    );

    for (const row of rows) {
      try {
        const now = Date.now();
        const expiresAt = new Date(row.expires_at).getTime();
        if (row.status === "pending" && expiresAt <= now) {
          const [result] = await db.query(
            `UPDATE plot_reservations
             SET status = 'cancelled', cancellation_reason = 'expiry', cancelled_at = UTC_TIMESTAMP(3)
             WHERE booking_id = ? AND status = 'pending' AND expires_at <= UTC_TIMESTAMP(3)`,
            [row.booking_id]
          );
          if (!result.affectedRows) continue;
          row.status = "cancelled";
          row.cancellation_reason = "expiry";
          row.extension_used = Number(row.extension_used);
        } else if (row.cancel_at && new Date(row.cancel_at).getTime() <= now
          && (row.status === "pending" || row.status === "payment_verified")) {
          await db.query(
            `UPDATE plot_reservations
             SET status = 'cancelled', cancellation_reason = 'customer', cancelled_at = UTC_TIMESTAMP(3)
             WHERE booking_id = ? AND status IN ('pending', 'payment_verified')
               AND cancel_at <= UTC_TIMESTAMP(3)`,
            [row.booking_id]
          );
          continue;
        }

        if (row.status === "cancelled" && row.cancellation_reason === "expiry") {
          const period = Number(row.extension_used)
            ? "within the given 72-hour period and the approved 24-hour extension."
            : "within the given 72-hour period.";
          const text = `Dear ${row.full_name},\n\nYour reservation for Plot ${row.plot_id} has been automatically cancelled because the payment was not completed ${period}\n\nThe plot is now available for other customers to reserve.\n\nThank you for choosing PlotAxis.\n\nBest Regards,\nPlotAxis Team`;
          await sendReservationEmail(row.email, `Reservation cancelled: Plot ${row.plot_id}`, text);
          await db.query(
            "UPDATE plot_reservations SET expiry_notice_sent_at = UTC_TIMESTAMP(3) WHERE booking_id = ? AND expiry_notice_sent_at IS NULL",
            [row.booking_id]
          );
          continue;
        }

        if (row.status !== "pending" || row.cancel_at) continue;
        const reservedAt = new Date(row.reserved_at).getTime();
        const hoursElapsed = (now - reservedAt) / (60 * 60 * 1000);
        const hoursRemaining = Math.max(1, Math.ceil((expiresAt - now) / (60 * 60 * 1000)));
        if (!row.reminder_24_sent_at && hoursElapsed >= 48) {
          await db.query(
            "UPDATE plot_reservations SET reminder_24_sent_at = UTC_TIMESTAMP(3) WHERE booking_id = ? AND reminder_24_sent_at IS NULL AND status = 'pending'",
            [row.booking_id]
          );
          row.reminder_24_sent_at = true;
        } else if (!row.reminder_24_sent_at && hoursElapsed >= 24) {
          const text = `Dear ${row.full_name},\n\nThis is a friendly reminder that your payment for Plot ${row.plot_id} is still pending.\n\nYou have ${hoursRemaining} hours remaining to complete your payment and confirm your reservation. Please make the payment within the given time to avoid automatic cancellation.\n\nBest Regards,\nPlotAxis Team`;
          await sendReservationEmail(row.email, `Payment reminder: Plot ${row.plot_id}`, text);
          await db.query(
            "UPDATE plot_reservations SET reminder_24_sent_at = UTC_TIMESTAMP(3) WHERE booking_id = ? AND reminder_24_sent_at IS NULL AND status = 'pending'",
            [row.booking_id]
          );
        }
        if (!row.reminder_48_sent_at && hoursElapsed >= 48) {
          const text = `Dear ${row.full_name},\n\nThis is your final reminder that payment for Plot ${row.plot_id} is still pending.\n\nYou have ${hoursRemaining} hours remaining to complete your payment. Otherwise, your reservation will be automatically cancelled, and the plot will become available to other customers.\n\nBest Regards,\nPlotAxis Team`;
          await sendReservationEmail(row.email, `Final payment reminder: Plot ${row.plot_id}`, text);
          await db.query(
            "UPDATE plot_reservations SET reminder_48_sent_at = UTC_TIMESTAMP(3) WHERE booking_id = ? AND reminder_48_sent_at IS NULL AND status = 'pending'",
            [row.booking_id]
          );
        }
      } catch (error) {
        console.error(`Reservation expiry task failed for ${row.booking_id}:`, error);
      }
    }
  } catch (error) {
    console.error("Could not run reservation expiry task:", error);
  } finally {
    reservationJobRunning = false;
  }
}

function normalizeCustomerPhone(phone) {
  const digits = String(phone).trim();
  return /^03\d{9}$/.test(digits) ? digits : null;
}

// Helper: Generate 6-digit OTP & Send to ANY User's Email
  async function generateAndSendOTP(email, purpose) {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 1 * 60 * 1000); // 1 minute validity

  await db.query("DELETE FROM otp_codes WHERE email = ? AND purpose = ?", [email, purpose]);

  await db.query(
    "INSERT INTO otp_codes (email, otp_code, purpose, expires_at) VALUES (?, ?, ?, ?)",
    [email, otp, purpose, expiresAt]
  );

  let mailInfo;
  try {
    mailInfo = await transporter.sendMail({
      from: `"PlotAxis Portal" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: `Your PlotAxis Verification Code: ${otp}`,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #e4e7f2; border-radius: 10px; max-width: 480px;">
          <h2 style="color: #1E2761; margin-top: 0;">PlotAxis Customer Portal</h2>
          <p>Your one-time verification code for <strong>${purpose}</strong> is:</p>
          <h1 style="letter-spacing: 6px; color: #C9992C; background: #F2F5FC; padding: 12px 24px; display: inline-block; border-radius: 8px; margin: 10px 0;">${otp}</h1>
          <p style="color: #6B7189; font-size: 13px;">This code will expire in 1 minute. Do not share it with anyone.</p>
        </div>
      `,
    });
  } catch (error) {
    await db.query("DELETE FROM otp_codes WHERE email = ? AND purpose = ? AND otp_code = ?", [
      email,
      purpose,
      otp,
    ]);
    if (error.command === "RCPT TO" && Number(error.responseCode) >= 500) {
      const rejectedError = new Error("The email recipient was rejected.");
      rejectedError.code = "EMAIL_RECIPIENT_REJECTED";
      throw rejectedError;
    }
    throw error;
  }

  const wasRejected = (mailInfo.rejected || []).some(
    address => String(address).toLowerCase() === email.toLowerCase()
  );
  const wasAccepted = (mailInfo.accepted || []).some(
    address => String(address).toLowerCase() === email.toLowerCase()
  );

  if (wasRejected || !wasAccepted) {
    await db.query("DELETE FROM otp_codes WHERE email = ? AND purpose = ? AND otp_code = ?", [
      email,
      purpose,
      otp,
    ]);
    const error = new Error("The email recipient was rejected.");
    error.code = "EMAIL_RECIPIENT_REJECTED";
    throw error;
  }
}

// API 1: REGISTER
app.post("/api/auth/register", async (req, res) => {
  try {
    const { fullName, email, phone, password } = req.body;
    if (
      typeof fullName !== "string" ||
      !fullName.trim() ||
      typeof email !== "string" ||
      !email.trim() ||
      typeof phone !== "string" ||
      !phone.trim() ||
      typeof password !== "string" ||
      !password
    ) {
      return res.status(400).json({ message: "All fields are required." });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPhone = normalizeCustomerPhone(phone);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ message: "Enter a valid email address." });
    }
    if (!normalizedPhone) {
      return res.status(400).json({ message: "Phone number must be exactly 11 digits and start with 03." });
    }

    const missingPasswordRules = [
      [password.length >= 8, "at least 8 characters"],
      [/[A-Z]/.test(password), "one uppercase letter"],
      [/[a-z]/.test(password), "one lowercase letter"],
      [/\d/.test(password), "one number"],
      [/[^A-Za-z0-9\s]/.test(password), "one special character"],
    ].filter(([met]) => !met).map(([, description]) => description);
    if (missingPasswordRules.length) {
      return res.status(400).json({ message: `Password is missing: ${missingPasswordRules.join(", ")}.` });
    }

    const [existing] = await db.query("SELECT id, is_verified FROM users WHERE email = ?", [normalizedEmail]);
    const existingUser = existing[0];

    if (existingUser && Number(existingUser.is_verified) === 1) {
      return res.status(400).json({ message: "This email already exists. Please log in or use another email." });
    }

    const normalizedInternationalPhone = `92${normalizedPhone.slice(1)}`;
    const [phoneOwners] = await db.query(
      `SELECT id FROM users
       WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '')
       IN (?, ?, ?)`,
      [normalizedPhone, normalizedInternationalPhone, `00${normalizedInternationalPhone}`]
    );
    if (phoneOwners.some(user => user.id !== (existingUser && existingUser.id))) {
      return res.status(400).json({ message: "This phone number is already registered. Use another number." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    if (existingUser) {
      await db.query(
        "UPDATE users SET full_name = ?, phone = ?, password_hash = ? WHERE email = ?",
        [fullName.trim(), normalizedPhone, passwordHash, normalizedEmail]
      );
    } else {
      await db.query(
        "INSERT INTO users (full_name, email, phone, password_hash, is_verified) VALUES (?, ?, ?, ?, 0)",
        [fullName.trim(), normalizedEmail, normalizedPhone, passwordHash]
      );
    }

    await generateAndSendOTP(normalizedEmail, "register");
    res.json({ message: "OTP sent to your email for verification." });
  } catch (err) {
    if (err.code === "EMAIL_RECIPIENT_REJECTED") {
      return res.status(400).json({ message: "This email address could not receive OTP. Check the email and try again." });
    }
    console.error("Register Error:", err);
    res.status(500).json({ message: "Server error while registering. Check terminal logs." });
  }
});

// API 2: LOGIN
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required." });
    }

    const [rows] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
    if (rows.length === 0) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    const user = rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    if (!user.is_verified) {
      return res.status(403).json({ message: "Verify your email using the registration OTP before logging in." });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET || "secret", {
      expiresIn: "7d",
    });

    res.json({
      message: "Login successful!",
      token,
      user: {
        id: user.id,
        name: user.full_name,
        email: user.email,
        phone: user.phone,
      },
    });
  } catch (err) {
    console.error("Login Error:", err);
    res.status(500).json({ message: "Server error during login." });
  }
});

// API 3: VERIFY OTP
app.post("/api/auth/verify-otp", async (req, res) => {
  try {
    const { email, otp, purpose } = req.body;
    if (!email || !otp || !purpose) {
      return res.status(400).json({ message: "Email, OTP, and purpose are required." });
    }
    if (purpose !== "register") {
      return res.status(400).json({ message: "OTP verification is only available for registration." });
    }

    const [otpRows] = await db.query(
      "SELECT * FROM otp_codes WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1",
      [email, purpose]
    );

    if (otpRows.length === 0) {
      return res.status(400).json({ message: "No OTP found. Please request a new one." });
    }

    const record = otpRows[0];
    if (new Date() > new Date(record.expires_at)) {
      return res.status(400).json({ message: "OTP has expired. Please request a new one." });
    }

    if (record.otp_code !== otp.trim()) {
      return res.status(400).json({ message: "Incorrect OTP code." });
    }

    await db.query("DELETE FROM otp_codes WHERE id = ?", [record.id]);

    await db.query("UPDATE users SET is_verified = 1 WHERE email = ?", [email]);

    const [userRows] = await db.query(
      "SELECT id, full_name, email, phone FROM users WHERE email = ?",
      [email]
    );
    const user = userRows[0];

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET || "secret", {
      expiresIn: "7d",
    });

    res.json({
      message: "Authentication successful!",
      token,
      user: {
        id: user.id,
        name: user.full_name,
        email: user.email,
        phone: user.phone,
      },
    });
  } catch (err) {
    console.error("Verify OTP Error:", err);
    res.status(500).json({ message: "Server error during OTP verification." });
  }
});

// API 4: RESEND OTP
app.post("/api/auth/resend-otp", async (req, res) => {
  try {
    const { email, purpose } = req.body;
    if (!email || !purpose) {
      return res.status(400).json({ message: "Email and purpose are required." });
    }
    if (purpose !== "register") {
      return res.status(400).json({ message: "OTP resend is only available for registration." });
    }
    await generateAndSendOTP(email, purpose);
    res.json({ message: "A new OTP has been sent to your email." });
  } catch (err) {
    if (err.code === "EMAIL_RECIPIENT_REJECTED") {
      return res.status(400).json({ message: "This email address could not receive OTP. Check the email and try again." });
    }
    console.error("Resend OTP Error:", err);
    res.status(500).json({ message: "Failed to resend OTP." });
  }
});

app.get("/api/reservations", requireCustomer, async (req, res) => {
  try {
    const bookings = await getCustomerReservations(req.customer.id);
    res.json({ bookings });
  } catch (error) {
    console.error("Could not load customer reservations:", error);
    res.status(500).json({ message: "Could not load reservations." });
  }
});

app.get("/api/reservations/availability", requireCustomer, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT DISTINCT plot_id FROM plot_reservations
       WHERE (status = 'pending' AND expires_at > UTC_TIMESTAMP(3))
          OR status = 'payment_verified'`
    );
    res.json({ reservedPlotIds: rows.map(row => row.plot_id) });
  } catch (error) {
    console.error("Could not load plot availability:", error);
    res.status(500).json({ message: "Could not load plot availability." });
  }
});

app.post("/api/reservations", requireCustomer, async (req, res) => {
  const booking = req.body && req.body.booking;
  if (!booking || typeof booking !== "object" || Array.isArray(booking)
    || typeof booking.bookingId !== "string"
    || !/^(?:booking|legacy)-[A-Za-z0-9-]{5,100}$/.test(booking.bookingId)
    || typeof booking.plotId !== "string") {
    return res.status(400).json({ message: "Reservation details are incomplete or invalid." });
  }

  const plot = PLOTS.find(item => item.id === booking.plotId);
  if (!plot) return res.status(400).json({ message: "Selected plot is not in the inventory." });
  if (plot.status !== "Available") {
    return res.status(409).json({ message: "This plot is not available for reservation." });
  }

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();
    const [existing] = await connection.query(
      `SELECT booking_id FROM plot_reservations
       WHERE plot_id = ? AND (
         (status = 'pending' AND expires_at > UTC_TIMESTAMP(3))
         OR status = 'payment_verified'
       ) FOR UPDATE`,
      [booking.plotId]
    );
    if (existing.length) {
      await connection.rollback();
      return res.status(409).json({ message: "This plot is already reserved. Please refresh plot availability." });
    }

    const bookedOn = new Date().toISOString().slice(0, 10);
    const bookingData = {
      bookingId: booking.bookingId,
      plotId: plot.id,
      bookedOn,
      installments: buildInstallmentPlan(plot, bookedOn),
    };

    await connection.query(
      `INSERT INTO plot_reservations
         (booking_id, user_id, plot_id, booking_data, status, reserved_at, expires_at)
       VALUES (?, ?, ?, ?, 'pending', UTC_TIMESTAMP(3), DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 72 HOUR))`,
      [booking.bookingId, req.customer.id, booking.plotId, JSON.stringify(bookingData)]
    );
    await connection.commit();

    const [rows] = await db.query(
      "SELECT * FROM plot_reservations WHERE booking_id = ? AND user_id = ?",
      [booking.bookingId, req.customer.id]
    );
    res.status(201).json({ booking: serializeReservation(rows[0]) });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Could not roll back reservation transaction:", rollbackError);
      }
    }
    console.error("Could not create reservation:", error);
    res.status(500).json({ message: "Could not create reservation. Please try again." });
  } finally {
    if (connection) connection.release();
  }
});

app.post("/api/reservations/:bookingId/cancel", requireCustomer, async (req, res) => {
  try {
    const [result] = await db.query(
      `UPDATE plot_reservations
       SET cancel_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE)
       WHERE booking_id = ? AND user_id = ?
         AND status IN ('pending', 'payment_verified')
         AND cancel_at IS NULL
         AND (status = 'payment_verified' OR expires_at > UTC_TIMESTAMP(3))`,
      [req.params.bookingId, req.customer.id]
    );
    if (!result.affectedRows) {
      return res.status(409).json({ message: "This reservation can no longer be cancelled." });
    }
    const [rows] = await db.query(
      "SELECT * FROM plot_reservations WHERE booking_id = ? AND user_id = ?",
      [req.params.bookingId, req.customer.id]
    );
    res.json({ booking: serializeReservation(rows[0]) });
  } catch (error) {
    console.error("Could not request reservation cancellation:", error);
    res.status(500).json({ message: "Could not request cancellation." });
  }
});

app.post("/api/reservations/:bookingId/undo-cancel", requireCustomer, async (req, res) => {
  try {
    const [result] = await db.query(
      `UPDATE plot_reservations SET cancel_at = NULL
       WHERE booking_id = ? AND user_id = ?
         AND status IN ('pending', 'payment_verified')
         AND cancel_at > UTC_TIMESTAMP(3)`,
      [req.params.bookingId, req.customer.id]
    );
    if (!result.affectedRows) {
      return res.status(409).json({ message: "This cancellation request can no longer be withdrawn." });
    }
    const [rows] = await db.query(
      "SELECT * FROM plot_reservations WHERE booking_id = ? AND user_id = ?",
      [req.params.bookingId, req.customer.id]
    );
    res.json({ booking: serializeReservation(rows[0]) });
  } catch (error) {
    console.error("Could not withdraw reservation cancellation:", error);
    res.status(500).json({ message: "Could not withdraw cancellation." });
  }
});

app.get("/api/admin/reservations", requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT r.booking_id AS bookingId, r.plot_id AS plotId, r.status,
              r.reserved_at AS reservedAt, r.expires_at AS expiresAt,
              r.extension_used AS extensionUsed, r.payment_verified_at AS paymentVerifiedAt,
              u.full_name AS customerName, u.email AS customerEmail
       FROM plot_reservations r
       JOIN users u ON u.id = r.user_id
       WHERE r.status = 'pending'
       ORDER BY r.reserved_at`
    );
    res.json({ reservations: rows });
  } catch (error) {
    console.error("Could not load admin reservations:", error);
    res.status(500).json({ message: "Could not load reservations." });
  }
});

app.post("/api/admin/reservations/:bookingId/payment-verified", requireAdmin, async (req, res) => {
  try {
    const [result] = await db.query(
      `UPDATE plot_reservations
       SET status = 'payment_verified', payment_verified_at = UTC_TIMESTAMP(3)
       WHERE booking_id = ? AND status = 'pending'
         AND expires_at > UTC_TIMESTAMP(3) AND cancel_at IS NULL`,
      [req.params.bookingId]
    );
    if (!result.affectedRows) {
      return res.status(409).json({ message: "Reservation is not pending, has expired, or has a cancellation request." });
    }
    res.json({ message: "Payment verified. The reservation will no longer expire automatically." });
  } catch (error) {
    console.error("Could not verify reservation payment:", error);
    res.status(500).json({ message: "Could not verify payment." });
  }
});

app.post("/api/admin/reservations/:bookingId/extension", requireAdmin, async (req, res) => {
  try {
    const [result] = await db.query(
      `UPDATE plot_reservations
       SET expires_at = DATE_ADD(expires_at, INTERVAL 24 HOUR), extension_used = 1
       WHERE booking_id = ? AND status = 'pending'
         AND expires_at > UTC_TIMESTAMP(3) AND extension_used = 0 AND cancel_at IS NULL`,
      [req.params.bookingId]
    );
    if (!result.affectedRows) {
      return res.status(409).json({ message: "Extension is unavailable: the reservation may be expired, verified, cancelled, or already extended." });
    }
    const [rows] = await db.query(
      "SELECT expires_at AS expiresAt FROM plot_reservations WHERE booking_id = ?",
      [req.params.bookingId]
    );
    res.json({
      message: "One-time 24-hour extension approved.",
      expiresAt: new Date(rows[0].expiresAt).toISOString(),
    });
  } catch (error) {
    console.error("Could not approve reservation extension:", error);
    res.status(500).json({ message: "Could not approve extension." });
  }
});

app.get("/api/certificates", requireCustomer, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, society_name AS societyName, document_type AS documentType,
              title, issuing_authority AS issuingAuthority, approval_number AS approvalNumber,
              verification_status AS verificationStatus, rejection_reason AS rejectionReason
       FROM certificate_documents
       ORDER BY society_name, document_type, title`
    );
    res.json({ certificates: rows });
  } catch (error) {
    console.error("Could not load society certificates:", error);
    res.status(500).json({ message: "Could not load society documents." });
  }
});

app.get("/api/certificates/:id/file", requireCustomer, async (req, res) => {
  const certificateId = Number(req.params.id);
  if (!Number.isSafeInteger(certificateId) || certificateId < 1) {
    return res.status(404).json({ message: "Certificate not found." });
  }
  try {
    const [rows] = await db.query(
      `SELECT mime_type AS mimeType, file_data AS fileData
       FROM certificate_documents
       WHERE id = ? AND verification_status = 'verified' AND file_data IS NOT NULL`,
      [certificateId]
    );
    if (!rows.length) return res.status(404).json({ message: "Verified certificate not found." });

    await recordCertificateView(req, certificateId, "customer", req.customer.id);
    res.set("Cache-Control", "private, no-store, max-age=0");
    res.set("Pragma", "no-cache");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    res.set("Content-Disposition", "inline");
    res.type(rows[0].mimeType).send(rows[0].fileData);
  } catch (error) {
    console.error(`Could not serve verified certificate ${certificateId}:`, error);
    res.status(500).json({ message: "Could not open this certificate." });
  }
});

app.get("/api/admin/certificates", requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, society_name AS societyName, document_type AS documentType,
              title, issuing_authority AS issuingAuthority, approval_number AS approvalNumber,
              verification_status AS verificationStatus, rejection_reason AS rejectionReason,
              file_name AS fileName, file_data IS NOT NULL AS hasFile,
              uploaded_by AS uploadedBy, reviewed_by AS reviewedBy,
              reviewed_at AS reviewedAt, created_at AS createdAt
       FROM certificate_documents
       ORDER BY updated_at DESC`
    );
    res.json({ certificates: rows });
  } catch (error) {
    console.error("Could not load admin certificate records:", error);
    res.status(500).json({ message: "Could not load certificate records." });
  }
});

app.post("/api/admin/certificates", requireAdmin, async (req, res) => {
  const metadata = normalizeCertificateMetadata(req.body);
  if (!metadata) {
    return res.status(400).json({
      message: "Provide a society, supported document type, title, issuing authority, and approval number.",
    });
  }
  try {
    const uploadedBy = String(req.get("x-admin-name") || "admin").trim().slice(0, 100) || "admin";
    const [result] = await db.query(
      `INSERT INTO certificate_documents
         (society_name, document_type, title, issuing_authority, approval_number, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        metadata.societyName,
        metadata.documentType,
        metadata.title,
        metadata.issuingAuthority,
        metadata.approvalNumber,
        uploadedBy,
      ]
    );
    res.status(201).json({
      id: result.insertId,
      verificationStatus: "pending",
      message: "Certificate record created. Upload its PDF or image before verification.",
    });
  } catch (error) {
    console.error("Could not create certificate record:", error);
    res.status(500).json({ message: "Could not create certificate record." });
  }
});

app.put("/api/admin/certificates/:id", requireAdmin, async (req, res) => {
  const certificateId = Number(req.params.id);
  const metadata = normalizeCertificateMetadata(req.body);
  if (!Number.isSafeInteger(certificateId) || certificateId < 1) {
    return res.status(404).json({ message: "Certificate not found." });
  }
  if (!metadata) return res.status(400).json({ message: "Certificate metadata is invalid." });
  try {
    const [existing] = await db.query("SELECT id FROM certificate_documents WHERE id = ?", [certificateId]);
    if (!existing.length) return res.status(404).json({ message: "Certificate not found." });

    const reviewedBy = String(req.get("x-admin-name") || "admin").trim().slice(0, 100) || "admin";
    await db.query(
      `UPDATE certificate_documents
       SET society_name = ?, document_type = ?, title = ?, issuing_authority = ?,
           approval_number = ?, verification_status = 'pending', rejection_reason = NULL,
           reviewed_by = NULL, reviewed_at = NULL
       WHERE id = ?`,
      [
        metadata.societyName,
        metadata.documentType,
        metadata.title,
        metadata.issuingAuthority,
        metadata.approvalNumber,
        certificateId,
      ]
    );
    res.json({ id: certificateId, verificationStatus: "pending", updatedBy: reviewedBy });
  } catch (error) {
    console.error(`Could not update certificate ${certificateId}:`, error);
    res.status(500).json({ message: "Could not update certificate." });
  }
});

app.put(
  "/api/admin/certificates/:id/file",
  requireAdmin,
  express.raw({ type: ["application/pdf", "image/png", "image/jpeg"], limit: "20mb" }),
  async (req, res) => {
    const certificateId = Number(req.params.id);
    if (!Number.isSafeInteger(certificateId) || certificateId < 1) {
      return res.status(404).json({ message: "Certificate not found." });
    }
    const mimeType = certificateMimeType(req, req.body);
    if (!mimeType) {
      return res.status(400).json({ message: "Upload a valid PDF, PNG, or JPEG certificate." });
    }
    try {
      const fileName = certificateFileName(req);
      const [result] = await db.query(
        `UPDATE certificate_documents
         SET file_name = ?, mime_type = ?, file_data = ?,
             verification_status = 'pending', rejection_reason = NULL,
             reviewed_by = NULL, reviewed_at = NULL
         WHERE id = ?`,
        [fileName, mimeType, req.body, certificateId]
      );
      if (!result.affectedRows) {
        const [existing] = await db.query("SELECT id FROM certificate_documents WHERE id = ?", [certificateId]);
        if (!existing.length) return res.status(404).json({ message: "Certificate not found." });
      }
      res.json({
        id: certificateId,
        verificationStatus: "pending",
        message: "File uploaded. The document must be verified again before customers can view it.",
      });
    } catch (error) {
      console.error(`Could not upload certificate file ${certificateId}:`, error);
      res.status(500).json({ message: "Could not upload certificate file." });
    }
  }
);

app.post("/api/admin/certificates/:id/verify", requireAdmin, async (req, res) => {
  const certificateId = Number(req.params.id);
  if (!Number.isSafeInteger(certificateId) || certificateId < 1) {
    return res.status(404).json({ message: "Certificate not found." });
  }
  try {
    const reviewedBy = String(req.get("x-admin-name") || "admin").trim().slice(0, 100) || "admin";
    const [result] = await db.query(
      `UPDATE certificate_documents
       SET verification_status = 'verified', rejection_reason = NULL,
           reviewed_by = ?, reviewed_at = UTC_TIMESTAMP(3)
       WHERE id = ? AND file_data IS NOT NULL AND mime_type IS NOT NULL`,
      [reviewedBy, certificateId]
    );
    if (!result.affectedRows) {
      const [existing] = await db.query(
        "SELECT id, file_data IS NOT NULL AS hasFile FROM certificate_documents WHERE id = ?",
        [certificateId]
      );
      if (!existing.length) return res.status(404).json({ message: "Certificate not found." });
      if (!existing[0].hasFile) return res.status(409).json({ message: "Upload a document file before verifying it." });
    }
    res.json({ id: certificateId, verificationStatus: "verified" });
  } catch (error) {
    console.error(`Could not verify certificate ${certificateId}:`, error);
    res.status(500).json({ message: "Could not verify certificate." });
  }
});

app.post("/api/admin/certificates/:id/reject", requireAdmin, async (req, res) => {
  const certificateId = Number(req.params.id);
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!Number.isSafeInteger(certificateId) || certificateId < 1) {
    return res.status(404).json({ message: "Certificate not found." });
  }
  if (!reason || reason.length > 1000) {
    return res.status(400).json({ message: "Provide a rejection reason of up to 1000 characters." });
  }
  try {
    const reviewedBy = String(req.get("x-admin-name") || "admin").trim().slice(0, 100) || "admin";
    const [result] = await db.query(
      `UPDATE certificate_documents
       SET verification_status = 'rejected', rejection_reason = ?,
           reviewed_by = ?, reviewed_at = UTC_TIMESTAMP(3)
       WHERE id = ?`,
      [reason, reviewedBy, certificateId]
    );
    if (!result.affectedRows) {
      const [existing] = await db.query("SELECT id FROM certificate_documents WHERE id = ?", [certificateId]);
      if (!existing.length) return res.status(404).json({ message: "Certificate not found." });
    }
    res.json({ id: certificateId, verificationStatus: "rejected" });
  } catch (error) {
    console.error(`Could not reject certificate ${certificateId}:`, error);
    res.status(500).json({ message: "Could not reject certificate." });
  }
});

app.get("/api/admin/certificates/:id/file", requireAdmin, async (req, res) => {
  const certificateId = Number(req.params.id);
  if (!Number.isSafeInteger(certificateId) || certificateId < 1) {
    return res.status(404).json({ message: "Certificate not found." });
  }
  try {
    const [rows] = await db.query(
      `SELECT file_name AS fileName, mime_type AS mimeType, file_data AS fileData
       FROM certificate_documents WHERE id = ? AND file_data IS NOT NULL`,
      [certificateId]
    );
    if (!rows.length) return res.status(404).json({ message: "Certificate file not found." });
    await recordCertificateView(req, certificateId, "admin");
    res.set("Cache-Control", "private, no-store, max-age=0");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Content-Disposition", `attachment; filename="${rows[0].fileName}"`);
    res.type(rows[0].mimeType).send(rows[0].fileData);
  } catch (error) {
    console.error(`Could not serve original certificate ${certificateId}:`, error);
    res.status(500).json({ message: "Could not load original certificate." });
  }
});

app.get("/api/admin/certificates/:id/views", requireAdmin, async (req, res) => {
  const certificateId = Number(req.params.id);
  if (!Number.isSafeInteger(certificateId) || certificateId < 1) {
    return res.status(404).json({ message: "Certificate not found." });
  }
  try {
    const [rows] = await db.query(
      `SELECT v.viewer_type AS viewerType, v.customer_id AS customerId,
              u.full_name AS customerName, v.admin_name AS adminName,
              v.viewed_at AS viewedAt, v.ip_address AS ipAddress,
              v.user_agent AS userAgent
       FROM certificate_views v
       LEFT JOIN users u ON u.id = v.customer_id
       WHERE v.certificate_id = ? ORDER BY v.viewed_at DESC`,
      [certificateId]
    );
    res.json({ views: rows });
  } catch (error) {
    console.error(`Could not load certificate views for ${certificateId}:`, error);
    res.status(500).json({ message: "Could not load certificate view activity." });
  }
});

const PORT = process.env.PORT || 5000;
async function startServer() {
  await db.query(
    `CREATE TABLE IF NOT EXISTS plot_reservations (
      booking_id VARCHAR(100) PRIMARY KEY,
      user_id INT NOT NULL,
      plot_id VARCHAR(30) NOT NULL,
      booking_data JSON NOT NULL,
      status ENUM('pending', 'payment_verified', 'cancelled') NOT NULL DEFAULT 'pending',
      reserved_at DATETIME(3) NOT NULL,
      expires_at DATETIME(3) NOT NULL,
      extension_used TINYINT(1) NOT NULL DEFAULT 0,
      payment_verified_at DATETIME(3) NULL,
      cancel_at DATETIME(3) NULL,
      cancellation_reason ENUM('customer', 'expiry') NULL,
      cancelled_at DATETIME(3) NULL,
      reminder_24_sent_at DATETIME(3) NULL,
      reminder_48_sent_at DATETIME(3) NULL,
      expiry_notice_sent_at DATETIME(3) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_plot_reservations_plot_status (plot_id, status, expires_at),
      INDEX idx_plot_reservations_due (status, expires_at),
      CONSTRAINT fk_plot_reservations_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS certificate_documents (
      id INT AUTO_INCREMENT PRIMARY KEY,
      society_name VARCHAR(120) NOT NULL,
      document_type ENUM('society_registration', 'noc', 'approved_layout_plan', 'land_ownership') NOT NULL,
      title VARCHAR(180) NOT NULL,
      issuing_authority VARCHAR(180) NOT NULL,
      approval_number VARCHAR(120) NOT NULL,
      verification_status ENUM('pending', 'verified', 'rejected') NOT NULL DEFAULT 'pending',
      rejection_reason VARCHAR(1000) NULL,
      file_name VARCHAR(180) NULL,
      mime_type ENUM('application/pdf', 'image/png', 'image/jpeg') NULL,
      file_data LONGBLOB NULL,
      uploaded_by VARCHAR(100) NOT NULL,
      reviewed_by VARCHAR(100) NULL,
      reviewed_at DATETIME(3) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_certificate_documents_status_society (verification_status, society_name)
    )`
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS certificate_views (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      certificate_id INT NOT NULL,
      customer_id INT NULL,
      viewer_type ENUM('customer', 'admin') NOT NULL,
      admin_name VARCHAR(100) NULL,
      viewed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      ip_address VARCHAR(45) NULL,
      user_agent VARCHAR(512) NULL,
      INDEX idx_certificate_views_document_time (certificate_id, viewed_at),
      INDEX idx_certificate_views_customer_time (customer_id, viewed_at),
      CONSTRAINT fk_certificate_views_document FOREIGN KEY (certificate_id) REFERENCES certificate_documents(id) ON DELETE CASCADE,
      CONSTRAINT fk_certificate_views_customer FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE SET NULL
    )`
  );
  app.listen(PORT, () => {
    console.log(`PlotAxis Server running on http://localhost:${PORT}`);
    runReservationExpiryJob();
    setInterval(runReservationExpiryJob, 10_000);
  });
}

startServer().catch(error => {
  console.error("Could not start PlotAxis Server:", error);
  process.exitCode = 1;
});
