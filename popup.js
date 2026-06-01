// ── Storage keys ─────────────────────────────────────────────────────────────
const SK = {
  sendEndpoint:    "yofi_send_endpoint",
  receiveEndpoint: "yofi_receive_endpoint",
  apiKey:          "yofi_api_key",
};

// Default Yofi endpoints — update in settings if different
const DEFAULTS = {
  sendEndpoint:    "https://api.yofi.ai/v1/events",
  receiveEndpoint: "https://api.yofi.ai/v1/predictions",
};

// ── State ─────────────────────────────────────────────────────────────────────
let screenshotDataUrl = null;
let currentTabUrl     = "";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const settingsBtn       = document.getElementById("settingsBtn");
const settingsPanel     = document.getElementById("settingsPanel");
const sendEndpointInput = document.getElementById("sendEndpoint");
const recvEndpointInput = document.getElementById("receiveEndpoint");
const apiKeyInput       = document.getElementById("apiKey");
const toggleKeyBtn      = document.getElementById("toggleKey");
const saveSettingsBtn   = document.getElementById("saveSettings");
const cancelSettingsBtn = document.getElementById("cancelSettings");
const captureBtn        = document.getElementById("captureBtn");
const clearBtn          = document.getElementById("clearScreenshot");
const screenshotPreview = document.getElementById("screenshotPreview");
const tabUrlEl          = document.getElementById("tabUrl");
const scoreBanner       = document.getElementById("scoreBanner");
const scoreValueEl      = document.getElementById("scoreValue");
const scoreBarFill      = document.getElementById("scoreBarFill");
const scoreCategoryEl   = document.getElementById("scoreCategory");
const chatMessages      = document.getElementById("chatMessages");
const chatInput         = document.getElementById("chatInput");
const sendBtn           = document.getElementById("sendBtn");

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  const data = await getStorageMulti([SK.sendEndpoint, SK.receiveEndpoint, SK.apiKey]);
  sendEndpointInput.value = data[SK.sendEndpoint]    || DEFAULTS.sendEndpoint;
  recvEndpointInput.value = data[SK.receiveEndpoint] || DEFAULTS.receiveEndpoint;
  apiKeyInput.value       = data[SK.apiKey]          || "";

  // Show current tab URL
  const { url } = await sendToBackground({ type: "GET_ACTIVE_TAB_URL" });
  currentTabUrl = url || "";
  if (currentTabUrl) tabUrlEl.textContent = currentTabUrl;
})();

appendMessage("assistant", "Hi! Hit Capture to screenshot the current page, then send it to Yofi for a risk score.");

// ── Settings ──────────────────────────────────────────────────────────────────
settingsBtn.addEventListener("click", () => settingsPanel.classList.toggle("hidden"));

cancelSettingsBtn.addEventListener("click", () => settingsPanel.classList.add("hidden"));

toggleKeyBtn.addEventListener("click", () => {
  const isHidden = apiKeyInput.type === "password";
  apiKeyInput.type = isHidden ? "text" : "password";
  toggleKeyBtn.textContent = isHidden ? "Hide" : "Show";
});

saveSettingsBtn.addEventListener("click", () => {
  const toSave = {
    [SK.sendEndpoint]:    sendEndpointInput.value.trim(),
    [SK.receiveEndpoint]: recvEndpointInput.value.trim(),
    [SK.apiKey]:          apiKeyInput.value.trim(),
  };
  chrome.storage.local.set(toSave, () => {
    settingsPanel.classList.add("hidden");
    appendMessage("assistant", "Settings saved.");
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
    appendMessage("assistant", "Screenshot ready. Type a message and send it to Yofi for risk analysis.");
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

  sendBtn.disabled = true;
  const thinkingEl = appendThinking();

  try {
    // Simulate network latency
    await new Promise((r) => setTimeout(r, 1400 + Math.random() * 800));

    const result = getDemoResponse(text);

    thinkingEl.remove();
    appendMessage("assistant", result.explanation);
    updateScoreBanner(result.score);

  } catch (err) {
    thinkingEl.remove();
    appendMessage("assistant", `Error: ${err.message}`);
  } finally {
    sendBtn.disabled = false;
  }
}

// ── Yofi API ──────────────────────────────────────────────────────────────────

async function postToYofi(userMessage) {
  const endpoint = (await getStorage(SK.sendEndpoint)) || DEFAULTS.sendEndpoint;
  const apiKey   = (await getStorage(SK.apiKey))       || "";

  // Build a rich event payload so Yofi has full context
  const payload = {
    event_type: "risk_assessment_request",
    timestamp:  new Date().toISOString(),
    data: {
      message:    userMessage,
      page_url:   currentTabUrl,
      screenshot: screenshotDataUrl || null,
    },
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Send failed — HTTP ${res.status}: ${body}`);
  }
  return res.json().catch(() => ({}));
}

async function fetchFromYofi() {
  const endpoint = (await getStorage(SK.receiveEndpoint)) || DEFAULTS.receiveEndpoint;
  const apiKey   = (await getStorage(SK.apiKey))          || "";

  // Pass context as query params so Yofi can route to the right prediction
  const url = new URL(endpoint);
  if (currentTabUrl) url.searchParams.set("page_url", currentTabUrl);
  url.searchParams.set("limit", "1");

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: authHeaders(apiKey),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Receive failed — HTTP ${res.status}: ${body}`);
  }

  const json = await res.json();
  // Handle array wrapper: [{...}] or { data: [{...}] } or flat object
  if (Array.isArray(json)) return json[0] || json;
  if (json.data && Array.isArray(json.data)) return json.data[0] || json;
  return json;
}

function authHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    "Accept": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

// ── Demo responses ────────────────────────────────────────────────────────────
const DEMO_RESPONSES = [
  {
    score: 82,
    explanation: "High risk detected. This page exhibits several fraud indicators: mismatched billing address, device fingerprint linked to 3 prior chargebacks, and an unusually high order velocity in the last 2 hours. Recommend manual review before fulfillment.",
  },
  {
    score: 14,
    explanation: "Low risk. Customer profile is consistent with prior purchase history. Device, location, and payment method all match established patterns. No anomalies detected — safe to proceed.",
  },
  {
    score: 57,
    explanation: "Medium risk. First-time buyer with an unverified shipping address that differs from the billing region. Email domain is 3 days old. Suggest applying a soft hold and requesting an OTP verification before processing.",
  },
  {
    score: 91,
    explanation: "Critical risk. IP address flagged on 4 global blocklists. Transaction amount exceeds 3× the account's typical spend. Card BIN originates from a high-fraud jurisdiction. Strongly recommend blocking this transaction.",
  },
  {
    score: 38,
    explanation: "Low-to-medium risk. Minor velocity flag: 2 orders placed within 10 minutes. Payment method is new but device trust score is high. Monitor but likely safe to approve with standard fraud rules.",
  },
  {
    score: 73,
    explanation: "Elevated risk. Proxy/VPN usage detected. Shipping address is a freight forwarder known for re-exporting to restricted regions. Combined with a guest checkout, this pattern warrants additional verification.",
  },
];

let demoIndex = 0;
function getDemoResponse(userText) {
  // Cycle through responses; nudge score up if message contains risk-related keywords
  const lower = userText.toLowerCase();
  const isHighRiskQuery = /fraud|block|suspicious|risk|flag|chargeback/.test(lower);
  const base = DEMO_RESPONSES[demoIndex % DEMO_RESPONSES.length];
  demoIndex++;
  if (isHighRiskQuery && base.score < 50) {
    // Mirror a high-risk response instead
    return DEMO_RESPONSES.find((r) => r.score > 70) || base;
  }
  return base;
}

// ── Score banner ──────────────────────────────────────────────────────────────
function updateScoreBanner(score) {
  score = Math.max(0, Math.min(100, score));
  scoreBanner.classList.remove("hidden");
  scoreValueEl.textContent = score;

  let color, label;
  if (score <= 33)      { color = "var(--ok)";     label = "Low Risk"; }
  else if (score <= 66) { color = "var(--warn)";   label = "Medium Risk"; }
  else                  { color = "var(--danger)";  label = "High Risk"; }

  scoreValueEl.style.color     = color;
  scoreBarFill.style.width     = `${score}%`;
  scoreBarFill.style.backgroundColor = color;
  scoreCategoryEl.textContent  = label;
  scoreCategoryEl.style.color  = color;
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function appendMessage(role, text) {
  const wrap   = document.createElement("div");
  wrap.className = `msg ${role}`;

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.textContent = text;

  const time   = document.createElement("div");
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
  bubble.innerHTML = "Sending to Yofi <span>•</span><span>•</span><span>•</span>";

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
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
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
