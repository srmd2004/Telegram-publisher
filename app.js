const form = document.getElementById("postForm");
const textInput = document.getElementById("postText");
const imageInput = document.getElementById("imageUrl");
const counter = document.getElementById("counter");
const button = document.getElementById("publishButton");
const result = document.getElementById("result");
const connection = document.getElementById("connection");

const faDigits = (value) => String(value).replace(/\d/g, d => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);

textInput.addEventListener("input", () => {
  counter.textContent = `${faDigits(textInput.value.length)} / ۴۰۹۶`;
});

async function loadStatus() {
  try {
    const response = await fetch("/api/status");
    const data = await response.json();
    connection.textContent = data.configured ? "تنظیمات وارد شده" : "اتصال تنظیم نشده";
    connection.style.color = data.configured ? "#8ce0cf" : "#f2cf80";
  } catch {
    connection.textContent = "وضعیت اتصال نامشخص";
  }
}

function showResult(message, success) {
  result.hidden = false;
  result.className = `result ${success ? "success" : "error"}`;
  result.textContent = message;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = textInput.value.trim();
  const imageUrl = imageInput.value.trim();

  if (!text && !imageUrl) {
    showResult("متن پست یا لینک تصویر را وارد کن.", false);
    return;
  }

  button.disabled = true;
  button.querySelector("span:last-child").textContent = "در حال ارسال…";
  result.hidden = true;

  try {
    const response = await fetch("/api/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, imageUrl })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "خطای ناشناخته");

    showResult(`${data.message} شناسه پیام: ${faDigits(data.messageId)}`, true);
    textInput.value = "";
    imageInput.value = "";
    counter.textContent = "۰ / ۴۰۹۶";
  } catch (error) {
    showResult(error.message || "ارتباط با سرور برقرار نشد.", false);
  } finally {
    button.disabled = false;
    button.querySelector("span:last-child").textContent = "انتشار در تلگرام";
  }
});

loadStatus();
