const OVERLAY_ID = "yofi-risk-overlay";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SHOW_OVERLAY") {
    showOverlay(message.score, message.category, message.fields);
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
  const text = document.body.innerText || "";
  const html = document.body.innerHTML || "";

  const found = {};

  // Email
  const emailMatch = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) found.email = emailMatch[0];

  // Order ID — common patterns
  const orderMatch = text.match(/(?:order|order\s*id|order\s*#|ord\.?)[:\s#]*([A-Z0-9\-]{4,20})/i)
    || text.match(/#([A-Z]{2,4}[-_]?[0-9]{4,12})/i);
  if (orderMatch) found.orderId = orderMatch[1];

  // Phone
  const phoneMatch = text.match(/(\+?1?\s?)?(\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4})/);
  if (phoneMatch) found.phone = phoneMatch[0].trim();

  // Name — look for "Name:", "Customer:", "Billing Name:" etc
  const nameMatch = text.match(/(?:customer|billing|shipping|full)\s*name[:\s]+([A-Z][a-z]+(?: [A-Z][a-z]+)+)/i);
  if (nameMatch) found.name = nameMatch[1];

  // IP address
  const ipMatch = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  if (ipMatch) found.ip = ipMatch[0];

  // Amount / total
  const amountMatch = text.match(/(?:total|amount|order\s*total|grand\s*total)[:\s$£€]*([0-9,]+\.?\d{0,2})/i);
  if (amountMatch) found.amount = amountMatch[1].replace(/,/g, "");

  // Country
  const countryMatch = text.match(/(?:country|ship\s*to|billing\s*country)[:\s]+([A-Z][a-zA-Z\s]{2,30})/i);
  if (countryMatch) found.country = countryMatch[1].trim();

  // Payment method
  const paymentMatch = text.match(/(?:payment|paid\s*(?:with|via|by))[:\s]+([A-Za-z\s]{3,30})/i);
  if (paymentMatch) found.paymentMethod = paymentMatch[1].trim();

  // Page title as context
  found.pageTitle = document.title || "";
  found.pageUrl   = window.location.href;

  return found;
}

// ── Overlay ───────────────────────────────────────────────────────────────────
function removeOverlay() {
  const el = document.getElementById(OVERLAY_ID);
  if (el) el.remove();
}

function showOverlay(score, category, fields = {}) {
  removeOverlay();

  const colors = {
    low:      { bg: "#0f2a1a", border: "#5bf5a3", text: "#5bf5a3" },
    medium:   { bg: "#2a1f0a", border: "#f5a35b", text: "#f5a35b" },
    high:     { bg: "#2a0a0a", border: "#f55b5b", text: "#f55b5b" },
    critical: { bg: "#1a0000", border: "#ff2222", text: "#ff4444" },
  };

  const level = score >= 80 ? "critical" : score >= 60 ? "high" : score >= 35 ? "medium" : "low";
  const c     = colors[level];
  const icons = { low: "✓", medium: "⚠", high: "✕", critical: "🚨" };

  // Build fields list
  const fieldRows = Object.entries(fields)
    .filter(([k]) => !["pageTitle","pageUrl"].includes(k))
    .map(([k, v]) => {
      const labels = {
        email: "📧", orderId: "🧾", phone: "📞", name: "👤",
        ip: "🌐", amount: "💰", country: "🗺", paymentMethod: "💳",
      };
      const icon = labels[k] || "•";
      const label = k.replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase());
      return `<div style="display:flex;gap:6px;align-items:center;margin-bottom:3px;">
        <span>${icon}</span>
        <span style="color:#7a7f9a;font-size:10px;min-width:80px;">${label}</span>
        <span style="color:#e8eaf6;font-size:11px;">${v}</span>
      </div>`;
    }).join("");

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.style.cssText = `
    position:fixed; top:20px; right:20px; z-index:2147483647;
    font-family:'Segoe UI',system-ui,sans-serif;
  `;

  overlay.innerHTML = `
    <div style="
      background:${c.bg}; border:2px solid ${c.border}; border-radius:14px;
      padding:16px 18px; min-width:280px; max-width:340px;
      box-shadow:0 8px 40px rgba(0,0,0,.7); color:#e8eaf6; position:relative;
    ">
      <button onclick="document.getElementById('${OVERLAY_ID}').remove()" style="
        position:absolute;top:10px;right:12px;background:none;border:none;
        color:#7a7f9a;font-size:18px;cursor:pointer;line-height:1;padding:0;
      ">×</button>

      <!-- Header -->
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
        <div style="
          width:36px;height:36px;border-radius:10px;
          background:${c.text}22;border:1.5px solid ${c.border};
          display:flex;align-items:center;justify-content:center;
          font-size:18px;
        ">${icons[level]}</div>
        <div>
          <div style="font-size:10px;color:#7a7f9a;text-transform:uppercase;letter-spacing:.6px;">Yofi Risk Score</div>
          <div style="font-size:14px;font-weight:700;color:${c.text};">${category}</div>
        </div>
        <div style="margin-left:auto;font-size:34px;font-weight:800;color:${c.text};line-height:1;">${score}</div>
      </div>

      <!-- Bar -->
      <div style="background:#1a1d27;border-radius:4px;height:5px;margin-bottom:14px;overflow:hidden;">
        <div style="width:${score}%;height:100%;background:${c.border};border-radius:4px;"></div>
      </div>

      <!-- Detected fields -->
      ${fieldRows ? `
        <div style="border-top:1px solid #2e3248;padding-top:10px;">
          <div style="font-size:10px;color:#7a7f9a;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Detected Info</div>
          ${fieldRows}
        </div>
      ` : ""}
    </div>
  `;

  document.body.appendChild(overlay);
}
