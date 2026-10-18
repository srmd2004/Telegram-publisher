require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/api/", rateLimit({ windowMs: 60 * 1000, limit: 20 }));

function telegramConfigIsReady() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

async function telegramRequest(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const description = data.description || `Telegram API error (${response.status})`;
    throw new Error(description);
  }
  return data.result;
}

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    configured: telegramConfigIsReady(),
    message: telegramConfigIsReady()
      ? "تنظیمات تلگرام وارد شده است."
      : "برای اتصال، مقدارهای TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID را در فایل .env تنظیم کنید."
  });
});

app.post("/api/publish", async (req, res) => {
  if (!telegramConfigIsReady()) {
    return res.status(503).json({
      ok: false,
      error: "اتصال تلگرام هنوز تنظیم نشده است. فایل .env را تکمیل و برنامه را دوباره اجرا کنید."
    });
  }

  const text = typeof req.body.text === "string" ? req.body.text.trim() : "";
  const imageUrl = typeof req.body.imageUrl === "string" ? req.body.imageUrl.trim() : "";

  if (!text && !imageUrl) {
    return res.status(400).json({ ok: false, error: "متن پست یا نشانی تصویر را وارد کنید." });
  }
  if (text.length > 4096) {
    return res.status(400).json({ ok: false, error: "متن پست نباید بیشتر از ۴۰۹۶ نویسه باشد." });
  }
  if (imageUrl) {
    let parsed;
    try { parsed = new URL(imageUrl); } catch {
      return res.status(400).json({ ok: false, error: "نشانی تصویر معتبر نیست." });
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return res.status(400).json({ ok: false, error: "نشانی تصویر باید با http یا https شروع شود." });
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

    res.json({
      ok: true,
      message: "پست با موفقیت به تلگرام ارسال شد.",
      messageId: result.message_id,
      date: result.date
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: `ارسال به تلگرام انجام نشد: ${error.message}`
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, () => {
  console.log(`Telegram Publisher is running at http://localhost:${port}`);
});
