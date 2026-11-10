/* Clipboard writer for the offscreen document. */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'best-image-offscreen') return;
  if (message.type !== 'copy') return;

  const text = String(message.text == null ? '' : message.text);

  function done(ok, error) {
    sendResponse({ ok, error: error ? String(error) : undefined });
  }

  // execCommand('copy') works in an offscreen document because the extension
  // has the clipboardWrite permission; navigator.clipboard often requires
  // document focus, which offscreen documents do not have.
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    area.remove();
    if (ok) {
      done(true);
      return;
    }
  } catch (e) {
    /* try the async API below */
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => done(true),
      (error) => done(false, error)
    );
    return true;
  }

  done(false, 'clipboard unavailable');
  return false;
});
