const OVERLAY_ID = "yofi-risk-overlay";

// ── Auto-scan on page load ────────────────────────────────────────────────────
(function autoScan() {
  // Only run once per page; skip non-http pages
  if (!location.href.startsWith("http")) return;

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

        <!-- Tags -->
        ${tagsHtml ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">${tagsHtml}</div>` : ""}
      </div>

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
