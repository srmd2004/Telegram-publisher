const form = document.getElementById("publishForm");
const caption = document.getElementById("caption");
const mediaInput = document.getElementById("mediaFile");
const preview = document.getElementById("preview");
const result = document.getElementById("result");
const button = document.getElementById("publishButton");
const buttonText = document.getElementById("buttonText");
const spinner = document.getElementById("spinner");
const counterText = document.getElementById("counterText");
const statusDot = document.getElementById("statusDot");
const connectionStatus = document.getElementById("connectionStatus");
let previewUrl = null;
const names = { telegram: "تلگرام", bale: "بله", eitaa: "ایتا", instagram: "اینستاگرام" };
const persianDigits = value => String(value).replace(/\d/g, d => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
function updateCounter() {
  counterText.textContent = `${persianDigits(caption.value.length)} نویسه`;
  caption.maxLength = mediaInput.files[0] ? 1024 : 4096;
}
caption.addEventListener("input", updateCounter);
mediaInput.addEventListener("change", () => {
  preview.replaceChildren();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  const file = mediaInput.files[0];
  updateCounter();
  if (!file) { preview.classList.add("hidden"); return; }
  preview.classList.remove("hidden");
  previewUrl = URL.createObjectURL(file);
  const isVideo = file.type.startsWith("video/");
  const media = document.createElement(isVideo ? "video" : "img");
  media.src = previewUrl;
  if (isVideo) { media.muted = true; media.playsInline = true; }
  const meta = document.createElement("div"); meta.className = "file-meta";
  const name = document.createElement("strong"); name.textContent = file.name;
  const size = document.createElement("small"); size.textContent = `${persianDigits((file.size / (1024 * 1024)).toFixed(2))} مگابایت`;
  meta.append(name, size);
  const remove = document.createElement("button"); remove.type = "button"; remove.className = "remove-file"; remove.textContent = "حذف";
  remove.addEventListener("click", () => { mediaInput.value = ""; mediaInput.dispatchEvent(new Event("change")); });
  preview.append(media, meta, remove);
});

async function checkStatus() {
  try {
    const response = await fetch("/api/status", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("status");
    const data = await response.json();
    const platforms = data.platforms || {};
    for (const key of Object.keys(names)) {
      const node = document.getElementById(`state-${key}`);
      const configured = Boolean(platforms[key]?.configured);
      node.textContent = configured ? "تنظیم شده" : "تنظیم نشده";
      node.className = configured ? "state-ready" : "state-missing";
    }
    const count = Object.values(platforms).filter(p => p.configured).length;
    statusDot.className = `dot ${count ? "ok" : "bad"}`;
    connectionStatus.textContent = `${persianDigits(count)} مقصد از ۴ مقصد دارای تنظیمات هستند (این بررسی، اعتبار توکن را آزمایش نمی‌کند).`;
  } catch {
    statusDot.className = "dot bad";
    connectionStatus.textContent = "وضعیت اتصال قابل بررسی نیست؛ صفحه را دوباره بارگذاری کن.";
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  result.className = "result"; result.replaceChildren();
  const file = mediaInput.files[0];
  const text = caption.value.trim();
  const targets = [...form.querySelectorAll('input[name="target"]:checked')].map(el => el.value);
  if (!targets.length) { showError("حداقل یک مقصد انتشار انتخاب کن."); return; }
  if (!file && !text) { showError("متن پیام را بنویس یا یک عکس/فیلم انتخاب کن."); return; }
  if (file && text.length > 1024) { showError("متن همراه عکس یا فیلم حداکثر ۱۰۲۴ نویسه است."); return; }
  if (!file && text.length > 4096) { showError("متن پیام حداکثر ۴۰۹۶ نویسه است."); return; }
  if (file && file.size > 50 * 1024 * 1024) { showError("حجم فایل باید حداکثر ۵۰ مگابایت باشد."); return; }
  button.disabled = true; spinner.classList.remove("hidden"); buttonText.textContent = "در حال انتشار…";
  try {
    const data = new FormData();
    data.append("targets", JSON.stringify(targets));
    data.append("caption", text);
    if (file) data.append("media", file, file.name);
    const response = await fetch("/api/publish-multi", { method: "POST", body: data, credentials: "same-origin" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok && !payload.results) throw new Error(payload.error || "ارسال ناموفق بود.");
    renderResults(payload);
    if (payload.results?.some(item => item.ok)) {
      caption.value = ""; mediaInput.value = ""; mediaInput.dispatchEvent(new Event("change")); updateCounter();
    }
  } catch (error) { showError(error.message || "ارتباط با سرور برقرار نشد."); }
  finally { button.disabled = false; spinner.classList.add("hidden"); buttonText.textContent = "انتشار در مقصدهای انتخاب‌شده"; }
});
function renderResults(payload) {
  result.className = "result";
  const summary = document.createElement("p"); summary.textContent = payload.message || "نتیجه انتشار:"; result.append(summary);
  for (const item of payload.results || []) {
    const line = document.createElement("div"); line.className = item.ok ? "publish-result ok" : "publish-result fail";
    line.textContent = `${names[item.target] || item.target}: ${item.message}`;
    result.append(line);
  }
  if (!payload.results?.length) result.classList.add("error");
}
function showError(message) { result.className = "result error"; result.textContent = message; }
updateCounter(); checkStatus();
