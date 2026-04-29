chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: "popup.html" });
});

// Proxy fetch requests to datanet-service.amazon.com to avoid CORS issues
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'turingFetch') {
    const { trackingNumber } = msg;
    chrome.cookies.getAll({ domain: '.midway-auth.amazon.com' }, (cookies) => {
      const cookieStr = (cookies || []).map(c => c.name + '=' + c.value).join('; ');
      const headers = { 'Accept': 'application/json' };
      if (cookieStr) headers['Cookie'] = cookieStr;
      fetch('https://na.turing.sfs.amazon.dev/api/search?value=' + encodeURIComponent(trackingNumber), { headers })
        .then(async (res) => {
          const text = await res.text();
          sendResponse({ ok: res.ok, status: res.status, body: text });
        })
        .catch((err) => sendResponse({ ok: false, status: 0, body: err.message }));
    });
    return true;
  }

  if (msg.type !== 'datanetFetch') return false;
  const { path, options } = msg;
  const url = options._rawUrl || ('https://datanet-service.amazon.com' + path);

  if (options._rawUrl) {
    // S3 download — no cookies needed
    fetch(url)
      .then(async (res) => {
        const text = await res.text();
        sendResponse({ ok: res.ok, status: res.status, body: text });
      })
      .catch((err) => sendResponse({ ok: false, status: 0, body: err.message }));
  } else {
    // Datanet API — need Midway cookies
    chrome.cookies.getAll({ domain: '.midway-auth.amazon.com' }, (cookies) => {
      const cookieStr = (cookies || []).map(c => c.name + '=' + c.value).join('; ');
      const headers = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        ...(options.headers || {})
      };
      if (cookieStr) headers['Cookie'] = cookieStr;
      fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body || undefined,
        redirect: 'follow'
      })
        .then(async (res) => {
          const text = await res.text();
          sendResponse({ ok: res.ok, status: res.status, body: text });
        })
        .catch((err) => sendResponse({ ok: false, status: 0, body: err.message }));
    });
  }
  return true;
});
