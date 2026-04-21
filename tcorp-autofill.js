// Veeqo Chargeback Tool — T.Corp Auto-fill Content Script
// Runs on https://t.corp.amazon.com/create/* pages

(function () {
  'use strict';

  const TCORP_TEMPLATE_URL = 'https://t.corp.amazon.com/create/templates/21a64813-829d-4d9f-801b-b56e22f41c26';
  const MAX_WAIT_MS = 15000;
  const POLL_INTERVAL_MS = 500;

  function dispatchEvents(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function showBanner(message, isError) {
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;padding:10px 16px;' +
      'font-size:14px;font-family:sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.15);' +
      (isError
        ? 'background:#ffebee;color:#c62828;border-bottom:2px solid #ef9a9a;'
        : 'background:#e8f5e9;color:#2e7d32;border-bottom:2px solid #a5d6a7;');
    banner.textContent = message;
    document.body.prepend(banner);
    if (!isError) {
      setTimeout(() => { if (banner.parentNode) banner.remove(); }, 15000);
    }
  }

  function setNativeValue(el, value) {
    // Use native setter to bypass React/framework controlled inputs
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    );
    const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    );
    const setter = el.tagName === 'TEXTAREA' ? nativeTextAreaValueSetter : nativeInputValueSetter;
    if (setter && setter.set) {
      setter.set.call(el, value);
    } else {
      el.value = value;
    }
    dispatchEvents(el);
  }

  function fillTitle(titleEl, data) {
    const direction = data.returnOutbound || 'Outbound';
    const issueType = direction === 'Return'
      ? 'MSS Return Off-Manifest Dispute'
      : 'MSS Outbound Off-Manifest Dispute';
    const title = data.carrier + '_' + direction + '_' + issueType + '_CID:' + data.companyId + '_Veeqo';
    setNativeValue(titleEl, title);
  }

  // Map of template bullet prefixes to data keys
  function buildReplacements(data) {
    return [
      { prefix: 'Seller ID (MCID):', value: data.mcid },
      { prefix: 'Company ID:', value: data.companyId },
      { prefix: 'Veeqo Ticket ID:', value: data.ticketId },
      { prefix: 'Seller Display Name:', value: data.sellerName },
      { prefix: 'Carrier Name:', value: data.carrier },
      { prefix: 'Marketplace:', value: data.marketplace },
      { prefix: 'Return/ Outbound:', value: data.returnOutbound },
      { prefix: 'Order ID:', value: 'See attached CSV' },
      { prefix: 'Tracking ID:', value: 'See attached CSV' },
      { prefix: 'Ship date (MM/DD/YYYY):', value: data.shipDate },
      { prefix: 'Amount for dispute. Please specify currency. Example: USD $20):', value: data.amount },
      { prefix: 'Seller Issue Summary:', value: data.issueSummary },
      { prefix: 'Seller Action (If seller take any action before escalating to Amazon):', value: data.sellerAction },
      { prefix: 'Seller Support Troubleshoot steps taken (Provide SOP Link):', value: data.sellerSupport }
    ];
  }

  function fillDescription(textareaEl, data) {
    let text = textareaEl.value || '';
    const replacements = buildReplacements(data);

    // Process line by line to preserve newlines between bullets
    const lines = text.split('\n');
    const filledLines = lines.map(line => {
      for (const { prefix, value } of replacements) {
        if (!value) continue;
        // Check if this line contains the bullet prefix (with any bullet char: •, *, -)
        // Match: optional bullet char + optional spaces + prefix + optional trailing content
        const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp('^(\\s*(?:[•*-]\\s*)?' + escapedPrefix + ')\\s*$');
        if (pattern.test(line)) {
          return line.replace(pattern, '$1 ' + value);
        }
      }
      return line;
    });

    setNativeValue(textareaEl, filledLines.join('\n'));
  }

  function waitForElement(selector, timeoutMs) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) { resolve(el); return; }

      const start = Date.now();
      const interval = setInterval(() => {
        const el = document.querySelector(selector);
        if (el) {
          clearInterval(interval);
          resolve(el);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          reject(new Error('Timeout waiting for ' + selector));
        }
      }, POLL_INTERVAL_MS);
    });
  }

  async function run() {
    try {
      const result = await chrome.storage.local.get('tcorpAutofill');
      const data = result.tcorpAutofill;
      if (!data) return; // No data to auto-fill

      // Clear storage immediately so it doesn't re-fill on refresh
      await chrome.storage.local.remove('tcorpAutofill');

      // Wait for form fields to appear
      let titleEl, descEl;
      try {
        titleEl = await waitForElement('input#ticket-title', MAX_WAIT_MS);
        descEl = await waitForElement('textarea#markdown-editor', MAX_WAIT_MS);
      } catch (e) {
        // Fields not found — fallback to clipboard
        const fallbackText = data.description || '';
        try {
          await navigator.clipboard.writeText(fallbackText);
        } catch (clipErr) {
          // Can't write clipboard either
        }
        showBanner('Auto-fill failed — please paste manually. Data copied to clipboard.', true);
        return;
      }

      // Fill the fields
      fillTitle(titleEl, data);
      fillDescription(descEl, data);

      showBanner(
        'Fields auto-filled by Veeqo Chargeback Tool — please review before submitting. ' +
        'Remember to attach the CSV file and add your manager as a watcher.',
        false
      );
    } catch (e) {
      console.error('Veeqo Chargeback Tool auto-fill error:', e);
    }
  }

  run();
})();
