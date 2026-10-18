require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const crypto = require("crypto");

const app = express();
const port = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, "public");

// The service must be deployed behind HTTPS (Render provides HTTPS).
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));

// Limit API requests BEFORE authentication so invalid credentials are limited too.
app.use(
  "/api",
  rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      ok: false,
      error: "تعداد درخواست‌ها زیاد است؛ کمی بعد دوباره تلاش کنید."
    }
  })
);

// Limit repeated attempts to open protected pages. Static assets are skipped so
// CSS/JS files do not consume the page-login allowance.
const pageAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => /\.(?:css|js|png|jpe?g|gif|svg|ico|webp|woff2?)$/i.test(req.path),
  message: "تعداد تلاش‌ها زیاد است؛ ۱۵ دقیقه دیگر دوباره تلاش کنید."
});
app.use(pageAuthLimiter);

// HTTP Basic Authentication protects the website and all API routes.
app.use((req, res, next) => {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;

  if (!username || !password) {
    return res.status(503).send(
      "Authentication is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD in Render Environment."
    );
  }

  res.set("Cache-Control", "no-store");
  const header = req.headers.authorization || "";
  const match = header.match(/^Basic\s+([A-Za-z0-9+/]+={0,2})$/i);

  if (!match) {
    res.set(
      "WWW-Authenticate",
      'Basic realm="Telegram Publisher", charset="UTF-8"'
    );
    return res.status(401).send("برای ادامه، نام کاربری و رمز عبور را وارد کنید.");
  }

  let supplied;
  try {
    supplied = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return res.status(401).send("نام کاربری یا رمز عبور نامعتبر است.");
  }

  const separator = supplied.indexOf(":");
  if (separator < 0) {
    res.set(
      "WWW-Authenticate",
      'Basic realm="Telegram Publisher", charset="UTF-8"'
    );
    return res.status(401).send("نام کاربری یا رمز عبور نامعتبر است.");
  }

  const suppliedUser = Buffer.from(supplied.slice(0, separator));
  const suppliedPass = Buffer.from(supplied.slice(separator + 1));
  const expectedUser = Buffer.from(username);
  const expectedPass = Buffer.from(password);

  const safeEqual = (a, b) =>
    a.length === b.length && crypto.timingSafeEqual(a, b);

  if (
    !safeEqual(suppliedUser, expectedUser) ||
    !safeEqual(suppliedPass, expectedPass)
  ) {
    res.set(
      "WWW-Authenticate",
      'Basic realm="Telegram Publisher", charset="UTF-8"'
    );
    return res.status(401).send("نام کاربری یا رمز عبور نامعتبر است.");
  }

  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicDir, { index: "index.html", fallthrough: true }));

function telegramConfigIsReady() {
  return Boolean(
    process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID
  );
}

async function telegramRequest(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000)
    }
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    // Keep detailed Telegram errors in server logs, not in the public response.
    const error = new Error(
      data.description || `Telegram API error (${response.status})`
    );
    error.status = response.status;
    throw error;
  }
  return data.result;
}

app.get("/api/status", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    configured: telegramConfigIsReady(),
    message: telegramConfigIsReady()
      ? "تنظیمات تلگرام وارد شده است."
      : "تنظیمات تلگرام در بخش Environment سرویس Render کامل نشده است."
  });
});

app.post("/api/publish", async (req, res) => {
  if (!telegramConfigIsReady()) {
    return res.status(503).json({
      ok: false,
      error: "تنظیمات تلگرام در Render کامل نشده است."
    });
  }

  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  const imageUrl =
    typeof req.body?.imageUrl === "string" ? req.body.imageUrl.trim() : "";

  if (!text && !imageUrl) {
    return res.status(400).json({
      ok: false,
      error: "متن پست یا نشانی تصویر را وارد کنید."
    });
  }

  if (imageUrl && text.length > 1024) {
    return res.status(400).json({
      ok: false,
      error: "متن همراه تصویر نباید بیشتر از ۱۰۲۴ نویسه باشد."
    });
  }

  if (!imageUrl && text.length > 4096) {
    return res.status(400).json({
      ok: false,
      error: "متن پست نباید بیشتر از ۴۰۹۶ نویسه باشد."
    });
  }

  if (imageUrl) {
    let parsed;
    try {
      parsed = new URL(imageUrl);
    } catch {
      return res.status(400).json({
        ok: false,
        error: "نشانی تصویر معتبر نیست."
      });
    }

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return res.status(400).json({
        ok: false,
        error: "نشانی تصویر باید با http یا https شروع شود."
      });
    }
  }

  try {
    let result;
    if (imageUrl) {
      result = await telegramRequest("sendPhoto", {
        chat_id: process.env.TELEGRAM_CHAT_ID,
        photo: imageUrl,
        caption: text || undefined
      });
    } else {
      result = await telegramRequest("sendMessage", {
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: false
      });
    }

    return res.json({
      ok: true,
      message: "پست با موفقیت به تلگرام ارسال شد.",
      messageId: result.message_id,
      date: result.date
    });
  } catch (error) {
    console.error("Telegram publish failed:", error.message);
    return res.status(502).json({
      ok: false,
      error: "ارسال به تلگرام انجام نشد. گزارش سرور را بررسی کنید."
    });
  }
});

// Express 5-compatible fallback: no wildcard route pattern is used.
app.use((req, res, next) => {
  if (req.path === "/api" || req.path.startsWith("/api/")) {
    return res.status(404).json({ ok: false, error: "مسیر API پیدا نشد." });
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(404).send("Not found");
  }

  return res.sendFile(path.join(publicDir, "index.html"), (err) => {
    if (err) next(err);
  });
});

app.use((err, _req, res, _next) => {
  console.error("Server error:", err.message);
  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: "خطای داخلی سرور رخ داد." });
});

app.listen(port, () => {
  console.log(`Telegram Publisher is running on port ${port}`);
});