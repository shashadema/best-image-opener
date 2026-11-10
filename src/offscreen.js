/* Clipboard writer for the offscreen document. */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'best-image-offscreen') return;
  if (message.type === 'convert-image') {
    convertImage(message.url, message.referer)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
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

async function convertImage(url, referer) {
  if (!/^https?:\/\//i.test(String(url || ''))) {
    return { ok: false, error: 'unsupported URL' };
  }

  const response = await fetch(url, {
    credentials: 'include',
    referrer: /^https?:\/\//i.test(String(referer || '')) ? referer : undefined,
    referrerPolicy: 'no-referrer-when-downgrade',
  });
  if (!response.ok) throw new Error(`image request failed: ${response.status}`);

  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) throw new Error('canvas unavailable');
    context.drawImage(bitmap, 0, 0);
    const png = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('PNG conversion failed'))), 'image/png');
    });
    const dataUrl = await blobToDataUrl(png);
    return {
      ok: true,
      dataUrl,
      extension: 'png',
      mime: 'image/png',
      width: bitmap.width,
      height: bitmap.height,
    };
  } finally {
    bitmap.close();
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('file read failed'));
    reader.readAsDataURL(blob);
  });
}
