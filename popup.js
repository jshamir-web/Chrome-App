// ── Storage keys ──────────────────────────────────────────────────────────────
const SK = { serverUrl: "yofi_server_url" };
const DEFAULT_SERVER = "https://your-server.railway.app"; // updated after deploy

// ── State ─────────────────────────────────────────────────────────────────────
let screenshotDataUrl = null;
let currentTabUrl     = "";

// Conversational state machine
// steps: "email" → "orderId" → "ready"
let chatState   = "email";
let customerEmail  = "";
let customerOrderId = "";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const settingsBtn     = document.getElementById("settingsBtn");
const settingsPanel   = document.getElementById("settingsPanel");
const apiKeyInput     = document.getElementById("apiKey");
const saveSettingsBtn = document.getElementById("saveSettings");
const cancelSettings  = document.getElementById("cancelSettings");
const captureBtn      = document.getElementById("captureBtn");
const clearBtn        = document.getElementById("clearScreenshot");
const hideOverlayBtn  = document.getElementById("hideOverlayBtn");
const screenshotPreview = document.getElementById("screenshotPreview");
const scoreBanner     = document.getElementById("scoreBanner");
const scoreValueEl    = document.getElementById("scoreValue");
const scoreBarFill    = document.getElementById("scoreBarFill");
const scoreCategoryEl = document.getElementById("scoreCategory");
const chatMessages    = document.getElementById("chatMessages");
const chatInput       = document.getElementById("chatInput");
const sendBtn         = document.getElementById("sendBtn");

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  const data = await getStorageMulti([SK.serverUrl]);
  apiKeyInput.value = data[SK.serverUrl] || DEFAULT_SERVER;

  const { url } = await sendToBackground({ type: "GET_ACTIVE_TAB_URL" });
  currentTabUrl = url || "";
})();

appendMessage("assistant", "What's the customer's email address?");

// ── Settings ──────────────────────────────────────────────────────────────────
settingsBtn.addEventListener("click", () => settingsPanel.classList.toggle("hidden"));
cancelSettings.addEventListener("click", () => settingsPanel.classList.add("hidden"));
saveSettingsBtn.addEventListener("click", () => {
  chrome.storage.local.set({ [SK.serverUrl]: apiKeyInput.value.trim() }, () => {
    settingsPanel.classList.add("hidden");
    appendMessage("assistant", "Server URL saved.");
  });
});

// ── Screenshot ────────────────────────────────────────────────────────────────
captureBtn.addEventListener("click", async () => {
  captureBtn.disabled = true;
  captureBtn.textContent = "Capturing…";
  try {
    const res = await sendToBackground({ type: "CAPTURE_TAB" });
    if (res.error) throw new Error(res.error);
    screenshotDataUrl = res.dataUrl;
    renderScreenshot(screenshotDataUrl);
    appendMessage("assistant", "Screenshot captured! Now send a message to get a risk assessment.");
  } catch (err) {
    appendMessage("assistant", `Screenshot failed: ${err.message}`);
  } finally {
    captureBtn.disabled = false;
    captureBtn.innerHTML = "&#128247; Capture Page";
  }
});

clearBtn.addEventListener("click", () => {
  screenshotDataUrl = null;
  screenshotPreview.innerHTML = '<span class="placeholder-text">&#128247; No screenshot — click Capture</span>';
  clearBtn.classList.add("hidden");
  scoreBanner.classList.add("hidden");
});

hideOverlayBtn.addEventListener("click", () => {
  sendToBackground({ type: "HIDE_OVERLAY" });
  hideOverlayBtn.classList.add("hidden");
});

function renderScreenshot(dataUrl) {
  const img = document.createElement("img");
  img.src = dataUrl;
  screenshotPreview.innerHTML = "";
  screenshotPreview.appendChild(img);
  clearBtn.classList.remove("hidden");
}

// ── Chat ──────────────────────────────────────────────────────────────────────
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
sendBtn.addEventListener("click", sendMessage);

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  chatInput.value = "";
  autoResize();
  appendMessage("user", text);

  // ── Conversational collection of email then order ID ──
  if (chatState === "email") {
    // Basic email check
    if (!text.includes("@") || !text.includes(".")) {
      appendMessage("assistant", "That doesn't look like a valid email. What's the customer's email address?");
      return;
    }
    customerEmail = text;
    chatState = "orderId";
    appendMessage("assistant", `Got it — ${customerEmail}. What's the order ID?`);
    return;
  }

  if (chatState === "orderId") {
    customerOrderId = text;
    chatState = "ready";
    appendMessage("assistant", `Thanks! Order #${customerOrderId} noted. What would you like me to assess about this order? You can also capture the page first.`);
    return;
  }

  // ── Ready: run risk assessment ──
  sendBtn.disabled = true;
  const thinkingEl = appendThinking();

  try {
    const result = await callClaude(text, customerEmail, customerOrderId);
    thinkingEl.remove();
    appendMessage("assistant", result.explanation);
    updateScoreBanner(result.score);

    const category = result.score >= 80 ? "Critical Risk"
      : result.score >= 60 ? "High Risk"
      : result.score >= 35 ? "Medium Risk"
      : "Low Risk";

    await sendToBackground({
      type: "SHOW_OVERLAY",
      score: result.score,
      category,
      email: customerEmail,
      orderId: customerOrderId,
    });
    hideOverlayBtn.classList.remove("hidden");

  } catch (err) {
    thinkingEl.remove();
    appendMessage("assistant", `Error: ${err.message}`);
  } finally {
    sendBtn.disabled = false;
  }
}

// ── Yofi Server API ───────────────────────────────────────────────────────────
async function callClaude(userMessage, email, orderId) {
  const serverUrl = (await getStorage(SK.serverUrl)) || DEFAULT_SERVER;

  const res = await fetch(`${serverUrl}/assess`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message:    userMessage,
      email,
      orderId,
      pageUrl:    currentTabUrl || "",
      screenshot: screenshotDataUrl || null,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Server error ${res.status}: ${body}`);
  }

  return res.json(); // { score, explanation }
}

// ── Score banner ──────────────────────────────────────────────────────────────
function updateScoreBanner(score) {
  score = Math.max(0, Math.min(100, score));
  scoreBanner.classList.remove("hidden");
  scoreValueEl.textContent = score;

  let color, label;
  if      (score >= 80) { color = "var(--danger)"; label = "Critical Risk"; }
  else if (score >= 60) { color = "var(--danger)"; label = "High Risk"; }
  else if (score >= 35) { color = "var(--warn)";   label = "Medium Risk"; }
  else                  { color = "var(--ok)";      label = "Low Risk"; }

  scoreValueEl.style.color          = color;
  scoreBarFill.style.width          = `${score}%`;
  scoreBarFill.style.backgroundColor = color;
  scoreCategoryEl.textContent        = label;
  scoreCategoryEl.style.color        = color;
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function appendMessage(role, text) {
  const wrap   = document.createElement("div");
  wrap.className = `msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.textContent = text;
  const time = document.createElement("div");
  time.className = "msg-time";
  time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  wrap.appendChild(bubble);
  wrap.appendChild(time);
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return wrap;
}

function appendThinking() {
  const wrap   = document.createElement("div");
  wrap.className = "msg assistant thinking";
  const bubble = document.createElement("div");
  bubble.className = "msg-bubble dots";
  bubble.innerHTML = "Analysing <span>•</span><span>•</span><span>•</span>";
  wrap.appendChild(bubble);
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return wrap;
}

chatInput.addEventListener("input", autoResize);
function autoResize() {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 90) + "px";
}

// ── Chrome helpers ────────────────────────────────────────────────────────────
function sendToBackground(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) resolve({});
      else resolve(res || {});
    });
  });
}
function getStorage(key) {
  return new Promise((resolve) => chrome.storage.local.get([key], (d) => resolve(d[key])));
}
function getStorageMulti(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
