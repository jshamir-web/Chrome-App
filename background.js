// The popup opens in its own window, so captureVisibleTab(null) would capture
// the popup itself. We must find the last-focused normal browser window first.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CAPTURE_TAB") {
    chrome.windows.getAll({ windowTypes: ["normal"] }, (windows) => {
      const focused = windows.find((w) => w.focused) || windows[windows.length - 1];
      if (!focused) {
        sendResponse({ error: "No browser window found to capture." });
        return;
      }
      chrome.tabs.captureVisibleTab(focused.id, { format: "png" }, (dataUrl) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ dataUrl });
        }
      });
    });
    return true; // keep channel open for async response
  }

  if (message.type === "GET_ACTIVE_TAB_URL") {
    chrome.windows.getAll({ windowTypes: ["normal"], populate: true }, (windows) => {
      const win = windows.find((w) => w.focused) || windows[windows.length - 1];
      const tab = win?.tabs?.find((t) => t.active);
      sendResponse({ url: tab?.url || "" });
    });
    return true;
  }
});
