// ── Storage keys ──────────────────────────────────────────────────────────────
const SK = { serverUrl: "yofi_server_url" };
const DEFAULT_SERVER = "https://yofi-server-production.up.railway.app";

// ── State ─────────────────────────────────────────────────────────────────────
let screenshotDataUrl = null;
let currentTabUrl     = "";

// Collected customer context (populated from page scrape or chat)
let customerEmail   = "";
let customerOrderId = "";
let scrapedFields   = {};

// Conversation history sent to server with every message
let conversationHistory = []; // [{ role: "user"|"assistant", content: string }]

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

appendMessage("assistant", "Hey! I'm your Wyllo Fraud Analyst. I can assess risk on the current page, or help you understand fraud patterns, platform features, and how to protect your business. What brings you here today?");

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
  captureBtn.textContent = "Scanning…";
  try {
    // 1. Screenshot
    const res = await sendToBackground({ type: "CAPTURE_TAB" });
    if (res.error) throw new Error(res.error);
    screenshotDataUrl = res.dataUrl;
    renderScreenshot(screenshotDataUrl);

    // 2. Scrape PII from the page
    const scrapeRes = await sendToBackground({ type: "SCRAPE_PAGE" });
    scrapedFields   = scrapeRes.fields || {};
    customerEmail   = scrapedFields.email   || customerEmail;
    customerOrderId = scrapedFields.orderId || customerOrderId;

    // 3. Show what we found
    const found = Object.entries(scrapedFields)
      .filter(([k]) => !["pageTitle","pageUrl"].includes(k))
      .map(([k, v]) => {
        const labels = {
          email: "Email", orderId: "Order ID", phone: "Phone", name: "Name",
          ip: "IP", amount: "Amount", country: "Country", paymentMethod: "Payment",
        };
        return `• ${labels[k] || k}: ${v}`;
      }).join("\n");

    appendMessage("assistant", found
      ? `Found the following on this page:\n${found}\n\nRunning risk assessment…`
      : "No customer info found on this page — running a general assessment…"
    );

    // 4. Auto-run risk assessment
    await runRiskAssessment("Analyze this page for fraud risk based on the detected customer information.");

  } catch (err) {
    appendMessage("assistant", `Error: ${err.message}`);
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
  conversationHistory.push({ role: "user", content: text });

  // Risk keywords → assess endpoint; everything else → agent /chat
  const isRisk = /risk|score|fraud|assess|chargeback|suspicious|flag|this order|this customer|block|approve/i.test(text);

  if (isRisk && scrapedFields && Object.keys(scrapedFields).length) {
    await runRiskAssessment(text);
  } else {
    await askAgent(text);
  }
}

async function askAgent(text) {
  sendBtn.disabled = true;
  const thinkingEl = appendThinking("Thinking");
  try {
    const serverUrl = (await getStorage(SK.serverUrl)) || DEFAULT_SERVER;
    const res = await fetch(`${serverUrl}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        history: conversationHistory.slice(-10), // last 10 turns
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Server error ${res.status}: ${err}`);
    }
    const { answer } = await res.json();
    thinkingEl.remove();
    appendMessage("assistant", answer);
    conversationHistory.push({ role: "assistant", content: answer });
  } catch (err) {
    thinkingEl.remove();
    appendMessage("assistant", `Error: ${err.message}`);
  } finally {
    sendBtn.disabled = false;
  }
}

async function runRiskAssessment(prompt) {
  sendBtn.disabled = true;
  const thinkingEl = appendThinking();

  try {
    const pred = await callClaude(prompt, customerEmail, customerOrderId, scrapedFields);
    thinkingEl.remove();

    // Render the prediction card in chat
    renderPredictionCard(pred);

    // Update score banner from top prediction
    const topPred = pred.predictions?.[0];
    if (topPred) {
      const score = Math.round((topPred.predictedScore || 0) * 100);
      updateScoreBanner(score, topPred.severity);
    }

    // Push overlay to page
    await sendToBackground({ type: "SHOW_OVERLAY", prediction: pred });
    hideOverlayBtn.classList.remove("hidden");

    // Store in history
    const summary = `Risk score: ${Math.round((pred.predictions?.[0]?.predictedScore||0)*100)} — ${pred.predictions?.[0]?.justification||""}`;
    conversationHistory.push({ role: "assistant", content: summary });

    // Invite follow-up
    appendMessage("assistant", "Want me to dig deeper? Ask about specific signals, explain the score, or reassess with more context.");

  } catch (err) {
    thinkingEl.remove();
    appendMessage("assistant", `Error: ${err.message}`);
  } finally {
    sendBtn.disabled = false;
  }
}

function renderPredictionCard(pred) {
  const topPred  = pred.predictions?.[0] || {};
  const score    = Math.round((topPred.predictedScore || 0) * 100);
  const severity = topPred.severity || "low";
  const colors   = { low: "#5bf5a3", medium: "#f5a35b", high: "#f55b5b", critical: "#ff2222" };
  const color    = colors[severity] || "#7a7f9a";
  const label    = (topPred.predictedLabel || "").replace(/_/g, " ");

  const wrap = document.createElement("div");
  wrap.className = "msg assistant";

  const card = document.createElement("div");
  card.className = "prediction-card";
  card.style.cssText = `border-color:${color}44`;

  // ── Score header
  card.innerHTML = `
    <div class="pred-header" style="border-color:${color}33">
      <div class="pred-score-block">
        <div class="pred-score" style="color:${color}">${score}</div>
        <div class="pred-severity" style="color:${color}">${severity} risk</div>
      </div>
      <div class="pred-meta">
        <div class="pred-label">${label}</div>
        <div class="pred-id">${pred.id || ""}</div>
      </div>
    </div>
    <div class="pred-bar-track"><div class="pred-bar-fill" style="width:${score}%;background:${color}"></div></div>

    ${(pred.tags||[]).length ? `
    <div class="pred-tags">
      ${pred.tags.map(t => `<span class="pred-tag">${t.replace(/_/g," ")}</span>`).join("")}
    </div>` : ""}

    ${topPred.justification ? `
    <div class="pred-section">
      <div class="pred-section-title">Justification</div>
      <div class="pred-text">${topPred.justification}</div>
    </div>` : ""}

    ${(topPred.signals||[]).length ? `
    <div class="pred-section">
      <div class="pred-section-title">Signals</div>
      ${topPred.signals.map(sig => {
        const sc = colors[sig.severity] || "#7a7f9a";
        return `<div class="signal-row">
          <div class="signal-impact" style="color:${sc};border-color:${sc}55;background:${sc}11">${Math.round(sig.impactScore*100)}</div>
          <div class="signal-body">
            <div class="signal-title">${sig.title}</div>
            <div class="signal-desc">${sig.description}</div>
            <div class="signal-chips">
              <span class="chip">${sig.category}</span>
              <span class="chip" style="color:${sc};border-color:${sc}55">${sig.severity}</span>
              <span class="chip-plain">val: ${sig.value}</span>
            </div>
          </div>
        </div>`;
      }).join("")}
    </div>` : ""}

    ${(pred.segments||[]).length ? `
    <div class="pred-section">
      <div class="pred-section-title">Segments</div>
      ${pred.segments.map(seg => `
        <div class="segment-row">
          <div class="segment-dot" style="background:${color}"></div>
          <div class="segment-name">${seg.name}</div>
          <div class="segment-code">${seg.code}</div>
          <div class="segment-type chip">${seg.segmentType}</div>
        </div>`).join("")}
    </div>` : ""}

    ${(pred.analytics||[]).length ? `
    <div class="pred-section">
      <div class="pred-section-title">Analytics</div>
      ${pred.analytics.map(a => `
        <div class="analytic-row">
          <div class="analytic-name">${a.metricName.replace(/_/g," ")}</div>
          <div class="analytic-val">${a.metricValue} <span class="analytic-period">${a.period}</span></div>
        </div>`).join("")}
    </div>` : ""}
  `;

  wrap.appendChild(card);
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ── Yofi Server API ───────────────────────────────────────────────────────────
async function callClaude(userMessage, email, orderId, extraFields = {}) {
  const serverUrl = (await getStorage(SK.serverUrl)) || DEFAULT_SERVER;

  const res = await fetch(`${serverUrl}/assess`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message:    userMessage,
      email:      email || extraFields.email || "",
      orderId:    orderId || extraFields.orderId || "",
      pageUrl:    currentTabUrl || extraFields.pageUrl || "",
      fields:     extraFields,
      screenshot: screenshotDataUrl || null,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Server error ${res.status}: ${body}`);
  }

  return res.json(); // Yofi prediction format
}

// ── Score banner ──────────────────────────────────────────────────────────────
function updateScoreBanner(score, severity) {
  score = Math.max(0, Math.min(100, score));
  scoreBanner.classList.remove("hidden");
  scoreValueEl.textContent = score;

  const map = {
    critical: { color: "var(--danger)", label: "Critical Risk" },
    high:     { color: "var(--danger)", label: "High Risk" },
    medium:   { color: "var(--warn)",   label: "Medium Risk" },
    low:      { color: "var(--ok)",     label: "Low Risk" },
  };
  const { color, label } = map[severity] || (score >= 80 ? map.critical : score >= 60 ? map.high : score >= 35 ? map.medium : map.low);

  scoreValueEl.style.color           = color;
  scoreBarFill.style.width           = `${score}%`;
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

function appendThinking(label = "Analysing") {
  const wrap   = document.createElement("div");
  wrap.className = "msg assistant thinking";
  const bubble = document.createElement("div");
  bubble.className = "msg-bubble dots";
  bubble.innerHTML = `${label} <span>•</span><span>•</span><span>•</span>`;
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
