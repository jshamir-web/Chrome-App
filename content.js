// Injected into every page — listens for overlay commands from the extension

const OVERLAY_ID = "yofi-risk-overlay";

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "SHOW_OVERLAY") {
    showOverlay(message.score, message.category, message.email, message.orderId);
  }
  if (message.type === "HIDE_OVERLAY") {
    removeOverlay();
  }
});

function removeOverlay() {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
}

function showOverlay(score, category, email, orderId) {
  removeOverlay();

  const colors = {
    low:      { bg: "#0f2a1a", border: "#5bf5a3", text: "#5bf5a3", badge: "#5bf5a3" },
    medium:   { bg: "#2a1f0a", border: "#f5a35b", text: "#f5a35b", badge: "#f5a35b" },
    high:     { bg: "#2a0a0a", border: "#f55b5b", text: "#f55b5b", badge: "#f55b5b" },
    critical: { bg: "#1a0000", border: "#ff2222", text: "#ff4444", badge: "#ff2222" },
  };

  const level = score >= 80 ? "critical" : score >= 60 ? "high" : score >= 35 ? "medium" : "low";
  const c = colors[level];

  const icons = { low: "✓", medium: "⚠", high: "✕", critical: "🚨" };
  const labels = { low: "Low Risk", medium: "Medium Risk", high: "High Risk", critical: "Critical Risk" };

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.innerHTML = `
    <div style="
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 2147483647;
      background: ${c.bg};
      border: 2px solid ${c.border};
      border-radius: 12px;
      padding: 14px 18px;
      min-width: 260px;
      max-width: 320px;
      font-family: 'Segoe UI', system-ui, sans-serif;
      box-shadow: 0 8px 32px rgba(0,0,0,0.6);
      color: #e8eaf6;
    ">
      <!-- Header -->
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
        <div style="display:flex; align-items:center; gap:8px;">
          <div style="
            width:32px; height:32px; border-radius:8px;
            background:${c.badge}22; border:1.5px solid ${c.border};
            display:flex; align-items:center; justify-content:center;
            font-size:16px; color:${c.text};
          ">${icons[level]}</div>
          <div>
            <div style="font-size:10px; color:#7a7f9a; text-transform:uppercase; letter-spacing:.5px;">Yofi Risk Score</div>
            <div style="font-size:13px; font-weight:700; color:${c.text};">${labels[level]}</div>
          </div>
        </div>
        <div style="
          font-size:26px; font-weight:800; color:${c.text}; line-height:1;
        ">${score}</div>
      </div>

      <!-- Score bar -->
      <div style="background:#1a1d27; border-radius:4px; height:5px; margin-bottom:10px; overflow:hidden;">
        <div style="width:${score}%; height:100%; background:${c.badge}; border-radius:4px; transition:width .5s;"></div>
      </div>

      <!-- Customer info -->
      <div style="font-size:11px; color:#7a7f9a; margin-bottom:6px; border-top:1px solid #2e3248; padding-top:8px;">
        ${email ? `<div>📧 ${email}</div>` : ""}
        ${orderId ? `<div>🧾 Order #${orderId}</div>` : ""}
      </div>

      <!-- Category tag -->
      <div style="
        display:inline-block; background:${c.badge}22;
        border:1px solid ${c.border}88; border-radius:20px;
        padding:3px 10px; font-size:11px; font-weight:600; color:${c.text};
      ">${category}</div>

      <!-- Close -->
      <button onclick="document.getElementById('${OVERLAY_ID}').remove()" style="
        position:absolute; top:10px; right:10px;
        background:none; border:none; color:#7a7f9a;
        font-size:16px; cursor:pointer; padding:2px 6px; border-radius:4px;
        line-height:1;
      " title="Dismiss">×</button>
    </div>
  `;

  document.body.appendChild(overlay);
}
