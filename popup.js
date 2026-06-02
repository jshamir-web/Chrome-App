// ── Storage keys ──────────────────────────────────────────────────────────────
const SK = { apiKey: "anthropic_api_key" };
const CLAUDE_ENDPOINT = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL    = "claude-3-5-haiku-20241022";

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
const toggleKeyBtn    = document.getElementById("toggleKey");
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
  const data = await getStorageMulti([SK.apiKey]);
  apiKeyInput.value = data[SK.apiKey] || "";

  const { url } = await sendToBackground({ type: "GET_ACTIVE_TAB_URL" });
  currentTabUrl = url || "";
})();

appendMessage("assistant", "What's the customer's email address?");

// ── Settings ──────────────────────────────────────────────────────────────────
settingsBtn.addEventListener("click", () => settingsPanel.classList.toggle("hidden"));
cancelSettings.addEventListener("click", () => settingsPanel.classList.add("hidden"));
toggleKeyBtn.addEventListener("click", () => {
  const hide = apiKeyInput.type === "password";
  apiKeyInput.type = hide ? "text" : "password";
  toggleKeyBtn.textContent = hide ? "Hide" : "Show";
});
saveSettingsBtn.addEventListener("click", () => {
  chrome.storage.local.set({ [SK.apiKey]: apiKeyInput.value.trim() }, () => {
    settingsPanel.classList.add("hidden");
    appendMessage("assistant", "API key saved.");
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

// ── Claude API ────────────────────────────────────────────────────────────────
async function callClaude(userMessage, email, orderId) {
  const apiKey = (await getStorage(SK.apiKey)) || "";
  if (!apiKey) throw new Error("No Anthropic API key set. Click ⚙ to add one.");

  const systemPrompt = `You are a fraud risk analyst for an e-commerce platform powered by Yofi.
Given a customer's email, order ID, page context, and analyst notes, you assess fraud risk.

ALWAYS respond with valid JSON in this exact shape:
{
  "score": <integer 0-100>,
  "explanation": "<2-3 sentence plain-English summary of the risk assessment and key signals>"
}

Score guide:
- 0-34: Low risk — approve
- 35-59: Medium risk — flag for review
- 60-79: High risk — hold and verify
- 80-100: Critical risk — block

Be realistic and specific. Reference the email, order ID, and any page context provided.`;

  const userContent = [
    {
      type: "text",
      text: `Customer Email: ${email}\nOrder ID: ${orderId}\nPage URL: ${currentTabUrl || "unknown"}\nAnalyst note: ${userMessage}`,
    },
    ...(screenshotDataUrl ? [{
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: screenshotDataUrl.replace("data:image/png;base64,", ""),
      },
    }] : []),
  ];

  const res = await fetch(CLAUDE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const raw  = data.content?.[0]?.text || "{}";

  // Strip markdown code fences if Claude wraps the JSON
  const cleaned = raw.replace(/```json\n?/g, "").replace(/```/g, "").trim();
  const parsed  = JSON.parse(cleaned);

  return {
    score:       Math.max(0, Math.min(100, Number(parsed.score) || 0)),
    explanation: parsed.explanation || raw,
  };
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
