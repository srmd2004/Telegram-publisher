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
  const meta = document.createElement("div");
  meta.className = "file-meta";
  const name = document.createElement("strong"); name.textContent = file.name;
  const size = document.createElement("small"); size.textContent = `${persianDigits((file.size / (1024 * 1024)).toFixed(2))} مگابایت`;
  meta.append(name, size);
  const remove = document.createElement("button"); remove.type = "button"; remove.className = "remove-file"; remove.textContent = "حذف";
  remove.addEventListener("click", () => { mediaInput.value = ""; mediaInput.dispatchEvent(new Event("change")); });
  preview.append(media, meta, remove);
});

async function checkStatus() {
  try {
    const response = await fetch("/api/status", { credentials: "same-origin" });
    if (!response.ok) throw new Error("status");
    const data = await response.json();
    statusDot.className = `dot ${data.configured ? "ok" : "bad"}`;
    connectionStatus.textContent = data.configured ? "اتصال تلگرام آماده است" : "تنظیمات تلگرام در Render کامل نیست";
  } catch {
    statusDot.className = "dot bad";
    connectionStatus.textContent = "وضعیت اتصال قابل بررسی نیست؛ صفحه را دوباره بارگذاری کن.";
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  result.className = "result";
  result.textContent = "";
  const file = mediaInput.files[0];
  const text = caption.value.trim();
  if (!file && !text) { showError("متن پیام را بنویس یا یک عکس/فیلم انتخاب کن."); return; }
  if (file && text.length > 1024) { showError("متن همراه عکس یا فیلم حداکثر ۱۰۲۴ نویسه است."); return; }
  if (!file && text.length > 4096) { showError("متن پیام حداکثر ۴۰۹۶ نویسه است."); return; }
  if (file) {
    const max = file.type.startsWith("image/") ? 10 * 1024 * 1024 : 50 * 1024 * 1024;
    if (file.size > max) { showError(file.type.startsWith("image/") ? "حجم عکس باید حداکثر ۱۰ مگابایت باشد." : "حجم فیلم باید حداکثر ۵۰ مگابایت باشد."); return; }
  }

  button.disabled = true; spinner.classList.remove("hidden"); buttonText.textContent = "در حال ارسال…";
  try {
    let response;
    if (file) {
      const data = new FormData();
      data.append("media", file, file.name);
      data.append("caption", text);
      response = await fetch("/api/publish-media", { method: "POST", body: data, credentials: "same-origin" });
    } else {
      response = await fetch("/api/publish", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }), credentials: "same-origin"
      });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || "ارسال ناموفق بود.");
    result.className = "result success"; result.textContent = data.message || "با موفقیت منتشر شد.";
    caption.value = ""; mediaInput.value = ""; mediaInput.dispatchEvent(new Event("change")); updateCounter();
  } catch (error) {
    showError(error.message || "ارتباط با سرور برقرار نشد.");
  } finally {
    button.disabled = false; spinner.classList.add("hidden"); buttonText.textContent = "انتشار در تلگرام";
  }
});
function showError(message) { result.className = "result error"; result.textContent = message; }
updateCounter();
checkStatus();
