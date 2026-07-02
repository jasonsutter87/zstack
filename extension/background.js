// zstack — toolbar click injects (or toggles) the overlay on the active tab.
// overlay.js is idempotent: re-running it tears down an existing overlay.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["overlay.js"],
    });
  } catch (e) {
    // chrome:// pages, the web store, PDF viewer, etc. can't be scripted.
    console.warn("[zstack] cannot run here:", e.message);
  }
});
