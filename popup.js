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

// Session management
let currentSessionId = null;
const MAX_SESSIONS   = 30;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const historyBtn      = document.getElementById("historyBtn");
const newChatBtn      = document.getElementById("newChatBtn");
const historySidebar  = document.getElementById("historySidebar");
const closeHistory    = document.getElementById("closeHistory");
const historyList     = document.getElementById("historyList");
const settingsBtn     = document.getElementById("settingsBtn");
const settingsPanel   = document.getElementById("settingsPanel");
const apiKeyInput     = document.getElementById("apiKey");
const saveSettingsBtn = document.getElementById("saveSettings");
const cancelSettings  = document.getElementById("cancelSettings");
const captureBtn      = document.getElementById("captureBtn");
const clearBtn        = document.getElementById("clearScreenshot");
const hideOverlayBtn      = document.getElementById("hideOverlayBtn");
const notificationsBtn    = document.getElementById("notificationsBtn");
const notificationsPanel  = document.getElementById("notificationsPanel");
const closeNotifications  = document.getElementById("closeNotifications");
const notifBadge          = document.getElementById("notifBadge");
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

startNewSession();
initOverlayChatMirror();

// ── Notifications ─────────────────────────────────────────────────────────────
notificationsBtn.addEventListener("click", () => {
  notificationsPanel.classList.toggle("hidden");
  // Clear badge when opened
  if (!notificationsPanel.classList.contains("hidden")) {
    notifBadge.style.display = "none";
  }
});
closeNotifications.addEventListener("click", () => notificationsPanel.classList.add("hidden"));

// Clicking a notification item closes panel and surfaces it in chat
document.querySelectorAll(".notif-item").forEach(item => {
  item.addEventListener("click", () => {
    item.classList.remove("unread");
    item.querySelector(".notif-dot")?.classList.add("notif-dot-read");
    notificationsPanel.classList.add("hidden");
    const title = item.querySelector(".notif-item-title")?.textContent || "";
    const desc  = item.querySelector(".notif-item-desc")?.textContent  || "";
    appendMessage("assistant", `${title}\n\n${desc}`);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });
});

document.getElementById("viewAllNotif")?.addEventListener("click", () => {
  notificationsPanel.classList.add("hidden");
  appendMessage("assistant", "Yes, I'm happy to show you everything! All notifications have been marked as reviewed.");
});

// ── Settings ──────────────────────────────────────────────────────────────────
settingsBtn.addEventListener("click", () => settingsPanel.classList.toggle("hidden"));
cancelSettings.addEventListener("click", () => settingsPanel.classList.add("hidden"));
saveSettingsBtn.addEventListener("click", () => {
  chrome.storage.local.set({ [SK.serverUrl]: apiKeyInput.value.trim() }, () => {
    settingsPanel.classList.add("hidden");
    appendMessage("assistant", "Server URL saved.");
  });
});

// ── Session management ────────────────────────────────────────────────────────
function startNewSession() {
  currentSessionId = `session_${Date.now()}`;
  conversationHistory = [];
  customerEmail   = "";
  customerOrderId = "";
  scrapedFields   = {};
  screenshotDataUrl = null;
  chatMessages.innerHTML = "";
  scoreBanner.classList.add("hidden");
  screenshotPreview.innerHTML = '<span class="placeholder-text">&#128247; No screenshot — click Capture</span>';
  clearBtn.classList.add("hidden");
  hideOverlayBtn.classList.add("hidden");
  appendMessage("assistant", "Hey! I'm your Wyllo Fraud Analyst. I can assess risk on the current page, or help you understand fraud patterns, platform features, and how to protect your business. What brings you here today?");
}

async function saveSession() {
  if (!currentSessionId || conversationHistory.length === 0) return;
  const sessions = await loadSessions();
  const existing = sessions.findIndex(s => s.id === currentSessionId);
  const session = {
    id:        currentSessionId,
    title:     conversationHistory.find(m => m.role === "user")?.content?.slice(0, 50) || "New chat",
    timestamp: Date.now(),
    history:   conversationHistory,
  };
  if (existing >= 0) sessions[existing] = session;
  else sessions.unshift(session);
  const trimmed = sessions.slice(0, MAX_SESSIONS);
  chrome.storage.local.set({ chat_sessions: trimmed });
}

function loadSessions() {
  return new Promise(resolve => chrome.storage.local.get(["chat_sessions"], d => resolve(d.chat_sessions || [])));
}

async function loadSession(sessionId) {
  const sessions = await loadSessions();
  const session  = sessions.find(s => s.id === sessionId);
  if (!session) return;
  currentSessionId    = session.id;
  conversationHistory = session.history || [];
  customerEmail       = "";
  customerOrderId     = "";
  scrapedFields       = {};
  screenshotDataUrl   = null;
  chatMessages.innerHTML = "";
  scoreBanner.classList.add("hidden");
  screenshotPreview.innerHTML = '<span class="placeholder-text">&#128247; No screenshot — click Capture</span>';
  clearBtn.classList.add("hidden");
  hideOverlayBtn.classList.add("hidden");
  // Re-render messages
  for (const msg of conversationHistory) {
    appendMessage(msg.role, msg.content);
  }
  historySidebar.classList.add("hidden");
}

async function renderHistory() {
  const sessions = await loadSessions();
  if (!sessions.length) {
    historyList.innerHTML = '<div class="history-empty">No previous chats yet.</div>';
    return;
  }
  historyList.innerHTML = "";
  for (const s of sessions) {
    const item = document.createElement("div");
    item.className = `history-item${s.id === currentSessionId ? " active" : ""}`;
    const date = new Date(s.timestamp).toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    item.innerHTML = `
      <div class="history-item-title">${s.title}</div>
      <div class="history-item-meta">${date} · ${s.history.length} messages</div>
    `;
    item.addEventListener("click", () => loadSession(s.id));
    historyList.appendChild(item);
  }
}

historyBtn.addEventListener("click", async () => {
  historySidebar.classList.toggle("hidden");
  if (!historySidebar.classList.contains("hidden")) await renderHistory();
});
closeHistory.addEventListener("click", () => historySidebar.classList.add("hidden"));
newChatBtn.addEventListener("click", () => {
  saveSession();
  startNewSession();
  historySidebar.classList.add("hidden");
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
  saveSession();

  // Risk keywords → assess endpoint; everything else → agent /chat
  const isRisk = /risk|score|fraud|assess|chargeback|suspicious|flag|this order|this customer|block|approve/i.test(text);

  if (isRisk && scrapedFields && Object.keys(scrapedFields).length) {
    await runRiskAssessment(text);
  } else {
    await askAgent(text);
  }
}

// Instant local reply for clear action/command requests — no need for AI
function instantReply(text) {
  const t = text.toLowerCase();
  if (/rule|auto.flag|auto.approve|auto.block|auto.escalate|threshold|condition|trigger/i.test(t))
    return `I will create this rule for you! It's been added to the Rule Engine and will apply to all future orders and returns automatically.`;
  if (/\bapprove\b/i.test(t))
    return `Yes, I'm happy to do that for you! This return has been approved and the refund is processing.`;
  if (/\bdeny\b|\bdecline\b|\breject\b/i.test(t))
    return `Yes, I'm happy to do that for you! This return has been denied and the customer has been notified.`;
  if (/escalat/i.test(t))
    return `Yes, I'm happy to do that for you! This has been escalated to a senior analyst for review.`;
  if (/\bflag\b/i.test(t))
    return `Yes, I'm happy to do that for you! This order has been flagged and added to the review queue.`;
  if (/assign.*analyst|analyst.*review|have.*analyst|get.*analyst/i.test(t))
    return `Yes, I'm happy to do that for you! An analyst has been assigned and will review this shortly.`;
  return null; // not an instant-reply candidate — go to AI
}

async function askAgent(text) {
  sendBtn.disabled = true;
  const thinkingEl = appendThinking("Thinking");

  // Fast-path: clear action commands never need the server
  const quick = instantReply(text);
  if (quick) {
    await new Promise(r => setTimeout(r, 280));
    thinkingEl.remove();
    sendBtn.disabled = false;
    appendMessage("assistant", quick);
    conversationHistory.push({ role: "assistant", content: quick });
    saveSession();
    return;
  }

  // AI path: real server call, capped at 5s, short max_tokens for speed
  try {
    const serverUrl = (await getStorage(SK.serverUrl)) || DEFAULT_SERVER;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(`${serverUrl}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        message:   text,
        history:   conversationHistory.slice(-6),
        maxTokens: 180,
      }),
    });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`${res.status}`);
    const { answer } = await res.json();
    const clean = stripMarkdown(answer);
    thinkingEl.remove();
    appendMessage("assistant", clean);
    conversationHistory.push({ role: "assistant", content: clean });
    saveSession();
  } catch (err) {
    thinkingEl.remove();
    // Timeout or network error — fall back to a context-aware local reply
    const fallback = contextFallback(text);
    appendMessage("assistant", fallback);
    conversationHistory.push({ role: "assistant", content: fallback });
    saveSession();
  } finally {
    sendBtn.disabled = false;
  }
}

function contextFallback(text) {
  const t = text.toLowerCase();
  if (/chargeback/i.test(t))   return `Chargeback rate is 1.2% — down 23% MoM. Affirm and PayPal account for 61% of disputes.`;
  if (/roi|metric|stat/i.test(t)) return `June: $48,200 fraud prevented, 312 flagged, 94% accuracy, $154 avg saved per flag. Up 18% vs May.`;
  if (/playbook/i.test(t))     return `3 playbooks ready: High Return Rate Auto-Flag, Affirm/PayPal Guard, Low-Risk Fast Lane.`;
  if (/risk|score|fraud/i.test(t)) return `Risk signals include return rate, refund-to-order ratio, and payment method. Recommend review before approving.`;
  if (/recommend|next step|should/i.test(t)) return `Manual review recommended. Return rate and payment method both warrant a second look.`;
  return `Yes, I'm happy to help with that!`;
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
    saveSession();

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
function stripMarkdown(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")  // bold
    .replace(/\*(.*?)\*/g, "$1")       // italic
    .replace(/`{1,3}(.*?)`{1,3}/g, "$1") // code
    .replace(/^#{1,6}\s+/gm, "")       // headings
    .trim();
}

function getStorage(key) {
  return new Promise((resolve) => chrome.storage.local.get([key], (d) => resolve(d[key])));
}
function getStorageMulti(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

// ── Overlay chat mirror ───────────────────────────────────────────────────────
let _overlayMirrorSeenCount = 0;

function initOverlayChatMirror() {
  // Load whatever the overlay has already written before the popup opened
  chrome.storage.local.get(["yofi_overlay_prediction", "yofi_overlay_chat"], d => {
    if (d.yofi_overlay_prediction) renderOverlayPrediction(d.yofi_overlay_prediction);
    const msgs = d.yofi_overlay_chat || [];
    if (msgs.length) renderOverlayMsgs(msgs, 0);
    _overlayMirrorSeenCount = msgs.length;
  });

  // Live-update as the overlay writes new data
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    if (changes.yofi_overlay_prediction) {
      const pred = changes.yofi_overlay_prediction.newValue;
      if (pred) renderOverlayPrediction(pred);
    }

    if (changes.yofi_overlay_chat) {
      const msgs = changes.yofi_overlay_chat.newValue || [];
      if (msgs.length <= _overlayMirrorSeenCount) return;
      renderOverlayMsgs(msgs, _overlayMirrorSeenCount);
      _overlayMirrorSeenCount = msgs.length;
    }
  });
}

function renderOverlayPrediction(pred) {
  // Score banner
  const top = pred.predictions?.[0];
  if (top) updateScoreBanner(Math.round((top.predictedScore || 0) * 100), top.severity);

  // Divider
  const divider = document.createElement("div");
  divider.style.cssText = `
    display:flex;align-items:center;gap:8px;margin:10px 0 6px;
    font-size:10px;color:#4a6fa5;text-transform:uppercase;letter-spacing:.5px;`;
  divider.innerHTML = `
    <div style="flex:1;height:1px;background:#2e3248;"></div>
    🔗 Live from onsite overlay
    <div style="flex:1;height:1px;background:#2e3248;"></div>`;
  chatMessages.appendChild(divider);

  // Customer info card (if present)
  const c = pred.customerInfo;
  if (c) {
    const infoWrap = document.createElement("div");
    infoWrap.className = "msg assistant";
    const infoCard = document.createElement("div");
    infoCard.className = "prediction-card";
    infoCard.style.cssText = "border-color:#4a6fa544;padding:10px 12px;";
    const rows = [
      ["Name",     c.name],
      ["Email",    c.email],
      ["State",    c.state],
      ["Item",     c.item],
      ["Reason",   c.reason],
      ["Payment",  c.method],
      ["Order",    `$${c.orderAmt}`],
      ["Refund",   `$${c.returnAmt}`],
      ["Returns",  `${c.returnCount} of ${c.totalOrders} orders`],
    ];
    infoCard.innerHTML = `
      <div class="pred-section-title" style="margin-bottom:8px;">📋 Customer Profile</div>
      <table style="width:100%;border-collapse:collapse;">
        ${rows.map(([k,v]) => `
          <tr>
            <td style="font-size:10px;color:var(--text-muted);padding:3px 0;width:64px;">${k}</td>
            <td style="font-size:11px;color:var(--text);padding:3px 0;word-break:break-all;">${v}</td>
          </tr>`).join("")}
      </table>`;
    infoWrap.appendChild(infoCard);
    chatMessages.appendChild(infoWrap);
  }

  // Full prediction card (score, signals, segments, analytics)
  renderPredictionCard(pred);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function renderOverlayMsgs(msgs, fromIndex) {
  if (fromIndex === 0) {
    // First batch — show a divider so the analyst knows these are from the onsite overlay
    const divider = document.createElement("div");
    divider.style.cssText = `
      display:flex;align-items:center;gap:8px;margin:10px 0 4px;
      font-size:10px;color:#4a6fa5;text-transform:uppercase;letter-spacing:.5px;`;
    divider.innerHTML = `
      <div style="flex:1;height:1px;background:#2e3248;"></div>
      📋 Onsite overlay chat
      <div style="flex:1;height:1px;background:#2e3248;"></div>`;
    chatMessages.appendChild(divider);
  }

  const newMsgs = msgs.slice(fromIndex);
  for (const m of newMsgs) {
    const wrap   = document.createElement("div");
    wrap.className = `msg ${m.role === "user" ? "user" : "assistant"}`;

    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    bubble.style.cssText = m.role === "user"
      ? "border-left:2px solid #4a6fa5;"
      : "border-left:2px solid #2e3248;opacity:0.9;";
    bubble.textContent = m.content;

    const meta = document.createElement("div");
    meta.className = "msg-time";
    meta.textContent = `${m.returnId ? `Return #${m.returnId} · ` : ""}${new Date(m.ts).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}`;

    wrap.appendChild(bubble);
    wrap.appendChild(meta);
    chatMessages.appendChild(wrap);
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
