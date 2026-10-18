require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");

const app = express();
const port = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, "public");

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));

// Limit API traffic before authentication, including invalid login attempts.
app.use("/api", rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "درخواست‌های زیادی ارسال شده است؛ کمی بعد دوباره تلاش کنید." }
}));

// Also limit repeated authentication attempts on the main site.
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith("/api/") || /\.(css|js|png|jpe?g|gif|svg|ico|webp)$/i.test(req.path),
  message: "تعداد درخواست‌ها زیاد است؛ کمی بعد دوباره تلاش کنید."
}));

// HTTP Basic Auth protects the site and every API endpoint.
app.use((req, res, next) => {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) {
    return res.status(503).send("Authentication is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD in Render Environment.");
  }

  res.set("Cache-Control", "no-store");
  const match = (req.headers.authorization || "").match(/^Basic\s+([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) {
    res.set("WWW-Authenticate", 'Basic realm="Telegram Publisher", charset="UTF-8"');
    return res.status(401).send("برای ورود به پنل، نام کاربری و رمز عبور را وارد کنید.");
  }

  let supplied;
  try { supplied = Buffer.from(match[1], "base64").toString("utf8"); }
  catch { return res.status(401).send("نام کاربری یا رمز عبور نادرست است."); }
  const colon = supplied.indexOf(":");
  if (colon < 0) {
    res.set("WWW-Authenticate", 'Basic realm="Telegram Publisher", charset="UTF-8"');
    return res.status(401).send("نام کاربری یا رمز عبور نادرست است.");
  }

  const safeEqual = (a, b) => {
    const aa = Buffer.from(a);
    const bb = Buffer.from(b);
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
  };
  if (!safeEqual(supplied.slice(0, colon), username) || !safeEqual(supplied.slice(colon + 1), password)) {
    res.set("WWW-Authenticate", 'Basic realm="Telegram Publisher", charset="UTF-8"');
    return res.status(401).send("نام کاربری یا رمز عبور نادرست است.");
  }
  next();
});

app.use(express.json({ limit: "1mb" }));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/quicktime", "video/webm"];
    if (!allowed.includes(file.mimetype)) return cb(new Error("فرمت فایل پشتیبانی نمی‌شود. عکس JPG/PNG/WEBP/GIF یا ویدئوی MP4/MOV/WEBM انتخاب کنید."));
    cb(null, true);
  }
});
app.use(express.static(publicDir, { index: "index.html" }));

function telegramConfigIsReady() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

async function telegramRequest(method, fields, file) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== "") form.append(key, String(value));
  }
  if (file) {
    form.append(file.fieldName, new Blob([file.buffer], { type: file.mimetype }), file.originalname || "upload");
  }
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram API error (${response.status})`);
  return data.result;
}

app.get("/api/status", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, configured: telegramConfigIsReady(), message: telegramConfigIsReady() ? "اتصال تلگرام تنظیم شده است." : "متغیرهای تلگرام در Render تنظیم نشده‌اند." });
});

app.post("/api/publish", async (req, res) => {
  if (!telegramConfigIsReady()) return res.status(503).json({ ok: false, error: "تنظیمات تلگرام در Render کامل نشده است." });
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) return res.status(400).json({ ok: false, error: "متن پیام را وارد کنید." });
  if (text.length > 4096) return res.status(400).json({ ok: false, error: "متن پیام نباید بیشتر از ۴۰۹۶ نویسه باشد." });
  try {
    const result = await telegramRequest("sendMessage", { chat_id: process.env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: false });
    res.json({ ok: true, message: "پیام با موفقیت در تلگرام منتشر شد.", messageId: result.message_id });
  } catch (error) {
    console.error("Telegram text publish failed:", error.message);
    res.status(502).json({ ok: false, error: "ارسال به تلگرام انجام نشد. گزارش سرور را بررسی کنید." });
  }
});

app.post("/api/publish-media", (req, res) => {
  upload.single("media")(req, res, async (uploadError) => {
    if (uploadError) {
      const tooLarge = uploadError.code === "LIMIT_FILE_SIZE";
      return res.status(tooLarge ? 413 : 400).json({ ok: false, error: tooLarge ? "حجم فایل بیش از ۵۰ مگابایت است." : uploadError.message || "آپلود فایل ناموفق بود." });
    }
    if (!telegramConfigIsReady()) return res.status(503).json({ ok: false, error: "تنظیمات تلگرام در Render کامل نشده است." });
    if (!req.file) return res.status(400).json({ ok: false, error: "ابتدا عکس یا فیلم را انتخاب کنید." });

    const caption = typeof req.body.caption === "string" ? req.body.caption.trim() : "";
    if (caption.length > 1024) return res.status(400).json({ ok: false, error: "متن همراه عکس یا فیلم نباید بیشتر از ۱۰۲۴ نویسه باشد." });

    const isImage = req.file.mimetype.startsWith("image/");
    const isVideo = req.file.mimetype.startsWith("video/");
    if (isImage && req.file.size > 10 * 1024 * 1024) return res.status(413).json({ ok: false, error: "حجم عکس برای ارسال مستقیم به تلگرام نباید بیشتر از ۱۰ مگابایت باشد." });
    if (isVideo && req.file.size > 50 * 1024 * 1024) return res.status(413).json({ ok: false, error: "حجم فیلم نباید بیشتر از ۵۰ مگابایت باشد." });
    if (!isImage && !isVideo) return res.status(400).json({ ok: false, error: "نوع فایل پشتیبانی نمی‌شود." });

    try {
      const method = isImage ? "sendPhoto" : "sendVideo";
      const fieldName = isImage ? "photo" : "video";
      const result = await telegramRequest(method, { chat_id: process.env.TELEGRAM_CHAT_ID, caption }, {
        fieldName, buffer: req.file.buffer, mimetype: req.file.mimetype, originalname: req.file.originalname
      });
      res.json({ ok: true, message: isImage ? "عکس با موفقیت در تلگرام منتشر شد." : "فیلم با موفقیت در تلگرام منتشر شد.", messageId: result.message_id });
    } catch (error) {
      console.error("Telegram media publish failed:", error.message);
      res.status(502).json({ ok: false, error: "ارسال فایل به تلگرام انجام نشد. فرمت و حجم فایل را بررسی کنید." });
    }
  });
});

// Express 5-compatible fallback; no '*' route pattern.
app.use((req, res, next) => {
  if (req.path === "/api" || req.path.startsWith("/api/")) return res.status(404).json({ ok: false, error: "مسیر API پیدا نشد." });
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(404).send("Not found");
  res.sendFile(path.join(publicDir, "index.html"), (err) => { if (err) next(err); });
});

app.use((err, _req, res, _next) => {
  console.error("Server error:", err.message);
  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: "خطای داخلی سرور رخ داد." });
});

app.listen(port, "0.0.0.0", () => console.log(`Telegram Publisher listening on port ${port}`));
