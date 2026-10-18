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
const temporaryMedia = new Map();
const MEDIA_TTL_MS = 15 * 60 * 1000;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));

// Instagram must be able to fetch this unguessable, temporary media URL.
// No access tokens or credentials are exposed by this route.
app.get("/_media/:id", (req, res) => {
  const item = temporaryMedia.get(req.params.id);
  if (!item || item.expiresAt <= Date.now()) {
    temporaryMedia.delete(req.params.id);
    return res.status(404).send("Media expired");
  }
  res.set({
    "Content-Type": item.mimetype,
    "Content-Length": String(item.buffer.length),
    "Cache-Control": "public, max-age=60",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline"
  });
  return res.end(item.buffer);
});

app.use("/api", rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "درخواست‌های زیادی ارسال شده است؛ کمی بعد دوباره تلاش کنید." }
}));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith("/api/") || req.path.startsWith("/_media/") || /\.(css|js|png|jpe?g|gif|svg|ico|webp)$/i.test(req.path),
  message: "تعداد درخواست‌ها زیاد است؛ کمی بعد دوباره تلاش کنید."
}));

// HTTP Basic Auth protects the web panel and API. Temporary Instagram media URLs are separate.
app.use((req, res, next) => {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) return res.status(503).send("Authentication is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD in Render Environment.");

  res.set("Cache-Control", "no-store");
  const match = (req.headers.authorization || "").match(/^Basic\s+([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) {
    res.set("WWW-Authenticate", 'Basic realm="Publisher Panel", charset="UTF-8"');
    return res.status(401).send("برای ورود به پنل، نام کاربری و رمز عبور را وارد کنید.");
  }
  let supplied;
  try { supplied = Buffer.from(match[1], "base64").toString("utf8"); }
  catch { return res.status(401).send("نام کاربری یا رمز عبور نادرست است."); }
  const colon = supplied.indexOf(":");
  const safeEqual = (a, b) => {
    const aa = Buffer.from(a);
    const bb = Buffer.from(b);
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
  };
  if (colon < 0 || !safeEqual(supplied.slice(0, colon), username) || !safeEqual(supplied.slice(colon + 1), password)) {
    res.set("WWW-Authenticate", 'Basic realm="Publisher Panel", charset="UTF-8"');
    return res.status(401).send("نام کاربری یا رمز عبور نادرست است.");
  }
  next();
});

app.use(express.json({ limit: "1mb" }));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/quicktime", "video/webm"];
    if (!allowed.includes(file.mimetype)) return cb(new Error("فرمت فایل پشتیبانی نمی‌شود. عکس JPG/PNG/WEBP/GIF یا ویدئوی MP4/MOV/WEBM انتخاب کنید."));
    cb(null, true);
  }
});
app.use(express.static(publicDir, { index: "index.html" }));

function ready(keyNames) { return keyNames.every((key) => Boolean(process.env[key])); }
function getConfigs() {
  return {
    telegram: { configured: ready(["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) },
    bale: { configured: ready(["BALE_BOT_TOKEN", "BALE_CHAT_ID"]) },
    eitaa: { configured: ready(["EITAA_BOT_TOKEN", "EITAA_CHAT_ID"]) },
    instagram: { configured: ready(["INSTAGRAM_ACCESS_TOKEN", "INSTAGRAM_USER_ID", "PUBLIC_BASE_URL"]) }
  };
}
function apiError(data, status) {
  const detail = data?.description || data?.error?.message || data?.message || `API error (${status})`;
  return new Error(String(detail).slice(0, 500));
}

async function botApiRequest(endpointBase, method, fields, file, fileField) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== "") form.append(key, String(value));
  }
  if (file) form.append(fileField, new Blob([file.buffer], { type: file.mimetype }), file.originalname || "upload");
  const response = await fetch(`${endpointBase}${method}`, {
    method: "POST", body: form, signal: AbortSignal.timeout(90000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false || data.status === "error") throw apiError(data, response.status);
  if (data.ok === true && data.result !== undefined) return data.result;
  if (data.result !== undefined) return data.result;
  return data;
}

async function telegramSend(text, file) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("تنظیمات تلگرام در Render کامل نشده است.");
  const method = !file ? "sendMessage" : file.mimetype.startsWith("image/") ? "sendPhoto" : "sendVideo";
  if (file?.mimetype.startsWith("image/") && file.size > 10 * 1024 * 1024) throw new Error("حجم عکس تلگرام باید حداکثر ۱۰ مگابایت باشد.");
  return botApiRequest(`https://api.telegram.org/bot${token}/`, method,
    { chat_id: chatId, ...(file ? { caption: text } : { text, disable_web_page_preview: false }) },
    file, file ? (file.mimetype.startsWith("image/") ? "photo" : "video") : "");
}

async function baleSend(text, file) {
  const token = process.env.BALE_BOT_TOKEN;
  const chatId = process.env.BALE_CHAT_ID;
  if (!token || !chatId) throw new Error("توکن ربات یا شناسه کانال بله در Render تنظیم نشده است.");
  const method = !file ? "sendMessage" : file.mimetype.startsWith("image/") ? "sendPhoto" : "sendVideo";
  return botApiRequest(`https://tapi.bale.ai/bot${token}/`, method,
    { chat_id: chatId, ...(file ? { caption: text } : { text, disable_web_page_preview: false }) },
    file, file ? (file.mimetype.startsWith("image/") ? "photo" : "video") : "");
}

async function eitaaSend(text, file) {
  const token = process.env.EITAA_BOT_TOKEN;
  const chatId = process.env.EITAA_CHAT_ID;
  if (!token || !chatId) throw new Error("توکن ایتایار یا شناسه کانال ایتا در Render تنظیم نشده است.");
  const form = new FormData();
  form.append("chat_id", chatId);
  if (file) {
    if (text) form.append("caption", text);
    form.append("file", new Blob([file.buffer], { type: file.mimetype }), file.originalname || "upload");
  } else {
    form.append("text", text);
  }
  const method = file ? "sendFile" : "sendMessage";
  const response = await fetch(`https://eitaayar.ir/api/${token}/${method}`, { method: "POST", body: form, signal: AbortSignal.timeout(90000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false || data.status === "error") throw apiError(data, response.status);
  if (data.ok === true && data.result === undefined && data.status !== "success") throw apiError(data, response.status);
  return data;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function instagramRequest(pathname, params, method = "POST") {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const base = (process.env.INSTAGRAM_GRAPH_BASE || "https://graph.instagram.com/v26.0").replace(/\/$/, "");
  const url = new URL(`${base}/${pathname.replace(/^\//, "")}`);
  const headers = {};
  let body;
  if (method === "GET") {
    for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, String(value));
    url.searchParams.set("access_token", token);
  } else {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) if (value !== undefined && value !== null) form.set(key, String(value));
    form.set("access_token", token);
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = form;
  }
  const response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(90000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw apiError(data, response.status);
  return data;
}

async function instagramSend(text, file) {
  const igUserId = process.env.INSTAGRAM_USER_ID;
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const publicBase = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
  if (!igUserId || !token || !publicBase) throw new Error("INSTAGRAM_USER_ID، INSTAGRAM_ACCESS_TOKEN و PUBLIC_BASE_URL باید در Render تنظیم شوند.");
  if (!file) throw new Error("اینستاگرام برای پست عادی به عکس یا ویدئو نیاز دارد؛ پیام متنی تنها قابل انتشار نیست.");
  if (file.mimetype.startsWith("image/") && file.mimetype !== "image/jpeg") throw new Error("برای اینستاگرام عکس باید JPG/JPEG باشد. سایر مقصدها جداگانه منتشر می‌شوند.");
  if (file.mimetype === "image/jpeg" && file.size > 8 * 1024 * 1024) throw new Error("عکس اینستاگرام باید حداکثر ۸ مگابایت باشد.");
  if (!file.mimetype.startsWith("image/") && file.mimetype !== "video/mp4" && file.mimetype !== "video/quicktime") throw new Error("برای اینستاگرام ویدئو باید MP4 یا MOV باشد.");

  const id = crypto.randomBytes(24).toString("hex");
  temporaryMedia.set(id, { buffer: file.buffer, mimetype: file.mimetype, expiresAt: Date.now() + MEDIA_TTL_MS });
  const mediaUrl = `${publicBase}/_media/${id}`;
  try {
    const params = file.mimetype.startsWith("image/")
      ? { image_url: mediaUrl, caption: text || "" }
      : { media_type: "REELS", video_url: mediaUrl, caption: text || "", share_to_feed: "true" };
    const container = await instagramRequest(`${igUserId}/media`, params);
    if (!container.id) throw new Error("اینستاگرام شناسه پردازش رسانه را برنگرداند.");

    // Video processing is asynchronous; wait for Meta to finish before publishing.
    if (file.mimetype.startsWith("video/")) {
      let readyToPublish = false;
      for (let attempt = 0; attempt < 24; attempt++) {
        await sleep(5000);
        const status = await instagramRequest(container.id, { fields: "status_code" }, "GET");
        if (status.status_code === "FINISHED") { readyToPublish = true; break; }
        if (status.status_code === "ERROR" || status.status_code === "EXPIRED") throw new Error(`پردازش ویدئو در اینستاگرام ناموفق بود (${status.status_code}).`);
      }
      if (!readyToPublish) throw new Error("پردازش ویدئو بیش از دو دقیقه طول کشید؛ دوباره وضعیت را بررسی کن.");
    }
    const published = await instagramRequest(`${igUserId}/media_publish`, { creation_id: container.id });
    return published;
  } finally {
    // Leave a short grace period for Meta to finish fetching the source URL.
    setTimeout(() => temporaryMedia.delete(id), 2 * 60 * 1000).unref?.();
  }
}

app.get("/api/status", (_req, res) => {
  res.set("Cache-Control", "no-store");
  const platforms = getConfigs();
  res.json({ ok: true, platforms });
});

app.post("/api/publish-multi", (req, res) => {
  upload.single("media")(req, res, async (uploadError) => {
    if (uploadError) {
      const tooLarge = uploadError.code === "LIMIT_FILE_SIZE";
      return res.status(tooLarge ? 413 : 400).json({ ok: false, error: tooLarge ? "حجم فایل نباید بیشتر از ۵۰ مگابایت باشد." : uploadError.message || "آپلود فایل ناموفق بود." });
    }
    const text = typeof req.body.caption === "string" ? req.body.caption.trim() : "";
    let targets = [];
    try { targets = JSON.parse(req.body.targets || "[]"); } catch { /* invalid list */ }
    const allowedTargets = ["telegram", "bale", "eitaa", "instagram"];
    targets = [...new Set(Array.isArray(targets) ? targets.filter((item) => allowedTargets.includes(item)) : [])];
    if (!targets.length) return res.status(400).json({ ok: false, error: "حداقل یک مقصد انتشار انتخاب کن." });
    if (!text && !req.file) return res.status(400).json({ ok: false, error: "متن پیام یا عکس/فیلم را انتخاب کن." });
    if (req.file && text.length > 1024) return res.status(400).json({ ok: false, error: "متن همراه عکس/فیلم حداکثر ۱۰۲۴ نویسه است." });
    if (!req.file && text.length > 4096) return res.status(400).json({ ok: false, error: "متن پیام حداکثر ۴۰۹۶ نویسه است." });

    const file = req.file || null;
    const functions = { telegram: telegramSend, bale: baleSend, eitaa: eitaaSend, instagram: instagramSend };
    const config = getConfigs();
    const results = await Promise.all(targets.map(async (target) => {
      if (!config[target].configured) return { target, ok: false, message: "تنظیمات این مقصد در Render کامل نشده است." };
      try {
        await functions[target](text, file);
        return { target, ok: true, message: "با موفقیت منتشر شد." };
      } catch (error) {
        console.error(`${target} publish failed:`, error.message);
        return { target, ok: false, message: error.message || "ارسال ناموفق بود." };
      }
    }));
    const successCount = results.filter((item) => item.ok).length;
    return res.status(200).json({ ok: successCount > 0, results, message: `${successCount} از ${results.length} مقصد با موفقیت منتشر شد.` });
  });
});

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

app.listen(port, "0.0.0.0", () => console.log("Multi-platform Publisher is running."));
