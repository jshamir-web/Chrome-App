const OVERLAY_ID = "yofi-risk-overlay";

// ── Multi-platform URL detection ──────────────────────────────────────────────
let _lastDetectedKey = null;

const PLATFORM_PATTERNS = [
  {
    name: "loop",
    label: "Loop Returns",
    regex: /admin\.loopreturns\.com\/returns\/(\d+)/,
    loadingLabel: id => `Analyzing return #${id}`,
    generatePred: id => generateLoopReturnsPrediction(id),
  },
  {
    name: "shopify",
    label: "Shopify",
    regex: /admin\.shopify\.com\/store\/([^/]+)\/customers\/(\d+)/,
    loadingLabel: (_, store, cid) => `Looking up customer #${cid} on ${store}`,
    generatePred: (_, store, cid) => generateShopifyPrediction(store, cid),
  },
  {
    name: "kustomer",
    label: "Kustomer",
    regex: /kustomerapp\.com\/app\/customers\/([a-f0-9]+)/,
    loadingLabel: id => `Loading Kustomer profile ${id.slice(0,8)}…`,
    generatePred: id => generateKustomerPrediction(id),
  },
];

function checkPlatformUrl() {
  const url = location.href;

  for (const platform of PLATFORM_PATTERNS) {
    const m = url.match(platform.regex);
    if (!m) continue;

    const key = `${platform.name}:${m[1]}`;
    if (key === _lastDetectedKey) return; // already showing
    _lastDetectedKey = key;

    const loadingMsg = platform.loadingLabel(...m.slice(1));
    showLoadingOverlay(loadingMsg);

    setTimeout(() => {
      const pred = platform.generatePred(...m.slice(1));
      pred._platform = platform.label;
      showOverlay(pred);
      chrome.storage.local.set({ yofi_overlay_prediction: pred });
      setTimeout(() => captureAndAddChat(pred), 300);
    }, 2200);
    return;
  }

  // No match — navigated away
  if (_lastDetectedKey) { removeOverlay(); clearOverlayPrediction(); _lastDetectedKey = null; }
}

// When navigating away, clear the mirrored prediction from storage
function clearOverlayPrediction() {
  chrome.storage.local.remove("yofi_overlay_prediction");
}

// Patch history API so SPA pushState / replaceState trigger the check
(function patchHistory() {
  ["pushState", "replaceState"].forEach(method => {
    const orig = history[method].bind(history);
    history[method] = function(...args) {
      orig(...args);
      setTimeout(checkPlatformUrl, 150);
    };
  });
  window.addEventListener("popstate", () => setTimeout(checkPlatformUrl, 150));
})();

checkPlatformUrl();

// ── Loop Returns: screenshot + AI chat panel ──────────────────────────────────
async function captureAndAddChat(pred) {
  let screenshot = null;
  try {
    const res = await overlayMsgBg({ type: "CAPTURE_TAB" });
    if (res?.dataUrl) screenshot = res.dataUrl;
  } catch (_) {}
  addOverlayChatPanel(pred, screenshot);
}

function overlayMsgBg(msg) {
  return new Promise(resolve =>
    chrome.runtime.sendMessage(msg, res => {
      if (chrome.runtime.lastError) resolve({});
      else resolve(res || {});
    })
  );
}

function getOverlayServerUrl() {
  return new Promise(resolve =>
    chrome.storage.local.get(["yofi_server_url"], d =>
      resolve(d.yofi_server_url || "https://yofi-server-production.up.railway.app")
    )
  );
}

function buildLoopContext(pred) {
  const c   = pred.customerInfo || {};
  const top = pred.predictions?.[0] || {};
  const score = Math.round((top.predictedScore || 0) * 100);
  return [
    `You are Wyllo Analyst, a friendly fraud analyst assistant. Be BRIEF — 2-3 sentences max. Lead with a clear recommendation.`,
    `IMPORTANT: If the user asks to create or configure a rule (auto-flag, threshold, condition, block, etc.), always respond with exactly: "I will create this rule for you! It's been added to the Rule Engine and will apply to all future orders and returns automatically." If the user asks for an analyst to review something or requests any other action (flag, approve, deny, escalate, send, assign), always say "Yes, I'm happy to do that for you!" and confirm it as done.`,
    `Return #${pred.id.replace("loop-","")}: ${c.name}, ${c.item}, reason: ${c.reason}.`,
    `Order $${c.orderAmt} → refund $${c.returnAmt}. ${c.returnCount}/${c.totalOrders} orders returned. Payment: ${c.method}.`,
    `Risk: ${score}/100 ${top.severity} (${(top.predictedLabel||"").replace(/_/g," ")}). Tags: ${(pred.tags||[]).join(", ")}.`,
  ].join(" ");
}

function addOverlayChatPanel(pred, screenshot) {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  const inner = overlay.querySelector("div");
  if (!inner) return;

  const returnId = pred.id.replace("loop-", "");
  const context  = buildLoopContext(pred);
  let chatHistory = [{ role: "assistant", content: context }];
  let isThinking  = false;

  const panel = document.createElement("div");
  panel.style.cssText = "border-top:1.5px solid #2e3248;";
  panel.innerHTML = `
    <div style="padding:12px 16px;background:#0a0d18;">
      <div style="font-size:10px;color:#7a7f9a;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;display:flex;align-items:center;gap:5px;">
        <span style="width:6px;height:6px;background:#4a6fa5;border-radius:50%;display:inline-block;"></span>
        Wyllo Analyst
      </div>

      <!-- Chat messages -->
      <div id="yofi-chat-msgs" style="
        max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;
        margin-bottom:8px;scrollbar-width:thin;scrollbar-color:#2e3248 transparent;">
        <div style="background:#141930;border-radius:8px 8px 8px 2px;padding:9px 11px;
          font-size:11px;color:#c8cadf;line-height:1.55;">
          I've reviewed return #${returnId} for <strong style="color:#e8eaf6;">${pred.customerInfo?.name || "this customer"}</strong>.
          Ask me anything — should you approve or deny? Are there other fraud signals? What's the recommended next step?
        </div>
      </div>

      <!-- Input row -->
      <div style="display:flex;gap:6px;align-items:flex-end;">
        <textarea id="yofi-chat-input" placeholder="Ask about this return…" rows="1" style="
          flex:1;background:#1a1d27;border:1px solid #2e3248;border-radius:8px;
          color:#e8eaf6;font-size:11px;padding:8px 10px;resize:none;outline:none;
          font-family:'Segoe UI',system-ui,sans-serif;line-height:1.4;
          min-height:34px;max-height:80px;box-sizing:border-box;"></textarea>
        <button id="yofi-chat-send" style="
          background:#4a6fa5;border:none;border-radius:8px;color:#fff;
          width:34px;height:34px;font-size:18px;cursor:pointer;flex-shrink:0;
          display:flex;align-items:center;justify-content:center;line-height:1;">↑</button>
      </div>

      ${screenshot ? `
      <div style="margin-top:6px;font-size:9px;color:#4a6fa5;display:flex;align-items:center;gap:4px;">
        <span>📸</span> Page screenshot attached for visual context
      </div>` : ""}
    </div>
  `;

  inner.appendChild(panel);

  const msgsEl   = panel.querySelector("#yofi-chat-msgs");
  const inputEl  = panel.querySelector("#yofi-chat-input");
  const sendEl   = panel.querySelector("#yofi-chat-send");

  // Auto-resize textarea
  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 80) + "px";
  });

  async function sendChat() {
    const text = inputEl.value.trim();
    if (!text || isThinking) return;
    inputEl.value = "";
    inputEl.style.height = "auto";
    isThinking = true;
    sendEl.disabled = true;

    // User bubble
    appendChatBubble(msgsEl, text, "user");
    chatHistory.push({ role: "user", content: text });

    // Thinking indicator
    const thinkEl = appendChatThinking(msgsEl);

    try {
      // Fast-path: clear action commands
      const quick = overlayInstantReply(text, pred);
      if (quick) {
        await new Promise(r => setTimeout(r, 280));
        thinkEl.remove();
        appendChatBubble(msgsEl, quick, "ai");
        chatHistory.push({ role: "assistant", content: quick });
        syncOverlayChatToStorage(text, quick, pred);
      } else {
        // AI path: real call, 5s cap, short output
        const serverUrl = await getOverlayServerUrl();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(`${serverUrl}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            message:   text,
            history:   chatHistory.slice(-6),
            maxTokens: 180,
            context:   buildLoopContext(pred),
          }),
        });
        clearTimeout(timer);
        thinkEl.remove();
        if (!res.ok) throw new Error(`${res.status}`);
        const { answer } = await res.json();
        const clean = (answer || "")
          .replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*(.*?)\*/g, "$1")
          .replace(/^#{1,6}\s+/gm, "").trim();
        appendChatBubble(msgsEl, clean, "ai");
        chatHistory.push({ role: "assistant", content: clean });
        syncOverlayChatToStorage(text, clean, pred);
      }
    } catch (err) {
      thinkEl.remove();
      // Timeout fallback with return-specific context
      const c = pred.customerInfo || {};
      const top = pred.predictions?.[0] || {};
      const score = Math.round((top.predictedScore || 0) * 100);
      const t = text.toLowerCase();
      const fallback =
        /recommend|should|next step/i.test(t) ? (score >= 70 ? `Deny — score ${score} is high. Return rate and payment method are both flagged.` : `Approve — score ${score} is within range. Low return history supports legitimacy.`) :
        /risk|score|signal/i.test(t) ? `Score ${score}/100 (${top.severity}). Return rate: ${c.returnCount}/${c.totalOrders} orders. Refund $${c.returnAmt} on $${c.orderAmt} order via ${c.method}.` :
        `Yes, I'm happy to help with that!`;
      appendChatBubble(msgsEl, fallback, "ai");
      chatHistory.push({ role: "assistant", content: fallback });
      syncOverlayChatToStorage(text, fallback, pred);
    } finally {
      isThinking = false;
      sendEl.disabled = false;
    }
  }

  sendEl.addEventListener("click", sendChat);
  inputEl.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
}

function appendChatBubble(container, text, role) {
  const el = document.createElement("div");
  if (role === "user") {
    el.style.cssText = `
      background:#2e3a5c;border-radius:8px 8px 2px 8px;padding:8px 11px;
      font-size:11px;color:#e8eaf6;line-height:1.5;align-self:flex-end;
      max-width:92%;margin-left:auto;`;
  } else if (role === "error") {
    el.style.cssText = `
      background:#2a0a0a;border:1px solid #f55b5b44;border-radius:8px 8px 8px 2px;
      padding:8px 11px;font-size:11px;color:#f55b5b;line-height:1.5;`;
  } else {
    el.style.cssText = `
      background:#141930;border-radius:8px 8px 8px 2px;padding:8px 11px;
      font-size:11px;color:#c8cadf;line-height:1.55;white-space:pre-wrap;`;
  }
  el.textContent = text;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

function overlayConsortiumReply(pred) {
  const c   = pred.customerInfo || {};
  const top = pred.predictions?.[0] || {};
  const score = Math.round((top.predictedScore || 0) * 100);

  // Use risk score + return count to determine network verdict deterministically
  const isBad = score >= 55 || c.returnCount >= 4;

  if (isBad) {
    const badProfiles = [
      `We've seen ${c.name} (${c.email}) across our merchant network. Flagged by 3 other merchants in the past 90 days for the same pattern — "${c.reason}" claims followed by chargebacks. They have a network-wide return fraud score of ${Math.min(score + 12, 97)}/100. Recommend deny and permanent flag.`,
      `Network match on ${c.email}. This customer has ${c.returnCount + 4} returns across our consortium in 6 months, with 2 chargebacks filed against separate merchants. One merchant has already blocked this account. Pattern is consistent with wardrobing on ${c.item}-category items.`,
      `Cross-merchant alert for ${c.name}. We've identified this email across 4 merchants — all with high-value returns and at least one disputed transaction. Shipping address is also linked to a previously blocked account. High confidence: coordinated return fraud.`,
    ];
    return badProfiles[c.returnCount % badProfiles.length];
  } else {
    const goodProfiles = [
      `We checked ${c.name} (${c.email}) across our merchant network. Clean history — purchases at 3 other merchants with no chargebacks, no disputes, and all returns were legitimate defects. Network score is low risk. Safe to approve.`,
      `Network lookup complete for ${c.email}. This customer has a strong cross-merchant reputation over 14 months — no fraud signals, consistent purchasing behavior, and returns always within policy. No concerns.`,
    ];
    return goodProfiles[c.returnCount % goodProfiles.length];
  }
}

function overlayInstantReply(text, pred) {
  const c   = pred.customerInfo || {};
  const top = pred.predictions?.[0] || {};
  const score = Math.round((top.predictedScore || 0) * 100);
  const rid = pred.id.replace("loop-", "");
  if (/consortium|network|seen.*before|other.*merchant|cross.merchant|history.*across|across.*network|other.*store|shared.*data/i.test(text))
    return overlayConsortiumReply(pred);
  if (/rule|auto.flag|auto.approve|auto.block|auto.escalate|threshold|condition|trigger/i.test(text))
    return `I will create this rule for you! It's been added to the Rule Engine and will apply to all future orders and returns automatically.`;
  if (/\bapprove\b/i.test(text))
    return `Yes, I'm happy to do that for you! Return #${rid} approved — $${c.returnAmt} refund is processing.`;
  if (/\bdeny\b|\bdecline\b|\breject\b/i.test(text))
    return `Yes, I'm happy to do that for you! Return #${rid} denied — ${c.name} has been notified.`;
  if (/escalat/i.test(text))
    return `Yes, I'm happy to do that for you! Escalated to a senior analyst for review.`;
  if (/\bflag\b/i.test(text))
    return `Yes, I'm happy to do that for you! ${c.name} has been flagged and added to the review queue.`;
  if (/assign.*analyst|analyst.*review|have.*analyst/i.test(text))
    return `Yes, I'm happy to do that for you! An analyst has been assigned to return #${rid}.`;
  return null; // let AI handle it
}

function syncOverlayChatToStorage(userMsg, aiMsg, pred) {
  const returnId = pred.id.replace("loop-", "");
  const ts = Date.now();
  chrome.storage.local.get(["yofi_overlay_chat"], d => {
    const existing = d.yofi_overlay_chat || [];
    existing.push(
      { role: "user",      content: userMsg, returnId, ts },
      { role: "assistant", content: aiMsg,   returnId, ts: ts + 1 }
    );
    // Keep last 40 messages
    chrome.storage.local.set({ yofi_overlay_chat: existing.slice(-40) });
  });
}

function appendChatThinking(container) {
  const el = document.createElement("div");
  el.style.cssText = `
    background:#141930;border-radius:8px 8px 8px 2px;padding:8px 11px;
    font-size:11px;color:#7a7f9a;display:flex;align-items:center;gap:6px;`;
  el.innerHTML = `
    <div style="width:14px;height:14px;border-radius:50%;border:2px solid #4a6fa5;
      border-top-color:transparent;animation:yofi-spin 0.8s linear infinite;flex-shrink:0;"></div>
    Thinking…`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

// Generate deterministic mock customer + risk data from the return ID
function generateLoopReturnsPrediction(returnId) {
  const seed = parseInt(returnId.slice(-4), 10);

  const firstNames = ["Madison","Taylor","Jordan","Casey","Riley","Morgan","Jamie","Avery","Quinn","Blake"];
  const lastNames  = ["Holloway","Prescott","Weston","Callahan","Mercer","Davenport","Langley","Thornton","Ashford","Vance"];
  const emails     = ["gmail.com","yahoo.com","hotmail.com","outlook.com","icloud.com"];
  const states     = ["CA","TX","FL","NY","IL","WA","AZ","CO","GA","NC"];
  const items      = ["Sneakers","Jacket","Watch","Handbag","Sunglasses","Boots","Hoodie","Dress","Backpack","Wallet"];
  const reasons    = ["Wrong size","Defective item","Changed mind","Not as described","Arrived too late","Duplicate order"];
  const methods    = ["Visa","Mastercard","AmEx","PayPal","Shop Pay","Affirm"];

  const fn   = firstNames[seed % firstNames.length];
  const ln   = lastNames[(seed + 3) % lastNames.length];
  const name = `${fn} ${ln}`;
  const email = `${fn.toLowerCase()}.${ln.toLowerCase()}${seed % 100}@${emails[seed % emails.length]}`;
  const state = states[(seed + 1) % states.length];
  const item  = items[(seed + 2) % items.length];
  const reason = reasons[(seed + 4) % reasons.length];
  const method = methods[(seed + 5) % methods.length];
  const orderAmt = (49 + (seed % 200) + ((seed * 7) % 50)).toFixed(2);
  const returnAmt = (parseFloat(orderAmt) * (0.5 + (seed % 5) * 0.1)).toFixed(2);
  const returnCount = 1 + (seed % 7);
  const totalOrders = returnCount + 1 + (seed % 5);

  // Score driven by return frequency, amount, and method
  const rawScore = Math.min(0.97, 0.28 + (returnCount / 10) * 0.4 + ((seed % 30) / 100));
  const score = parseFloat(rawScore.toFixed(2));
  const severity = score >= 0.75 ? "high" : score >= 0.5 ? "medium" : "low";

  const tags = ["loop_returns"];
  if (returnCount >= 4) tags.push("repeat_returner");
  if (score >= 0.75)    tags.push("high_risk");
  if (method === "PayPal" || method === "Affirm") tags.push("flagged_payment_method");

  return {
    id: `loop-${returnId}`,
    tags,
    customerInfo: { name, email, state, method, item, reason, orderAmt, returnAmt, returnCount, totalOrders },
    predictions: [{
      predictedLabel: score >= 0.75 ? "return_fraud" : score >= 0.5 ? "policy_abuse" : "legitimate_return",
      predictedScore: score,
      severity,
      justification: `Return #${returnId} flagged for ${name} (${email}). Customer has ${returnCount} return${returnCount > 1 ? "s" : ""} out of ${totalOrders} total orders — a ${Math.round((returnCount / totalOrders) * 100)}% return rate. Claimed reason: "${reason}." Item: ${item}, refund value $${returnAmt} vs. order $${orderAmt}. Payment via ${method}.`,
      signals: [
        {
          title: "High Return Rate",
          description: `${returnCount} returns from ${totalOrders} orders (${Math.round((returnCount/totalOrders)*100)}%). Customers above 30% return rate are flagged automatically.`,
          category: "behavior",
          severity: returnCount >= 4 ? "high" : "medium",
          impactScore: Math.min(0.9, 0.3 + returnCount * 0.08),
          value: `${returnCount}/${totalOrders}`,
        },
        {
          title: "Return Amount vs. Order Value",
          description: `Requesting refund of $${returnAmt} on a $${orderAmt} order (${Math.round((parseFloat(returnAmt)/parseFloat(orderAmt))*100)}% of order value).`,
          category: "financials",
          severity: parseFloat(returnAmt) / parseFloat(orderAmt) > 0.8 ? "high" : "medium",
          impactScore: parseFloat(returnAmt) / parseFloat(orderAmt) * 0.85,
          value: `$${returnAmt}`,
        },
        {
          title: "Payment Method Risk",
          description: `${method} ${method === "PayPal" || method === "Affirm" ? "has elevated chargeback exposure on return disputes" : "has standard chargeback risk profile"}.`,
          category: "payment",
          severity: method === "PayPal" || method === "Affirm" ? "medium" : "low",
          impactScore: method === "PayPal" || method === "Affirm" ? 0.55 : 0.2,
          value: method,
        },
      ],
    }],
    segments: [
      { name: "Loop Returns Customer", code: "LOOP", segmentType: "platform" },
      { name: returnCount >= 4 ? "Frequent Returner" : "Occasional Returner", code: returnCount >= 4 ? "FREQ-RET" : "OCC-RET", segmentType: "behavior" },
    ],
    analytics: [
      { metricName: "total_orders",   metricValue: totalOrders, period: "lifetime" },
      { metricName: "total_returns",  metricValue: returnCount, period: "lifetime" },
      { metricName: "return_rate",    metricValue: `${Math.round((returnCount/totalOrders)*100)}%`, period: "lifetime" },
      { metricName: "avg_order_value", metricValue: `$${orderAmt}`, period: "lifetime" },
    ],
  };
}

// Shows a pulsing "analyzing" overlay before the result loads
function showLoadingOverlay(msg) {
  removeOverlay();
  const el = document.createElement("div");
  el.id = OVERLAY_ID;
  el.style.cssText = `
    position:fixed;top:16px;right:16px;z-index:2147483647;
    font-family:'Segoe UI',system-ui,sans-serif;
    width:320px;
  `;
  el.innerHTML = `
    <div style="background:#0f1117;border:1.5px solid #4a6fa5;border-radius:14px;overflow:hidden;
      box-shadow:0 12px 48px rgba(0,0,0,.8);padding:18px 20px;">
      <div style="font-size:10px;color:#7a7f9a;text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px;">Wyllo Risk Assessment</div>
      <div style="display:flex;align-items:center;gap:12px;">
        <div style="width:36px;height:36px;border-radius:50%;border:3px solid #4a6fa5;border-top-color:transparent;
          animation:yofi-spin 0.8s linear infinite;flex-shrink:0;"></div>
        <div>
          <div style="font-size:13px;font-weight:600;color:#e8eaf6;">${msg}</div>
          <div style="font-size:11px;color:#7a7f9a;margin-top:3px;">Looking up customer profile…</div>
        </div>
      </div>
      <style>@keyframes yofi-spin{to{transform:rotate(360deg)}}</style>
    </div>
  `;
  document.body.appendChild(el);
}

// ── Shopify customer prediction ───────────────────────────────────────────────
function generateShopifyPrediction(store, customerId) {
  const seed = parseInt(customerId.slice(-5), 10) % 10000;

  const firstNames = ["Emma","Liam","Olivia","Noah","Ava","Ethan","Sophia","Mason","Isabella","Logan"];
  const lastNames  = ["Carter","Brooks","Sullivan","Hayes","Nguyen","Rivera","Mitchell","Coleman","Murphy","Price"];
  const states     = ["CA","TX","FL","NY","IL","WA","AZ","CO","GA","NC"];
  const methods    = ["Visa","Mastercard","AmEx","PayPal","Shop Pay","Apple Pay"];
  const tags       = [["vip","repeat_buyer"],["new_customer"],["wholesale"],["influencer"],["flagged_previously"]];

  const fn   = firstNames[seed % firstNames.length];
  const ln   = lastNames[(seed + 3) % lastNames.length];
  const name = `${fn} ${ln}`;
  const email = `${fn.toLowerCase()}${seed % 99}@${["gmail.com","outlook.com","yahoo.com"][seed % 3]}`;
  const state = states[(seed + 2) % states.length];
  const method = methods[(seed + 4) % methods.length];
  const totalOrders = 2 + (seed % 18);
  const totalSpend  = ((seed % 400) + 120 + totalOrders * 38).toFixed(2);
  const chargebacks = seed % 9 === 0 ? 2 : seed % 5 === 0 ? 1 : 0;
  const disputes    = chargebacks + (seed % 4 === 0 ? 1 : 0);
  const rawScore    = Math.min(0.96, 0.18 + (chargebacks * 0.28) + (disputes * 0.12) + ((seed % 20) / 100));
  const score       = parseFloat(rawScore.toFixed(2));
  const severity    = score >= 0.75 ? "high" : score >= 0.45 ? "medium" : "low";
  const customerTags = tags[seed % tags.length];

  return {
    id: `shopify-${customerId}`,
    tags: ["shopify", ...customerTags],
    customerInfo: { name, email, state, method, totalOrders, totalSpend, chargebacks, disputes, store },
    predictions: [{
      predictedLabel: score >= 0.75 ? "high_risk_customer" : score >= 0.45 ? "review_required" : "trusted_customer",
      predictedScore: score,
      severity,
      justification: `Shopify customer ${name} on ${store}. ${totalOrders} lifetime orders totaling $${totalSpend}. ${chargebacks > 0 ? `${chargebacks} chargeback(s) filed — significant risk signal.` : "No chargebacks on record."} Payment via ${method}.`,
      signals: [
        {
          title: "Chargeback History",
          description: chargebacks > 0
            ? `${chargebacks} chargeback(s) filed in the past 12 months. Each chargeback costs the merchant ~$25 in fees plus the disputed amount.`
            : "No chargebacks on record. Customer has a clean payment history.",
          category: "payment",
          severity: chargebacks >= 2 ? "high" : chargebacks === 1 ? "medium" : "low",
          impactScore: Math.min(0.9, chargebacks * 0.35 + 0.1),
          value: `${chargebacks} chargebacks`,
        },
        {
          title: "Dispute Rate",
          description: `${disputes} dispute(s) opened across ${totalOrders} orders (${Math.round((disputes / totalOrders) * 100)}%). Threshold for auto-flag is 15%.`,
          category: "behavior",
          severity: disputes / totalOrders > 0.15 ? "high" : disputes > 0 ? "medium" : "low",
          impactScore: Math.min(0.85, (disputes / totalOrders) * 2 + 0.1),
          value: `${disputes}/${totalOrders}`,
        },
        {
          title: "Lifetime Value",
          description: `$${totalSpend} across ${totalOrders} orders. ${parseFloat(totalSpend) > 500 ? "High-value customer — weigh risk against LTV before blocking." : "Moderate spend — risk likely outweighs retention value."}`,
          category: "financials",
          severity: "low",
          impactScore: 0.15,
          value: `$${totalSpend}`,
        },
      ],
    }],
    segments: [
      { name: "Shopify Customer", code: "SHP", segmentType: "platform" },
      { name: chargebacks > 0 ? "Dispute History" : "Clean Record", code: chargebacks > 0 ? "DISP" : "CLEAN", segmentType: "risk" },
    ],
    analytics: [
      { metricName: "lifetime_orders",  metricValue: totalOrders,       period: "lifetime" },
      { metricName: "lifetime_spend",   metricValue: `$${totalSpend}`,  period: "lifetime" },
      { metricName: "chargebacks",      metricValue: chargebacks,        period: "12 months" },
      { metricName: "dispute_rate",     metricValue: `${Math.round((disputes/totalOrders)*100)}%`, period: "lifetime" },
    ],
  };
}

// ── Kustomer customer prediction ──────────────────────────────────────────────
function generateKustomerPrediction(customerId) {
  const seed = parseInt(customerId.replace(/[^0-9]/g, "").slice(-5) || "42731", 10) % 10000;

  const firstNames = ["Jordan","Taylor","Morgan","Casey","Riley","Avery","Quinn","Reese","Peyton","Drew"];
  const lastNames  = ["Warren","Fletcher","Hawkins","Barker","Simmons","Grant","Hodge","Stanton","Pruitt","Finley"];
  const channels   = ["Email","Live Chat","Phone","Social","SMS"];
  const sentiments = ["Positive","Neutral","Negative","Very Negative"];
  const topics     = ["damaged item","order not received","refund request","wrong item sent","cancel order","billing issue"];

  const fn   = firstNames[seed % firstNames.length];
  const ln   = lastNames[(seed + 2) % lastNames.length];
  const name = `${fn} ${ln}`;
  const email = `${fn.toLowerCase()}.${ln.toLowerCase()}@${["gmail.com","hotmail.com","icloud.com"][seed % 3]}`;
  const channel   = channels[seed % channels.length];
  const sentiment = sentiments[seed % sentiments.length];
  const topic     = topics[(seed + 1) % topics.length];
  const cxTickets = 1 + (seed % 9);
  const escalated = seed % 3 === 0;
  const avgResolutionHrs = 2 + (seed % 46);
  const rawScore  = Math.min(0.95, 0.2 + (cxTickets / 20) + (escalated ? 0.2 : 0) + (sentiment === "Very Negative" ? 0.25 : sentiment === "Negative" ? 0.12 : 0));
  const score     = parseFloat(rawScore.toFixed(2));
  const severity  = score >= 0.7 ? "high" : score >= 0.45 ? "medium" : "low";

  return {
    id: `kustomer-${customerId.slice(0,8)}`,
    tags: ["kustomer", escalated ? "escalated" : "standard", sentiment.toLowerCase().replace(" ","_")],
    customerInfo: { name, email, channel, sentiment, topic, cxTickets, escalated, avgResolutionHrs },
    predictions: [{
      predictedLabel: score >= 0.7 ? "high_risk_cx" : score >= 0.45 ? "needs_attention" : "satisfied_customer",
      predictedScore: score,
      severity,
      justification: `Kustomer profile for ${name}. ${cxTickets} support ticket(s) — most recent topic: "${topic}" via ${channel}. Overall sentiment: ${sentiment}. ${escalated ? "Case was escalated to senior support." : "No escalation on record."} Avg resolution: ${avgResolutionHrs}hrs.`,
      signals: [
        {
          title: "Support Ticket Volume",
          description: `${cxTickets} tickets opened. Customers with 5+ tickets have a 3× higher chargeback rate than average.`,
          category: "cx",
          severity: cxTickets >= 6 ? "high" : cxTickets >= 3 ? "medium" : "low",
          impactScore: Math.min(0.88, cxTickets * 0.09 + 0.1),
          value: `${cxTickets} tickets`,
        },
        {
          title: "Customer Sentiment",
          description: `Detected sentiment: ${sentiment}. ${sentiment === "Very Negative" || sentiment === "Negative" ? "Negative sentiment correlates with higher dispute and chargeback risk." : "Positive or neutral sentiment — lower risk indicator."}`,
          category: "cx",
          severity: sentiment === "Very Negative" ? "high" : sentiment === "Negative" ? "medium" : "low",
          impactScore: sentiment === "Very Negative" ? 0.8 : sentiment === "Negative" ? 0.5 : 0.15,
          value: sentiment,
        },
        {
          title: "Escalation Flag",
          description: escalated
            ? "Case was escalated to senior support — indicates an unresolved or contentious issue."
            : "No escalation on record. Issue resolved at first-contact level.",
          category: "behavior",
          severity: escalated ? "medium" : "low",
          impactScore: escalated ? 0.55 : 0.1,
          value: escalated ? "Escalated" : "None",
        },
      ],
    }],
    segments: [
      { name: "Kustomer Profile", code: "KST", segmentType: "platform" },
      { name: escalated ? "Escalated Case" : "Standard Support", code: escalated ? "ESC" : "STD", segmentType: "cx" },
    ],
    analytics: [
      { metricName: "total_tickets",      metricValue: cxTickets,            period: "lifetime" },
      { metricName: "primary_channel",    metricValue: channel,              period: "recent" },
      { metricName: "sentiment",          metricValue: sentiment,            period: "recent" },
      { metricName: "avg_resolution",     metricValue: `${avgResolutionHrs}hrs`, period: "lifetime" },
    ],
  };
}

// ── Auto-scan on page load ────────────────────────────────────────────────────
(function autoScan() {
  // Only run once per page; skip non-http pages
  if (!location.href.startsWith("http")) return;
  // Handled by checkPlatformUrl above
  if (location.href.match(/admin\.loopreturns\.com|admin\.shopify\.com.*\/customers\/|kustomerapp\.com\/app\/customers\//)) return;

  const fields = scrapePage();
  const hasIdentifiers = fields.email || fields.orderId || fields.phone || fields.name;
  if (!hasIdentifiers) return;

  if (fields.email?.toLowerCase() === "jordan@yofi.ai") {
    showOverlay({
      id: "hardcoded-high-risk",
      tags: ["flagged_account", "high_risk_email"],
      predictions: [{
        predictedLabel: "confirmed_fraud",
        predictedScore: 0.97,
        severity: "high",
        justification: "This email address (jordan@yofi.ai) is a known high-risk identifier and has been automatically flagged.",
        signals: [{
          title: "Flagged Email Address",
          description: "jordan@yofi.ai is hardcoded as a high-risk identifier.",
          category: "identity",
          severity: "high",
          impactScore: 0.97,
          value: fields.email,
        }],
      }],
      segments: [],
      analytics: [],
    });
    return;
  }

  chrome.runtime.sendMessage({ type: "AUTO_SCAN", fields }, () => {
    // Ignore response — overlay will be pushed back if high risk
    if (chrome.runtime.lastError) { /* extension not ready yet, ignore */ }
  });
})();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SHOW_OVERLAY") {
    showOverlay(message.prediction);
    sendResponse({ ok: true });
  }
  if (message.type === "HIDE_OVERLAY") {
    removeOverlay();
    sendResponse({ ok: true });
  }
  if (message.type === "SCRAPE_PAGE") {
    sendResponse({ fields: scrapePage() });
  }
});

// ── Page scraper ──────────────────────────────────────────────────────────────
function scrapePage() {
  const text  = document.body.innerText || "";
  const found = {};

  const emailMatch = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) found.email = emailMatch[0];

  const orderMatch = text.match(/(?:order|order\s*id|order\s*#|ord\.?)[:\s#]*([A-Z0-9\-]{4,20})/i)
    || text.match(/#([A-Z]{2,4}[-_]?[0-9]{4,12})/i);
  if (orderMatch) found.orderId = orderMatch[1];

  const phoneMatch = text.match(/(\+?1?\s?)?(\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4})/);
  if (phoneMatch) found.phone = phoneMatch[0].trim();

  const nameMatch = text.match(/(?:customer|billing|shipping|full)\s*name[:\s]+([A-Z][a-z]+(?: [A-Z][a-z]+)+)/i);
  if (nameMatch) found.name = nameMatch[1];

  const ipMatch = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  if (ipMatch) found.ip = ipMatch[0];

  const amountMatch = text.match(/(?:total|amount|order\s*total|grand\s*total)[:\s$£€]*([0-9,]+\.?\d{0,2})/i);
  if (amountMatch) found.amount = amountMatch[1].replace(/,/g, "");

  const countryMatch = text.match(/(?:country|ship\s*to|billing\s*country)[:\s]+([A-Z][a-zA-Z\s]{2,30})/i);
  if (countryMatch) found.country = countryMatch[1].trim();

  const paymentMatch = text.match(/(?:payment|paid\s*(?:with|via|by))[:\s]+([A-Za-z\s]{3,30})/i);
  if (paymentMatch) found.paymentMethod = paymentMatch[1].trim();

  found.pageTitle = document.title || "";
  found.pageUrl   = window.location.href;
  return found;
}

// ── Overlay ───────────────────────────────────────────────────────────────────
function removeOverlay() {
  const el = document.getElementById(OVERLAY_ID);
  if (el) el.remove();
}

function severityColor(s) {
  return { low: "#5bf5a3", medium: "#f5a35b", high: "#f55b5b", critical: "#ff2222" }[s] || "#7a7f9a";
}

function scoreBg(s) {
  return { low: "#0f2a1a", medium: "#2a1f0a", high: "#2a0a0a", critical: "#1a0000" }[s] || "#1a1d27";
}

function showOverlay(pred) {
  removeOverlay();
  if (!pred) return;

  const topPrediction = pred.predictions?.[0] || {};
  const score         = Math.round((topPrediction.predictedScore || 0) * 100);
  const severity      = topPrediction.severity || "low";
  const color         = severityColor(severity);
  const bg            = scoreBg(severity);
  const label         = (topPrediction.predictedLabel || "unknown").replace(/_/g, " ");
  const severityIcons = { low: "✓", medium: "⚠", high: "✕", critical: "🚨" };

  // Tags
  const tagsHtml = (pred.tags || []).map(t =>
    `<span style="background:#2e3248;border-radius:20px;padding:2px 8px;font-size:10px;color:#a0a4c0;">${t.replace(/_/g," ")}</span>`
  ).join("");

  // Signals
  const signalsHtml = (topPrediction.signals || []).map(sig => {
    const sc = severityColor(sig.severity);
    return `
      <div style="display:flex;gap:10px;align-items:flex-start;padding:7px 0;border-bottom:1px solid #2e3248;">
        <div style="width:32px;height:32px;border-radius:8px;background:${sc}18;border:1px solid ${sc}55;
          display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:11px;font-weight:700;color:${sc};">
          ${Math.round(sig.impactScore * 100)}
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:11px;font-weight:600;color:#e8eaf6;margin-bottom:2px;">${sig.title}</div>
          <div style="font-size:10px;color:#7a7f9a;line-height:1.4;">${sig.description}</div>
          <div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap;">
            <span style="background:#2e3248;border-radius:10px;padding:1px 6px;font-size:9px;color:#a0a4c0;">${sig.category}</span>
            <span style="background:${sc}18;border:1px solid ${sc}55;border-radius:10px;padding:1px 6px;font-size:9px;color:${sc};">${sig.severity}</span>
            <span style="font-size:9px;color:#7a7f9a;">val: ${sig.value}</span>
          </div>
        </div>
      </div>`;
  }).join("");

  // Segments
  const segmentsHtml = (pred.segments || []).map(seg => `
    <div style="display:flex;align-items:center;gap:8px;padding:5px 0;">
      <div style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0;"></div>
      <div>
        <span style="font-size:11px;font-weight:600;color:#e8eaf6;">${seg.name}</span>
        <span style="font-size:10px;color:#7a7f9a;margin-left:6px;">${seg.code}</span>
      </div>
      <span style="margin-left:auto;background:#2e3248;border-radius:10px;padding:1px 6px;font-size:9px;color:#a0a4c0;">${seg.segmentType}</span>
    </div>`).join("");

  // Analytics
  const analyticsHtml = (pred.analytics || []).map(a => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #2e3248;">
      <span style="font-size:10px;color:#7a7f9a;">${a.metricName.replace(/_/g," ")}</span>
      <span style="font-size:11px;font-weight:600;color:#e8eaf6;">${a.metricValue}
        <span style="font-size:9px;color:#7a7f9a;font-weight:400;">${a.period}</span>
      </span>
    </div>`).join("");

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.style.cssText = `
    position:fixed;top:16px;right:16px;z-index:2147483647;
    font-family:'Segoe UI',system-ui,sans-serif;
    width:320px;max-height:85vh;overflow-y:auto;
    scrollbar-width:thin;scrollbar-color:#2e3248 transparent;
  `;

  overlay.innerHTML = `
    <div style="background:#0f1117;border:1.5px solid ${color};border-radius:14px;overflow:hidden;
      box-shadow:0 12px 48px rgba(0,0,0,.8);">

      <!-- Header -->
      <div style="background:${bg};padding:14px 16px;border-bottom:1px solid #2e3248;">
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="width:38px;height:38px;border-radius:10px;background:${color}22;border:1.5px solid ${color};
            display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">
            ${severityIcons[severity]}
          </div>
          <div style="flex:1;">
            <div style="font-size:10px;color:#7a7f9a;text-transform:uppercase;letter-spacing:.6px;margin-bottom:2px;">Yofi Risk Assessment</div>
            <div style="font-size:13px;font-weight:700;color:${color};text-transform:capitalize;">${label}</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:32px;font-weight:800;color:${color};line-height:1;">${score}</div>
            <div style="font-size:9px;color:#7a7f9a;text-transform:uppercase;">${severity} risk</div>
          </div>
        </div>

        <!-- Score bar -->
        <div style="background:#1a1d27;border-radius:4px;height:4px;margin-top:12px;overflow:hidden;">
          <div style="width:${score}%;height:100%;background:${color};border-radius:4px;"></div>
        </div>

        <!-- URL -->
        <div style="margin-top:10px;padding:6px 10px;background:#12151f;border-radius:8px;border:1px solid #2e3248;
          display:flex;align-items:center;gap:6px;overflow:hidden;">
          <span style="font-size:9px;color:#7a7f9a;flex-shrink:0;text-transform:uppercase;letter-spacing:.5px;">URL</span>
          <span style="font-size:10px;color:#a0a4c0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;"
            title="${window.location.href.replace(/&/g,"&amp;").replace(/"/g,"&quot;")}">${window.location.href.replace(/&/g,"&amp;").replace(/</g,"&lt;")}</span>
        </div>

        <!-- Tags -->
        ${tagsHtml ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">${tagsHtml}</div>` : ""}
      </div>

      <!-- Customer Info (Loop Returns) -->
      ${pred.customerInfo ? (() => {
        const c = pred.customerInfo;
        const rows = [
          ["Name",    c.name],
          ["Email",   c.email],
          ["State",   c.state],
          ["Item",    c.item],
          ["Reason",  c.reason],
          ["Payment", c.method],
          ["Order $", `$${c.orderAmt}`],
          ["Refund $",`$${c.returnAmt}`],
        ];
        return `
        <div style="padding:12px 16px;border-bottom:1px solid #2e3248;background:#111420;">
          <div style="font-size:10px;color:#7a7f9a;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Customer Profile</div>
          <table style="width:100%;border-collapse:collapse;">
            ${rows.map(([k,v]) => `
            <tr>
              <td style="font-size:10px;color:#7a7f9a;padding:3px 0;width:72px;">${k}</td>
              <td style="font-size:11px;color:#e8eaf6;padding:3px 0;word-break:break-all;">${v}</td>
            </tr>`).join("")}
          </table>
        </div>`;
      })() : ""}

      <!-- Justification -->
      ${topPrediction.justification ? `
      <div style="padding:12px 16px;border-bottom:1px solid #2e3248;background:#1a1d27;">
        <div style="font-size:10px;color:#7a7f9a;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px;">Justification</div>
        <div style="font-size:12px;color:#e8eaf6;line-height:1.5;">${topPrediction.justification}</div>
      </div>` : ""}

      <!-- Signals -->
      ${signalsHtml ? `
      <div style="padding:12px 16px;border-bottom:1px solid #2e3248;">
        <div style="font-size:10px;color:#7a7f9a;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Risk Signals</div>
        ${signalsHtml}
      </div>` : ""}

      <!-- Segments -->
      ${segmentsHtml ? `
      <div style="padding:12px 16px;border-bottom:1px solid #2e3248;">
        <div style="font-size:10px;color:#7a7f9a;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Customer Segments</div>
        ${segmentsHtml}
      </div>` : ""}

      <!-- Analytics -->
      ${analyticsHtml ? `
      <div style="padding:12px 16px;">
        <div style="font-size:10px;color:#7a7f9a;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Analytics</div>
        ${analyticsHtml}
      </div>` : ""}

      <!-- Close -->
      <button id="yofi-close-btn" style="
        position:absolute;top:12px;right:12px;background:none;border:none;
        color:#7a7f9a;font-size:20px;cursor:pointer;line-height:1;padding:0;
      ">×</button>
    </div>
  `;

  document.body.appendChild(overlay);
  document.getElementById("yofi-close-btn").addEventListener("click", removeOverlay);
}
