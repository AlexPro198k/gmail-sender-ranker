(() => {
  const MAX_PAGES = 1000;
  const PAGE_TIMEOUT_MS = 20000;

  function getRangeButton() {
    return [...document.querySelectorAll('[role="main"] [role="button"]')].find((button) =>
      button.getClientRects().length > 0 &&
      /[\d,]+\s*[–-]\s*[\d,]+\s+of\s+[\d,]+/i.test(button.innerText || "")
    );
  }

  function getRangeText() {
    return (getRangeButton()?.innerText || "").replace(/\s+/g, " ").trim();
  }

  function getPageStart(rangeText) {
    const match = rangeText.match(/([\d,]+)\s*[–-]\s*[\d,]+\s+of\s+[\d,]+/i);
    return match ? Number(match[1].replaceAll(",", "")) : null;
  }

  function getRangeNumbers(rangeText) {
    const match = rangeText.match(/([\d,]+)\s*[–-]\s*([\d,]+)\s+of\s+([\d,]+)/i);
    if (!match) return null;
    const [start, end, total] = match.slice(1).map((value) => Number(value.replaceAll(",", "")));
    return { start, end, total };
  }

  function waitFor(predicate, description) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const interval = setInterval(() => {
        if (predicate()) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() - startedAt >= PAGE_TIMEOUT_MS) {
          clearInterval(interval);
          reject(new Error(`Timed out waiting for ${description}.`));
        }
      }, 150);
    });
  }

  // Gmail ignores synthetic clicks on its pagination buttons, so navigate by URL hash.
  async function goToPage(page, expectedStart) {
    const hash = page === 1 ? "#inbox" : `#inbox/p${page}`;
    if (window.location.hash !== hash) window.location.hash = hash;
    await waitFor(
      () => getPageStart(getRangeText()) === expectedStart,
      `Inbox page ${page}`
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  function collectVisibleSenders(counts) {
    const rows = document.querySelectorAll('[role="main"] [role="grid"] [role="row"]');
    let conversations = 0;

    for (const row of rows) {
      const lines = (row.innerText || "")
        .split(/\n/)
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const label = lines[0];
      if (!label || lines.length < 2) continue;

      const spans = [...row.querySelectorAll("span[email]")];
      const emails = [...new Set(spans.map((span) => (span.getAttribute("email") || "").trim().toLowerCase()).filter(Boolean))];
      // Threads with several participants have no single address, so rules are not offered for them.
      const email = emails.length === 1 ? emails[0] : null;
      const key = email ? `email:${email}` : `label:${label}`;
      const name = (email && spans[0]?.getAttribute("name")) || label;

      const entry = counts.get(key) || { name, email, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
      conversations += 1;
    }

    return conversations;
  }

  async function scanInbox() {
    const originalHash = window.location.hash;
    let originalRange = getRangeText();
    const counts = new Map();
    let pagesScanned = 0;
    let conversationsScanned = 0;
    let scanError;
    let restoreError;

    try {
      if (/^#inbox(?:\/p\d+)?$/.test(originalHash)) {
        await waitFor(() => Boolean(getRangeText()), "the current Inbox page");
        originalRange = getRangeText();
      }
      await goToPage(1, 1);
      const first = getRangeNumbers(getRangeText());
      if (!first) throw new Error("Gmail's message list was not available.");

      const pageSize = first.end - first.start + 1;
      const totalPages = Math.ceil(first.total / pageSize);
      if (totalPages > MAX_PAGES) {
        throw new Error(`Inbox has ${totalPages} pages; refusing to scan more than ${MAX_PAGES}.`);
      }

      for (let page = 1; page <= totalPages; page++) {
        if (page > 1) await goToPage(page, (page - 1) * pageSize + 1);
        conversationsScanned += collectVisibleSenders(counts);
        pagesScanned += 1;
      }
    } catch (error) {
      scanError = error instanceof Error ? error.message : String(error);
    } finally {
      try {
        if (window.location.hash !== originalHash) {
          window.location.hash = originalHash || "#inbox";
          await waitFor(
            () =>
              window.location.hash === (originalHash || "#inbox") &&
              (!originalRange || getRangeText() === originalRange),
            "your original Gmail view"
          );
        }
      } catch (error) {
        restoreError = error instanceof Error ? error.message : String(error);
      }
    }

    if (scanError || restoreError) {
      const messages = [];
      if (scanError) messages.push(`Scan failed: ${scanError}`);
      if (restoreError) messages.push(`Could not restore the original Gmail view: ${restoreError}`);
      throw new Error(messages.join(" "));
    }

    const senders = [...counts.values()]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    return {
      senders,
      pagesScanned,
      conversationsScanned
    };
  }

  let overlay;
  function closeOverlay() {
    overlay?.remove();
    overlay = undefined;
  }

  function openOverlay() {
    if (overlay) return;
    const frameUrl = chrome.runtime.getURL("popup.html?frame=1");
    overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(0,0,0,0.45);backdrop-filter:blur(3px);";
    const frame = document.createElement("iframe");
    frame.src = frameUrl;
    frame.style.cssText =
      "width:min(1100px,94vw);height:90vh;border:1px solid rgba(255,255,255,0.15);border-radius:14px;" +
      "background:#1c1d21;box-shadow:0 20px 60px rgba(0,0,0,0.5);";
    overlay.append(frame);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeOverlay();
    });
    document.documentElement.append(overlay);
  }

  window.addEventListener("message", (event) => {
    if (event.origin === new URL(chrome.runtime.getURL("/")).origin && event.data?.type === "MSR_CLOSE") {
      closeOverlay();
    }
  });

  let activeScan;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "OPEN_OVERLAY") {
      openOverlay();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type !== "SCAN_INBOX_SENDERS") return false;

    if (!activeScan) {
      activeScan = scanInbox().finally(() => {
        activeScan = undefined;
      });
    }

    activeScan.then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    );
    return true;
  });
})();
