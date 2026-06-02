// Open popup as a persistent window so it stays open when clicking the page
let panelWindowId = null;

chrome.action.onClicked.addListener(() => {
  if (panelWindowId !== null) {
    // Focus existing window if already open
    chrome.windows.update(panelWindowId, { focused: true }, (win) => {
      if (chrome.runtime.lastError) {
        // Window was closed, open a new one
        openPanel();
      }
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
    left:   window.screen?.availWidth ? window.screen.availWidth - 460 : 900,
  }, (win) => {
    panelWindowId = win.id;
  });
}

// Clear the reference when the panel is closed
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === panelWindowId) panelWindowId = null;
});

// Find the last-focused normal browser window (not the popup window)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === "CAPTURE_TAB") {
    chrome.windows.getAll({ windowTypes: ["normal"] }, (windows) => {
      const focused = windows.find((w) => w.focused) || windows[windows.length - 1];
      if (!focused) { sendResponse({ error: "No browser window found." }); return; }
      chrome.tabs.captureVisibleTab(focused.id, { format: "png" }, (dataUrl) => {
        if (chrome.runtime.lastError) sendResponse({ error: chrome.runtime.lastError.message });
        else sendResponse({ dataUrl });
      });
    });
    return true;
  }

  if (message.type === "GET_ACTIVE_TAB_URL") {
    chrome.windows.getAll({ windowTypes: ["normal"], populate: true }, (windows) => {
      const win = windows.find((w) => w.focused) || windows[windows.length - 1];
      const tab = win?.tabs?.find((t) => t.active);
      sendResponse({ url: tab?.url || "", tabId: tab?.id });
    });
    return true;
  }

  // Relay overlay commands to the active tab's content script
  if (message.type === "SHOW_OVERLAY" || message.type === "HIDE_OVERLAY") {
    chrome.windows.getAll({ windowTypes: ["normal"], populate: true }, (windows) => {
      const win = windows.find((w) => w.focused) || windows[windows.length - 1];
      const tab = win?.tabs?.find((t) => t.active);
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, message, () => {
          // Ignore errors if content script not ready
          if (chrome.runtime.lastError) {}
        });
      }
      sendResponse({ ok: true });
    });
    return true;
  }

});
