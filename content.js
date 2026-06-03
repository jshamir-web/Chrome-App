const OVERLAY_ID = "yofi-risk-overlay";

// ── Loop Returns URL detection (works on hard load + SPA navigation) ─────────
let _loopLastReturnId = null;

function checkLoopReturnsUrl() {
  const loopMatch = location.href.match(/admin\.loopreturns\.com\/returns\/(\d+)/);
  if (!loopMatch) {
    // Navigated away from a return — clear overlay so it doesn't linger
    if (_loopLastReturnId) { removeOverlay(); _loopLastReturnId = null; }
    return;
  }
  const returnId = loopMatch[1];
  if (returnId === _loopLastReturnId) return; // same return, already shown
  _loopLastReturnId = returnId;

  showLoadingOverlay(returnId);
  setTimeout(() => showOverlay(generateLoopReturnsPrediction(returnId)), 2200);
}

// Patch history API so SPA pushState / replaceState trigger the check
(function patchHistory() {
  ["pushState", "replaceState"].forEach(method => {
    const orig = history[method].bind(history);
    history[method] = function(...args) {
      orig(...args);
      setTimeout(checkLoopReturnsUrl, 150); // let the SPA update the URL first
    };
  });
  window.addEventListener("popstate", () => setTimeout(checkLoopReturnsUrl, 150));
})();

// Run on initial page load
checkLoopReturnsUrl();

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
function showLoadingOverlay(returnId) {
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
      <div style="font-size:10px;color:#7a7f9a;text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px;">Yofi Risk Assessment</div>
      <div style="display:flex;align-items:center;gap:12px;">
        <div style="width:36px;height:36px;border-radius:50%;border:3px solid #4a6fa5;border-top-color:transparent;
          animation:yofi-spin 0.8s linear infinite;flex-shrink:0;"></div>
        <div>
          <div style="font-size:13px;font-weight:600;color:#e8eaf6;">Analyzing return #${returnId}</div>
          <div style="font-size:11px;color:#7a7f9a;margin-top:3px;">Looking up customer profile…</div>
        </div>
      </div>
      <style>@keyframes yofi-spin{to{transform:rotate(360deg)}}</style>
    </div>
  `;
  document.body.appendChild(el);
}

// ── Auto-scan on page load ────────────────────────────────────────────────────
(function autoScan() {
  // Only run once per page; skip non-http pages
  if (!location.href.startsWith("http")) return;
  // Loop Returns URLs are handled by checkLoopReturnsUrl above
  if (location.href.match(/admin\.loopreturns\.com/)) return;

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
