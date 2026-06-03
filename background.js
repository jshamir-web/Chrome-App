// Track the tab the extension was launched from
let panelWindowId = null;
let originTabId   = null;

// When icon is clicked, remember which tab we came from, then open the panel
chrome.action.onClicked.addListener((tab) => {
  originTabId = tab.id; // always update to the latest tab

  if (panelWindowId !== null) {
    chrome.windows.update(panelWindowId, { focused: true }, () => {
      if (chrome.runtime.lastError) openPanel();
    });
  } else {
    openPanel();
  }
});

function openPanel() {
  chrome.windows.create({
    url:    chrome.runtime.getURL("popup.html"),
    type:   "popup",
    width:  440,
    height: 620,
    top:    80,
    left:   900,
  }, (win) => {
    panelWindowId = win.id;
  });
}

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === panelWindowId) panelWindowId = null;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Screenshot — always capture from the origin tab's window
  if (message.type === "CAPTURE_TAB") {
    const capture = (windowId) => {
      chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (dataUrl) => {
        if (chrome.runtime.lastError) sendResponse({ error: chrome.runtime.lastError.message });
        else sendResponse({ dataUrl });
      });
    };

    if (originTabId) {
      chrome.tabs.get(originTabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          // Fallback to any normal window
          chrome.windows.getAll({ windowTypes: ["normal"] }, (windows) => {
            const win = windows[0];
            if (win) capture(win.id);
            else sendResponse({ error: "No browser tab found." });
          });
        } else {
          capture(tab.windowId);
        }
      });
    } else {
      chrome.windows.getAll({ windowTypes: ["normal"] }, (windows) => {
        if (windows[0]) capture(windows[0].id);
        else sendResponse({ error: "No browser tab found." });
      });
    }
    return true;
  }

  // Get the URL of the origin tab
  if (message.type === "GET_ACTIVE_TAB_URL") {
    if (originTabId) {
      chrome.tabs.get(originTabId, (tab) => {
        if (chrome.runtime.lastError) sendResponse({ url: "", tabId: null });
        else sendResponse({ url: tab.url || "", tabId: tab.id });
      });
    } else {
      sendResponse({ url: "", tabId: null });
    }
    return true;
  }

  // Scrape PII from the origin tab
  if (message.type === "SCRAPE_PAGE") {
    if (originTabId) {
      chrome.tabs.sendMessage(originTabId, { type: "SCRAPE_PAGE" }, (res) => {
        if (chrome.runtime.lastError) sendResponse({ fields: {} });
        else sendResponse(res || { fields: {} });
      });
    } else {
      sendResponse({ fields: {} });
    }
    return true;
  }

  // Auto-scan: content script found PII → assess → overlay if risky
  if (message.type === "AUTO_SCAN") {
    const tabId = sender.tab?.id;
    if (!tabId) return;

    const DEFAULT_SERVER = "https://yofi-server-production.up.railway.app";
    chrome.storage.local.get(["yofi_server_url"], async (data) => {
      const serverUrl = data.yofi_server_url || DEFAULT_SERVER;
      const fields    = message.fields || {};
      try {
        const res = await fetch(`${serverUrl}/assess`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message:  "Auto-scan: assess fraud risk for this customer.",
            email:    fields.email   || "",
            orderId:  fields.orderId || "",
            pageUrl:  fields.pageUrl || "",
            fields,
          }),
        });
        if (!res.ok) return;
        const pred     = await res.json();
        const severity = pred.predictions?.[0]?.severity || "low";
        if (severity === "low") return; // only surface medium / high / critical
        chrome.tabs.sendMessage(tabId, { type: "SHOW_OVERLAY", prediction: pred }, () => {
          if (chrome.runtime.lastError) { /* tab may not be ready */ }
        });
      } catch (_) { /* network error — silently ignore */ }
    });
    return; // keep channel open for async (not needed here but harmless)
  }

  // Send overlay directly to the origin tab
  if (message.type === "SHOW_OVERLAY" || message.type === "HIDE_OVERLAY") {
    const sendToTab = (tabId) => {
      chrome.tabs.sendMessage(tabId, message, () => {
        if (chrome.runtime.lastError) {} // content script may not be ready
      });
      sendResponse({ ok: true });
    };

    if (originTabId) {
      sendToTab(originTabId);
    } else {
      // Fallback: find any active normal tab
      chrome.windows.getAll({ windowTypes: ["normal"], populate: true }, (windows) => {
        const win = windows[0];
        const tab = win?.tabs?.find((t) => t.active);
        if (tab) sendToTab(tab.id);
        else sendResponse({ ok: false });
      });
    }
    return true;
  }

});
