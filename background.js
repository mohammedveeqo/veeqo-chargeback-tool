chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: "popup.html" });
});

// Proxy fetch requests to avoid CORS issues
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'metabaseFetch') {
    const { url, method, body } = msg;
    // Get Metabase session cookie
    chrome.cookies.get({ url: 'https://veeqo.metabaseapp.com', name: 'metabase.SESSION' }, (cookie) => {
      const sessionToken = cookie ? cookie.value : null;
      if (!sessionToken) {
        sendResponse({ ok: false, status: 401, body: 'Not logged into Metabase. Please log in at veeqo.metabaseapp.com first.' });
        return;
      }
      const headers = {
        'X-Metabase-Session': sessionToken,
        'Content-Type': 'application/json'
      };
      fetch(url, {
        method: method || 'GET',
        headers,
        body: body || undefined
      })
        .then(async (res) => {
          const text = await res.text();
          sendResponse({ ok: res.ok, status: res.status, body: text });
        })
        .catch((err) => sendResponse({ ok: false, status: 0, body: err.message }));
    });
    return true;
  }

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
