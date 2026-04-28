// Veeqo Chargeback Tool - Application Logic

/* ===== Global State ===== */
const state = {
  taskEngineRows: null,
  datanetRows: null,
  mergedRows: [],
  activeTab: 'All',
  selectedRowIndices: new Set(),
  agentName: '',
  seller: {
    companyId: '',
    companyName: '',
    mcid: '',
    marketplaceId: ''
  },
  filters: {
    disputeStrength: 'All',
    status: 'All',
    chargebackAmount: 'All',
    surchargeFlags: 'All'
  }
};

let saveAgentNameTimer = null;

/* ===== Surcharge Threshold Constants ===== */
const SURCHARGE_THRESHOLDS = {
  FEDEX: {
    AHS_WEIGHT: { billableWeight: 50 },
    AHS_DIMENSION: { longestSide: 48, secondLongest: 30 },
    AHS_CUBIC: { cubicVolume: 10368 },
    OVERSIZE: { longestSide: 96, lengthPlusGirth: 130, cubicVolume: 17280 },
    OVER_MAX: { actualWeight: 150, longestSide: 108, lengthPlusGirth: 165 },
    ONE_RATE: { cubicVolume: 2200, actualWeight: 50 }
  },
  UPS: {
    AHS_WEIGHT: { billableWeight: 50 },
    AHS_DIMENSION: { longestSide: 48, secondLongest: 30 },
    AHS_CUBIC: { cubicVolume: 10368 },
    LARGE_PACKAGE: { longestSide: 96, lengthPlusGirth: 130, cubicVolume: 17280, actualWeight: 110 },
    OVER_MAX: { actualWeight: 150, longestSide: 108, lengthPlusGirth: 165 }
  },
  USPS: {
    NON_STANDARD_SMALL: { longestSideMin: 22, longestSideMax: 30 },
    NON_STANDARD_LARGE: { longestSide: 30 },
    VOLUME_SURCHARGE: { cubicVolume: 3456 },
    BALLOON_PRICING: { lengthPlusGirthMin: 84, lengthPlusGirthMax: 108, actualWeightMax: 20 },
    OVER_MAX: { actualWeight: 70, lengthPlusGirth: 130 }
  },
  DHL: {
    AHS_WEIGHT: { billableWeight: 50 },
    AHS_DIMENSION: { longestSide: 48 }
  }
};

function getDimDivisor(carrier) {
  const c = (carrier || '').toUpperCase();
  if (c === 'USPS') return 166;
  return 139; // UPS, FEDEX, DHL, and default
}

function computeSurchargeFlags(carrier, dims, weight, billableWeight, cubicVolume, lengthPlusGirth, serviceName) {
  // Early return if dims is not a valid array of 3 numbers
  if (!Array.isArray(dims) || dims.length !== 3 || dims.some(d => d === 'N/A' || typeof d !== 'number')) {
    return [];
  }
  if (weight === 'N/A' || billableWeight === 'N/A' || cubicVolume === 'N/A' || lengthPlusGirth === 'N/A') {
    return [];
  }

  const flags = [];
  const c = (carrier || '').toUpperCase();

  if (c === 'FEDEX') {
    if (billableWeight > 50) flags.push('AHS-Weight');
    if (dims[0] > 48 || dims[1] > 30) flags.push('AHS-Dimension');
    if (cubicVolume > 10368) flags.push('AHS-Cubic');
    if (dims[0] > 96 || lengthPlusGirth > 130 || cubicVolume > 17280) flags.push('Oversize');
    if (weight > 150 || dims[0] > 108 || lengthPlusGirth > 165) flags.push('Over Max');
    if ((serviceName || '').indexOf('One Rate') !== -1 && (cubicVolume > 2200 || weight > 50)) {
      flags.push('One Rate Exceeded');
    }
  } else if (c === 'UPS') {
    if (billableWeight > 50) flags.push('AHS-Weight');
    if (dims[0] > 48 || dims[1] > 30) flags.push('AHS-Dimension');
    if (cubicVolume > 10368) flags.push('AHS-Cubic');
    if (dims[0] > 96 || lengthPlusGirth > 130 || cubicVolume > 17280 || weight > 110) flags.push('Large Package');
    if (weight > 150 || dims[0] > 108 || lengthPlusGirth > 165) flags.push('Over Max');
  } else if (c === 'USPS') {
    if (dims[0] > 22 && dims[0] <= 30) flags.push('Non-Standard (small)');
    if (dims[0] > 30) flags.push('Non-Standard (large)');
    if (cubicVolume > 3456) flags.push('Volume Surcharge');
    if (lengthPlusGirth > 84 && lengthPlusGirth < 108 && weight < 20) flags.push('Balloon Pricing');
    if (weight > 70 || lengthPlusGirth > 130) flags.push('Over Max');
  } else if (c === 'DHL') {
    if (billableWeight > 50) flags.push('AHS-Weight');
    if (dims[0] > 48) flags.push('AHS-Dimension');
  }

  return flags;
}

/* ===== Agent Name Persistence (Task 3) ===== */

function isChromeAvailable() {
  try {
    return !!(chrome && chrome.storage && chrome.storage.local);
  } catch (e) {
    return false;
  }
}

function loadAgentName() {
  return new Promise((resolve) => {
    // Try localStorage fallback first (always available)
    const fallback = localStorage.getItem('agentName') || '';

    if (isChromeAvailable()) {
      try {
        chrome.storage.local.get('agentName', (result) => {
          if (chrome.runtime.lastError) {
            // Context invalidated — use fallback
            state.agentName = fallback;
            const input = document.getElementById('agent-name');
            if (input) input.value = fallback;
            resolve(fallback);
            return;
          }
          const name = result.agentName || fallback;
          state.agentName = name;
          const input = document.getElementById('agent-name');
          if (input) input.value = name;
          resolve(name);
        });
      } catch (e) {
        state.agentName = fallback;
        const input = document.getElementById('agent-name');
        if (input) input.value = fallback;
        resolve(fallback);
      }
    } else {
      state.agentName = fallback;
      const input = document.getElementById('agent-name');
      if (input) input.value = fallback;
      resolve(fallback);
    }
  });
}

function saveAgentName(name) {
  localStorage.setItem('agentName', name);
  if (isChromeAvailable()) {
    try {
      chrome.storage.local.set({ agentName: name });
    } catch (e) {}
  }
}

function loadDatanetProfileUrl() {
  const fallback = localStorage.getItem('datanetProfileUrl') || '';
  const input = document.getElementById('datanet-profile-url');
  if (isChromeAvailable()) {
    try {
      chrome.storage.local.get('datanetProfileUrl', (result) => {
        const url = (result && result.datanetProfileUrl) || fallback;
        if (input) input.value = url;
      });
    } catch (e) {
      if (input) input.value = fallback;
    }
  } else {
    if (input) input.value = fallback;
  }
}

function saveDatanetProfileUrl(url) {
  localStorage.setItem('datanetProfileUrl', url);
  if (isChromeAvailable()) {
    try {
      chrome.storage.local.set({ datanetProfileUrl: url });
    } catch (e) {}
  }
}

/* ===== Veeqo API - Fetch Seller Details (Requirement 16) ===== */

async function fetchSellerDetails() {
  try {
    const opts = { credentials: 'include', headers: { 'Accept': 'application/json' } };

    const [userRes, channelsRes] = await Promise.all([
      fetch('https://app.veeqo.com/current_user', opts),
      fetch('https://app.veeqo.com/channels', opts)
    ]);

    if (!userRes.ok || !channelsRes.ok) {
      throw new Error('API request failed');
    }

    const userData = await userRes.json();
    const channelsData = await channelsRes.json();

    state.seller.companyId = String(userData.company && userData.company.id || '');
    state.seller.companyName = String(userData.company && userData.company.name || '');

    const usAmazon = channelsData.find(
      ch => ch.type_code === 'amazon' && ch.marketplace_id === 'ATVPDKIKX0DER'
    );

    if (usAmazon) {
      state.seller.mcid = String(usAmazon.seller_id || '');
      state.seller.marketplaceId = String(usAmazon.marketplace_id || '');
    } else {
      state.seller.mcid = '';
      state.seller.marketplaceId = '';
    }

    // Update UI
    document.getElementById('seller-company-name').textContent = state.seller.companyName || '—';
    document.getElementById('seller-company-id').textContent = state.seller.companyId || '—';
    document.getElementById('seller-mcid').textContent = state.seller.mcid || '(no US Amazon channel)';
    document.getElementById('seller-marketplace').textContent = state.seller.marketplaceId || '(no US Amazon channel)';
  } catch (e) {
    // Not logged in or network error — show warning in panel
    document.getElementById('seller-company-name').textContent = '—';
    document.getElementById('seller-company-id').textContent = '—';
    document.getElementById('seller-mcid').textContent = '—';
    document.getElementById('seller-marketplace').textContent = '—';
    document.getElementById('seller-details-panel').style.cssText =
      'display:flex;background-color:#fff3e0;border-color:#ffcc80;color:#e65100;';
    document.getElementById('seller-company-name').textContent =
      'Not logged into a Veeqo account — seller details unavailable';
  }
}

/* ===== T.Corp Modal (Requirement 16) ===== */

function openTCorpModal(selectedRows) {
  const modal = document.getElementById('tcorp-modal');

  // Auto-fill fields
  document.getElementById('tcorp-mcid').value = state.seller.mcid;
  document.getElementById('tcorp-company-id').value = state.seller.companyId;
  document.getElementById('tcorp-seller-name').value = state.seller.companyName;
  document.getElementById('tcorp-marketplace').value = state.seller.marketplaceId;
  document.getElementById('tcorp-ticket-id').value = document.getElementById('intercom-ticket').value || '';

  // Carrier from selected rows
  const carriers = [...new Set(selectedRows.map(r => r.carrier).filter(c => c !== 'N/A'))];
  document.getElementById('tcorp-carrier').value = carriers.join(', ');

  // Ship date range
  const dates = selectedRows.map(r => r.invoiceDate).filter(d => d && d !== 'N/A').sort();
  const earliest = dates.length > 0 ? dates[0] : 'N/A';
  const latest = dates.length > 0 ? dates[dates.length - 1] : 'N/A';
  document.getElementById('tcorp-ship-date').value = earliest + ' to ' + latest;

  // Amount
  const amounts = selectedRows.map(r => (r.chargebackAmount === 'N/A' ? 0 : Number(r.chargebackAmount)));
  const total = amounts.reduce((a, b) => a + b, 0);
  document.getElementById('tcorp-amount').value = 'USD $' + total.toFixed(2);

  // Defaults
  document.getElementById('tcorp-seller-support').value = 'Carrier Chargebacks SOP v2.0';

  modal.style.display = 'flex';
}

function getTCorpFormText() {
  const fields = [
    ['Seller ID (MCID)', document.getElementById('tcorp-mcid').value],
    ['Company ID', document.getElementById('tcorp-company-id').value],
    ['Veeqo Ticket ID', document.getElementById('tcorp-ticket-id').value],
    ['Seller Display Name', document.getElementById('tcorp-seller-name').value],
    ['Carrier Name', document.getElementById('tcorp-carrier').value],
    ['Marketplace', document.getElementById('tcorp-marketplace').value],
    ['Return/Outbound', document.getElementById('tcorp-return-outbound').value],
    ['Order ID', 'See attached CSV'],
    ['Tracking ID', 'See attached CSV'],
    ['Ship date', document.getElementById('tcorp-ship-date').value],
    ['Amount for dispute', document.getElementById('tcorp-amount').value],
    ['Seller Issue Summary', document.getElementById('tcorp-issue-summary').value],
    ['Seller Action', document.getElementById('tcorp-seller-action').value],
    ['Seller Support', document.getElementById('tcorp-seller-support').value]
  ];
  return fields.map(([label, val]) => label + ': ' + val).join('\n');
}

/* ===== CSV and XLSX Parsers (Task 4.1) ===== */

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
  if (lines.length === 0) return [];

  function splitCSVLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          fields.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
    }
    fields.push(current.trim());
    return fields;
  }

  // Scan for the header row: find the first line containing a known tracking column.
  // This makes parsing resilient to any number of title/junk rows above the headers.
  const KNOWN_HEADER_MARKERS = ['tracking_number', 'tracking_id'];
  let headerLineIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const fields = splitCSVLine(lines[i]);
    if (fields.some(f => KNOWN_HEADER_MARKERS.includes(f.toLowerCase()))) {
      headerLineIndex = i;
      break;
    }
  }

  const headers = splitCSVLine(lines[headerLineIndex]);
  const rows = [];
  for (let i = headerLineIndex + 1; i < lines.length; i++) {
    const values = splitCSVLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = values[idx] !== undefined ? values[idx] : '';
    });
    rows.push(obj);
  }
  return rows;
}

function parseXLSX(arrayBuffer) {
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[firstSheetName];
  const KNOWN_HEADER_MARKERS = ['tracking_number', 'tracking_id'];

  // Try increasing range offsets until we find a row with a known tracking column.
  for (let skip = 0; skip < 20; skip++) {
    const rows = XLSX.utils.sheet_to_json(sheet, skip > 0 ? { range: skip } : undefined);
    if (rows.length > 0) {
      const keys = Object.keys(rows[0]).map(k => k.toLowerCase());
      if (keys.some(k => KNOWN_HEADER_MARKERS.includes(k))) {
        return rows;
      }
    }
  }
  // Fallback: return default parse
  return XLSX.utils.sheet_to_json(sheet);
}

function parseFile(file) {
  return new Promise((resolve, reject) => {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext !== 'csv' && ext !== 'xlsx') {
      reject(new Error('Only .csv and .xlsx files are accepted.'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not parse file. Please check the file format.'));
    if (ext === 'csv') {
      reader.onload = (e) => {
        try {
          const rows = parseCSV(e.target.result);
          if (rows.length === 0) {
            reject(new Error('Could not parse file. Please check the file format.'));
          } else {
            resolve(rows);
          }
        } catch (err) {
          reject(new Error('Could not parse file. Please check the file format.'));
        }
      };
      reader.readAsText(file);
    } else {
      reader.onload = (e) => {
        try {
          const rows = parseXLSX(e.target.result);
          if (!rows || rows.length === 0) {
            reject(new Error('Could not parse file. Please check the file format.'));
          } else {
            resolve(rows);
          }
        } catch (err) {
          reject(new Error('Could not parse file. Please check the file format.'));
        }
      };
      reader.readAsArrayBuffer(file);
    }
  });
}


/* ===== File Upload UI Handlers (Task 4.2) ===== */

function handleFileUpload(file, type) {
  const isTaskEngine = type === 'task-engine';
  const filenameEl = document.getElementById(isTaskEngine ? 'task-engine-filename' : 'datanet-filename');
  const errorEl = document.getElementById(isTaskEngine ? 'task-engine-error' : 'datanet-error');

  filenameEl.textContent = '';
  errorEl.textContent = '';

  parseFile(file)
    .then((rows) => {
      if (rows.length === 0) {
        errorEl.textContent = 'File contains no data rows.';
        return;
      }

      const keys = Object.keys(rows[0]).map(k => k.toLowerCase());

      // File type cross-check: detect if the wrong file was uploaded to the wrong area
      if (isTaskEngine && keys.includes('tracking_id') && !keys.includes('tracking_number')) {
        errorEl.textContent = 'This looks like a Datanet export. Please upload it in the Datanet upload area instead.';
        return;
      }
      if (!isTaskEngine && keys.includes('tracking_number') && !keys.includes('tracking_id')) {
        errorEl.textContent = 'This looks like a Task Engine export. Please upload it in the Task Engine upload area instead.';
        return;
      }

      const requiredCol = isTaskEngine ? 'tracking_number' : 'tracking_id';
      if (!(requiredCol in rows[0])) {
        errorEl.textContent = 'File is missing required columns. Please upload a valid export.';
        return;
      }

      // Map rows
      let mapped;
      if (isTaskEngine) {
        mapped = rows.map(mapTaskEngineRow);
      } else {
        mapped = rows.map(mapDatanetRow);
      }

      // Duplicate tracking number check
      const trackingCol = mapped.map(r => r.trackingNumber);
      const seen = new Set();
      const dupes = [];
      const deduped = [];
      trackingCol.forEach((tn, i) => {
        if (seen.has(tn)) {
          if (dupes.length < 5) dupes.push(tn);
        } else {
          seen.add(tn);
          deduped.push(mapped[i]);
        }
      });
      if (dupes.length > 0) {
        const label = isTaskEngine ? 'Task Engine' : 'Datanet';
        showNotification('Duplicate tracking numbers found in ' + label + ' export: ' + dupes.join(', ') + '. Duplicates will be ignored — only the first occurrence will be used.', 'error');
      }

      filenameEl.textContent = file.name + ' (' + deduped.length + ' rows)';
      if (isTaskEngine) {
        state.taskEngineRows = deduped;
        document.getElementById('copy-datanet-sql-btn').style.display = '';
      } else {
        state.datanetRows = deduped;
      }

      tryAutoMerge();
    })
    .catch((err) => {
      errorEl.textContent = err.message;
    });
}

function tryAutoMerge() {
  if (!state.taskEngineRows || !state.datanetRows) return;

  // Calculate match percentage
  const teTracking = new Set(state.taskEngineRows.map(r => r.trackingNumber));
  const dnTracking = new Set(state.datanetRows.map(r => r.trackingNumber));
  let matchCount = 0;
  teTracking.forEach(tn => { if (dnTracking.has(tn)) matchCount++; });
  const matchPct = teTracking.size > 0 ? Math.round((matchCount / teTracking.size) * 100) : 0;

  if (matchCount === 0) {
    showNotification('No matching tracking numbers found between the two files. Please check you have uploaded the correct files for the same seller/dispute.', 'error');
    return;
  }

  if (matchPct < 50) {
    // Show warning with merge/cancel choice
    showMergeConfirmation(matchPct, matchCount, teTracking.size);
    return;
  }

  performMerge();
}

function showMergeConfirmation(pct, matched, total) {
  // Remove any existing confirmation
  const existing = document.getElementById('merge-confirm-bar');
  if (existing) existing.remove();

  const bar = document.createElement('div');
  bar.id = 'merge-confirm-bar';
  bar.style.cssText = 'padding:12px 16px;background:#fff3e0;border:1px solid #ffcc80;border-radius:8px;margin-bottom:14px;display:flex;align-items:center;gap:12px;font-size:13px;color:#e65100;';
  bar.innerHTML = '<span>Only ' + pct + '% of tracking numbers matched (' + matched + '/' + total + '). Some data may be for a different seller or dispute.</span>';

  const mergeBtn = document.createElement('button');
  mergeBtn.textContent = 'Merge Anyway';
  mergeBtn.style.cssText = 'padding:6px 14px;background:#e17055;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;';
  mergeBtn.addEventListener('click', () => { bar.remove(); performMerge(); });

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'padding:6px 14px;background:#b2bec3;color:#2d3436;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;';
  cancelBtn.addEventListener('click', () => { bar.remove(); });

  bar.appendChild(mergeBtn);
  bar.appendChild(cancelBtn);

  // Insert before the action buttons or tab bar
  const actionBar = document.getElementById('action-buttons');
  actionBar.parentNode.insertBefore(bar, actionBar);
}

function performMerge() {
  try {
    // Remove any confirmation bar
    const confirmBar = document.getElementById('merge-confirm-bar');
    if (confirmBar) confirmBar.remove();

    const merged = mergeData(state.taskEngineRows, state.datanetRows);
    merged.forEach(calculateFields);
    state.mergedRows = merged;

    // Find the carrier tab with the highest row count
    var carrierTabs = ['FEDEX', 'UPS', 'USPS', 'DHL', 'ONTRAC'];
    var bestTab = 'All';
    var bestCount = 0;
    carrierTabs.forEach(function(c) {
      var count = merged.filter(function(r) { return r.carrier === c; }).length;
      if (count > bestCount) {
        bestCount = count;
        bestTab = c === 'FEDEX' ? 'FedEx' : c === 'ONTRAC' ? 'OnTrac' : c;
      }
    });
    state.activeTab = bestTab;

    const filtered = filterByTab(merged, bestTab);
    state.selectedRowIndices = new Set(filtered.map((_, i) => i));

    const tabs = document.querySelectorAll('#tab-bar .tab');
    tabs.forEach(t => t.classList.remove('active'));
    tabs.forEach(t => { if (t.dataset.tab === bestTab) t.classList.add('active'); });

    updateTabCounts(state.mergedRows);
    renderTable(filtered);

    // Count matches vs unmatched
    const matchedCount = merged.filter(r => r.shipmentId !== 'N/A' && r.carrierAuditedTotal !== 'N/A').length;
    const unmatchedCount = merged.length - matchedCount;
    showNotification('Merged: ' + matchedCount + ' matched, ' + unmatchedCount + ' unmatched out of ' + merged.length + ' total.', 'success');
  } catch (e) {
    showNotification('An error occurred during merge. Please check your files.', 'error');
  }
}

function setupUploadHandlers() {
  const teFile = document.getElementById('task-engine-file');
  const dnFile = document.getElementById('datanet-file');
  const teArea = document.getElementById('task-engine-upload');
  const dnArea = document.getElementById('datanet-upload');

  // Click anywhere on the box to open file picker
  teArea.addEventListener('click', () => teFile.click());
  dnArea.addEventListener('click', () => dnFile.click());

  teFile.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleFileUpload(e.target.files[0], 'task-engine');
  });
  dnFile.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleFileUpload(e.target.files[0], 'datanet');
  });

  // Drag and drop
  teArea.addEventListener('dragover', (e) => { e.preventDefault(); teArea.classList.add('dragover'); });
  teArea.addEventListener('dragleave', () => { teArea.classList.remove('dragover'); });
  teArea.addEventListener('drop', (e) => {
    e.preventDefault(); teArea.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) handleFileUpload(e.dataTransfer.files[0], 'task-engine');
  });

  dnArea.addEventListener('dragover', (e) => { e.preventDefault(); dnArea.classList.add('dragover'); });
  dnArea.addEventListener('dragleave', () => { dnArea.classList.remove('dragover'); });
  dnArea.addEventListener('drop', (e) => {
    e.preventDefault(); dnArea.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) handleFileUpload(e.dataTransfer.files[0], 'datanet');
  });
}

/* ===== Task Engine Mapper (Task 5.1) ===== */

function mapTaskEngineRow(raw) {
  const weight = parseFloat(raw.weight);
  const baseRate = parseFloat(raw.base_rate);
  return {
    trackingNumber: String(raw.tracking_number || ''),
    shipmentId: String(raw.shipment_id || ''),
    orderId: raw.order_id !== undefined ? String(raw.order_id || '') : '',
    sellerWeight: isNaN(weight) ? 0 : Math.round((weight / 453.592) * 100) / 100,
    sellerLength: isNaN(parseFloat(raw.length)) ? 0 : parseFloat(raw.length),
    sellerWidth: isNaN(parseFloat(raw.width)) ? 0 : parseFloat(raw.width),
    sellerHeight: isNaN(parseFloat(raw.height)) ? 0 : parseFloat(raw.height),
    carrier: String(raw.buyshipping_carrier_id || '').toUpperCase(),
    serviceName: String(raw.service_name || ''),
    sellerBaseRate: isNaN(baseRate) ? 0 : baseRate
  };
}

/* ===== Datanet Mapper (Task 5.3) ===== */

function mapDatanetRow(raw) {
  function pf(val) {
    const n = parseFloat(val);
    return isNaN(n) ? 0 : n;
  }
  return {
    trackingNumber: String(raw.tracking_id || ''),
    carrierAuditedLength: pf(raw.original_invoice_length),
    carrierAuditedWidth: pf(raw.original_invoice_width),
    carrierAuditedHeight: pf(raw.original_invoice_height),
    carrierAuditedWeight: pf(raw.original_invoice_weight),
    carrierAuditedTotal: pf(raw.original_invoice_amount),
    carrierAuditedBaseCharge: pf(raw.original_invoice_base_charge),
    deliveryAreaSurcharge: pf(raw.original_invoice_delivery_area_surcharge),
    fuelSurcharge: pf(raw.original_invoice_fuel_surcharge),
    oversizeSurcharge: pf(raw.original_invoice_oversize_surcharge),
    specialHandlingSurcharge: pf(raw.original_invoice_special_handling_surcharge),
    overmaxSurcharge: pf(raw.original_invoice_overmax_surcharge),
    otherCharges: pf(raw.original_invoice_other_charges),
    invoiceDate: String(raw.invoice_load_day || ''),
    chargeBreakdown: String(raw.invoice_charge_type_list_with_amount || '')
  };
}


/* ===== Merge Engine (Task 7.1) ===== */

function mergeData(taskRows, datanetRows) {
  const datanetMap = new Map();
  datanetRows.forEach((row) => {
    datanetMap.set(row.trackingNumber, row);
  });

  const merged = [];

  // Iterate task engine rows
  taskRows.forEach((teRow) => {
    const dnRow = datanetMap.get(teRow.trackingNumber);
    if (dnRow) {
      merged.push({
        trackingNumber: teRow.trackingNumber,
        shipmentId: teRow.shipmentId,
        orderId: teRow.orderId || '',
        sellerWeight: teRow.sellerWeight,
        sellerLength: teRow.sellerLength,
        sellerWidth: teRow.sellerWidth,
        sellerHeight: teRow.sellerHeight,
        carrier: teRow.carrier,
        serviceName: teRow.serviceName,
        sellerBaseRate: teRow.sellerBaseRate,
        carrierAuditedLength: dnRow.carrierAuditedLength,
        carrierAuditedWidth: dnRow.carrierAuditedWidth,
        carrierAuditedHeight: dnRow.carrierAuditedHeight,
        carrierAuditedWeight: dnRow.carrierAuditedWeight,
        carrierAuditedTotal: dnRow.carrierAuditedTotal,
        carrierAuditedBaseCharge: dnRow.carrierAuditedBaseCharge,
        deliveryAreaSurcharge: dnRow.deliveryAreaSurcharge,
        fuelSurcharge: dnRow.fuelSurcharge,
        oversizeSurcharge: dnRow.oversizeSurcharge,
        specialHandlingSurcharge: dnRow.specialHandlingSurcharge,
        overmaxSurcharge: dnRow.overmaxSurcharge,
        otherCharges: dnRow.otherCharges,
        invoiceDate: dnRow.invoiceDate,
        chargeBreakdown: dnRow.chargeBreakdown
      });
      datanetMap.delete(teRow.trackingNumber);
    } else {
      merged.push({
        trackingNumber: teRow.trackingNumber,
        shipmentId: teRow.shipmentId,
        orderId: teRow.orderId || '',
        sellerWeight: teRow.sellerWeight,
        sellerLength: teRow.sellerLength,
        sellerWidth: teRow.sellerWidth,
        sellerHeight: teRow.sellerHeight,
        carrier: teRow.carrier,
        serviceName: teRow.serviceName,
        sellerBaseRate: teRow.sellerBaseRate,
        carrierAuditedLength: 'N/A',
        carrierAuditedWidth: 'N/A',
        carrierAuditedHeight: 'N/A',
        carrierAuditedWeight: 'N/A',
        carrierAuditedTotal: 'N/A',
        carrierAuditedBaseCharge: 'N/A',
        deliveryAreaSurcharge: 'N/A',
        fuelSurcharge: 'N/A',
        oversizeSurcharge: 'N/A',
        specialHandlingSurcharge: 'N/A',
        overmaxSurcharge: 'N/A',
        otherCharges: 'N/A',
        invoiceDate: 'N/A',
        chargeBreakdown: 'N/A'
      });
    }
  });

  // Remaining unmatched datanet rows
  datanetMap.forEach((dnRow) => {
    merged.push({
      trackingNumber: dnRow.trackingNumber,
      shipmentId: 'N/A',
      orderId: '',
      sellerWeight: 'N/A',
      sellerLength: 'N/A',
      sellerWidth: 'N/A',
      sellerHeight: 'N/A',
      carrier: 'N/A',
      serviceName: 'N/A',
      sellerBaseRate: 'N/A',
      carrierAuditedLength: dnRow.carrierAuditedLength,
      carrierAuditedWidth: dnRow.carrierAuditedWidth,
      carrierAuditedHeight: dnRow.carrierAuditedHeight,
      carrierAuditedWeight: dnRow.carrierAuditedWeight,
      carrierAuditedTotal: dnRow.carrierAuditedTotal,
      carrierAuditedBaseCharge: dnRow.carrierAuditedBaseCharge,
      deliveryAreaSurcharge: dnRow.deliveryAreaSurcharge,
      fuelSurcharge: dnRow.fuelSurcharge,
      oversizeSurcharge: dnRow.oversizeSurcharge,
      specialHandlingSurcharge: dnRow.specialHandlingSurcharge,
      overmaxSurcharge: dnRow.overmaxSurcharge,
      otherCharges: dnRow.otherCharges,
      invoiceDate: dnRow.invoiceDate,
      chargeBreakdown: dnRow.chargeBreakdown
    });
  });

  return merged;
}

/* ===== Calculation Engine (Task 8.1) ===== */

function calculateFields(row) {
  // --- Seller Dimensional Weight ---
  if (row.sellerLength === 'N/A' || row.sellerWidth === 'N/A' || row.sellerHeight === 'N/A') {
    row.sellerDimWeight = 'N/A';
  } else {
    row.sellerDimWeight = Math.round((row.sellerLength * row.sellerWidth * row.sellerHeight) / getDimDivisor(row.carrier) * 100) / 100;
  }

  // --- Carrier Dimensional Weight ---
  if (row.carrierAuditedLength === 'N/A' || row.carrierAuditedWidth === 'N/A' || row.carrierAuditedHeight === 'N/A') {
    row.carrierDimWeight = 'N/A';
  } else {
    row.carrierDimWeight = Math.round((row.carrierAuditedLength * row.carrierAuditedWidth * row.carrierAuditedHeight) / getDimDivisor(row.carrier) * 100) / 100;
  }

  // --- Seller Billable Weight ---
  if (row.sellerWeight === 'N/A' || row.sellerDimWeight === 'N/A') {
    row.sellerBillableWeight = 'N/A';
  } else {
    row.sellerBillableWeight = Math.max(row.sellerWeight, row.sellerDimWeight);
  }

  // --- Carrier Billable Weight ---
  if (row.carrierAuditedWeight === 'N/A' || row.carrierDimWeight === 'N/A') {
    row.carrierBillableWeight = 'N/A';
  } else {
    row.carrierBillableWeight = Math.max(row.carrierAuditedWeight, row.carrierDimWeight);
  }

  // --- Cubic Volume (carrier dims) ---
  if (row.carrierAuditedLength === 'N/A' || row.carrierAuditedWidth === 'N/A' || row.carrierAuditedHeight === 'N/A') {
    row.cubicVolume = 'N/A';
  } else {
    row.cubicVolume = row.carrierAuditedLength * row.carrierAuditedWidth * row.carrierAuditedHeight;
  }

  // --- Length Plus Girth (carrier dims, sorted descending) ---
  if (row.carrierAuditedLength === 'N/A' || row.carrierAuditedWidth === 'N/A' || row.carrierAuditedHeight === 'N/A') {
    row.lengthPlusGirth = 'N/A';
  } else {
    var sortedDims = [row.carrierAuditedLength, row.carrierAuditedWidth, row.carrierAuditedHeight].sort(function(a, b) { return b - a; });
    row.lengthPlusGirth = sortedDims[0] + 2 * sortedDims[1] + 2 * sortedDims[2];
  }

  // Chargeback Amount
  if (row.carrierAuditedTotal === 'N/A' || row.sellerBaseRate === 'N/A') {
    row.chargebackAmount = 'N/A';
  } else {
    row.chargebackAmount = Math.round((row.carrierAuditedTotal - row.sellerBaseRate) * 100) / 100;
  }

  // Weight Match (uses billable weights with 0.5 lb tolerance)
  if (row.sellerBillableWeight === 'N/A' || row.carrierBillableWeight === 'N/A') {
    row.weightMatch = 'N/A';
  } else {
    row.weightMatch = Math.abs(row.sellerBillableWeight - row.carrierBillableWeight) <= 0.5 ? 'Yes' : 'No';
  }

  // Dims Match
  if (row.carrierAuditedLength === 'N/A' || row.carrierAuditedWidth === 'N/A' || row.carrierAuditedHeight === 'N/A') {
    row.dimsMatch = 'N/A';
  } else if (row.sellerLength === 'N/A' || row.sellerWidth === 'N/A' || row.sellerHeight === 'N/A') {
    row.dimsMatch = 'N/A';
  } else {
    const lOk = Math.abs(row.sellerLength - row.carrierAuditedLength) <= 1;
    const wOk = Math.abs(row.sellerWidth - row.carrierAuditedWidth) <= 1;
    const hOk = Math.abs(row.sellerHeight - row.carrierAuditedHeight) <= 1;
    row.dimsMatch = (lOk && wOk && hOk) ? 'Yes' : 'No';
  }

  // Status
  if (row.weightMatch === 'Yes' && row.dimsMatch === 'Yes') {
    row.status = 'Match';
  } else if (row.weightMatch === 'No' || row.dimsMatch === 'No') {
    row.status = 'Mismatch';
  } else {
    row.status = 'Incomplete';
  }

  // --- Surcharge Flags (carrier vs seller comparison) ---
  var carrierDimsSorted = (row.carrierAuditedLength !== 'N/A' && row.carrierAuditedWidth !== 'N/A' && row.carrierAuditedHeight !== 'N/A')
    ? [row.carrierAuditedLength, row.carrierAuditedWidth, row.carrierAuditedHeight].sort(function(a, b) { return b - a; })
    : null;
  var sellerDimsSorted = (row.sellerLength !== 'N/A' && row.sellerWidth !== 'N/A' && row.sellerHeight !== 'N/A')
    ? [row.sellerLength, row.sellerWidth, row.sellerHeight].sort(function(a, b) { return b - a; })
    : null;

  // Compute seller-side metrics for surcharge comparison
  var sellerCubicVolume = sellerDimsSorted ? sellerDimsSorted[0] * sellerDimsSorted[1] * sellerDimsSorted[2] : 'N/A';
  var sellerLengthPlusGirth = sellerDimsSorted ? sellerDimsSorted[0] + 2 * sellerDimsSorted[1] + 2 * sellerDimsSorted[2] : 'N/A';

  var carrierFlags = computeSurchargeFlags(row.carrier, carrierDimsSorted, row.carrierAuditedWeight, row.carrierBillableWeight, row.cubicVolume, row.lengthPlusGirth, row.serviceName || '');
  var sellerFlags = computeSurchargeFlags(row.carrier, sellerDimsSorted, row.sellerWeight, row.sellerBillableWeight, sellerCubicVolume, sellerLengthPlusGirth, row.serviceName || '');

  row.surchargeFlags = carrierFlags.map(function(flagName) {
    return { name: flagName, carrierOnly: sellerFlags.indexOf(flagName) === -1 };
  });

  // --- Dispute Insights ---
  row.disputeInsights = [];

  // Helper: check if any surcharge flag differs between seller and carrier
  var hasCarrierOnlyFlag = row.surchargeFlags.some(function(f) { return f.carrierOnly; });
  var hasSharedFlag = row.surchargeFlags.some(function(f) { return !f.carrierOnly; });

  // Helper: dimension differences
  var dimDiffs = null;
  if (sellerDimsSorted && carrierDimsSorted) {
    dimDiffs = [
      Math.abs(row.sellerLength - row.carrierAuditedLength),
      Math.abs(row.sellerWidth - row.carrierAuditedWidth),
      Math.abs(row.sellerHeight - row.carrierAuditedHeight)
    ];
  }
  var allDimsWithin2 = dimDiffs ? dimDiffs.every(function(d) { return d <= 2; }) : false;

  // Rule 19: Match + no surcharge flag differences
  if (row.status === 'Match' && !hasCarrierOnlyFlag) {
    row.disputeInsights.push('Seller and carrier data match. The chargeback may be due to rate differences rather than dimension errors. Check the charge breakdown for details.');
  }

  // Rule 20: Mismatch + small dim difference (all within 2 inches)
  if (row.status === 'Mismatch' && allDimsWithin2) {
    row.disputeInsights.push('Small dimension difference detected. Carriers round up to the nearest inch. If the seller\'s package was close to a threshold, the carrier\'s measurement may be correct. Photo evidence showing exact measurements will strengthen this dispute.');
  }

  // Rule 21: Mismatch + significant dim weight difference (> 10 lbs)
  if (row.status === 'Mismatch' && row.sellerDimWeight !== 'N/A' && row.carrierDimWeight !== 'N/A') {
    var dimWeightDiff = Math.abs(row.sellerDimWeight - row.carrierDimWeight);
    if (dimWeightDiff > 10) {
      row.disputeInsights.push('The dimensional weight difference is ' + Math.round(dimWeightDiff * 10) / 10 + ' lbs. Even a small change in dimensions can cause a large billable weight change. The carrier will likely defend their audit. Strong photo evidence is essential.');
    }
  }

  // Rule 22: Carrier-only surcharge flag
  row.surchargeFlags.forEach(function(f) {
    if (f.carrierOnly) {
      row.disputeInsights.push('The carrier\'s measurements pushed this package into ' + f.name + ' territory, which the seller\'s dimensions would not have triggered. This is a strong basis for dispute if the seller can prove their measurements are correct.');
    }
  });

  // Rule 23: Both-triggered surcharge flag
  row.surchargeFlags.forEach(function(f) {
    if (!f.carrierOnly) {
      row.disputeInsights.push('Both the seller\'s and carrier\'s measurements trigger ' + f.name + '. Even if the dispute is approved, this surcharge would still apply. The dispute may only recover the rate difference, not the surcharge.');
    }
  });

  // Rule 24: Small chargeback amount (under $1)
  if (row.chargebackAmount !== 'N/A' && row.chargebackAmount < 1) {
    row.disputeInsights.push('The chargeback amount is under $1. Consider whether it is worth disputing \u2014 carrier teams may deprioritise small amounts.');
  }

  // Rule 25: Over Max flag triggered
  if (row.surchargeFlags.some(function(f) { return f.name === 'Over Max'; })) {
    row.disputeInsights.push('This package exceeds carrier maximum limits. Over Max packages are typically rejected or charged at premium rates. Disputes on Over Max charges are rarely successful unless the carrier\'s measurements are clearly wrong.');
  }

  // Rule 26: One Rate Exceeded (FedEx)
  if (row.surchargeFlags.some(function(f) { return f.name === 'One Rate Exceeded'; })) {
    row.disputeInsights.push('This package exceeded FedEx One Rate limits and was re-rated at standard commercial rates. If the seller entered dimensions within One Rate limits but the carrier audited higher, check for the known Veeqo bug (T.Corp D378661796) where Veeqo shows One Rate for ineligible packages.');
  }

  // --- Dispute Strength (priority-ordered: Weak → Moderate → Strong → default Moderate) ---
  var allDimsWithin1 = dimDiffs ? dimDiffs.every(function(d) { return d <= 1; }) : false;
  var billableWeightDiff = (row.sellerBillableWeight !== 'N/A' && row.carrierBillableWeight !== 'N/A')
    ? Math.abs(row.sellerBillableWeight - row.carrierBillableWeight) : 0;
  var anyDimOver2 = dimDiffs ? dimDiffs.some(function(d) { return d > 2; }) : false;
  var sellerHasNoFlags = sellerFlags.length === 0;
  var chargebackNum = (row.chargebackAmount !== 'N/A') ? row.chargebackAmount : null;

  // Check if seller and carrier trigger the same flags (no carrier-only flags)
  var sameFlagsTriggered = row.surchargeFlags.length > 0 && !hasCarrierOnlyFlag;

  row.disputeStrength = 'Moderate'; // default

  // WEAK conditions (check first, first match wins)
  if (row.status === 'Match' && !hasCarrierOnlyFlag) {
    row.disputeStrength = 'Weak';
  } else if (row.surchargeFlags.some(function(f) { return f.name === 'Over Max'; })) {
    row.disputeStrength = 'Weak';
  } else if (chargebackNum !== null && chargebackNum <= 0) {
    row.disputeStrength = 'Weak';
  } else if (sameFlagsTriggered && allDimsWithin1) {
    row.disputeStrength = 'Weak';
  }
  // MODERATE conditions (check second)
  else if (allDimsWithin2 && billableWeightDiff > 5) {
    row.disputeStrength = 'Moderate';
  } else if (hasCarrierOnlyFlag && sellerDimsSorted && carrierDimsSorted) {
    // Check if seller dims are within 10% of threshold — simplified: if carrier-only flag exists but dims are close
    var sellerCloseToThreshold = false;
    row.surchargeFlags.forEach(function(f) {
      if (!f.carrierOnly) return;
      var thresholds = SURCHARGE_THRESHOLDS[(row.carrier || '').toUpperCase()];
      if (!thresholds) return;
      // Check each threshold for the flag
      var flagKey = f.name.replace(/[^a-zA-Z]/g, '_').toUpperCase();
      Object.keys(thresholds).forEach(function(tk) {
        var t = thresholds[tk];
        if (t.longestSide && sellerDimsSorted[0] >= t.longestSide * 0.9) sellerCloseToThreshold = true;
        if (t.secondLongest && sellerDimsSorted[1] >= t.secondLongest * 0.9) sellerCloseToThreshold = true;
        if (t.cubicVolume && sellerCubicVolume !== 'N/A' && sellerCubicVolume >= t.cubicVolume * 0.9) sellerCloseToThreshold = true;
        if (t.lengthPlusGirth && sellerLengthPlusGirth !== 'N/A' && sellerLengthPlusGirth >= t.lengthPlusGirth * 0.9) sellerCloseToThreshold = true;
      });
    });
    if (sellerCloseToThreshold) {
      row.disputeStrength = 'Moderate';
    }
    // If not close to threshold, fall through to Strong checks
    else if (anyDimOver2) {
      row.disputeStrength = 'Strong';
    } else {
      row.disputeStrength = 'Moderate';
    }
  } else if (chargebackNum !== null && chargebackNum < 5) {
    row.disputeStrength = 'Moderate';
  } else if (row.surchargeFlags.some(function(f) { return f.name === 'One Rate Exceeded'; })) {
    row.disputeStrength = 'Moderate';
  }
  // STRONG conditions (check third)
  else if (anyDimOver2 && hasCarrierOnlyFlag) {
    row.disputeStrength = 'Strong';
  } else if (billableWeightDiff > 10 && sellerHasNoFlags) {
    row.disputeStrength = 'Strong';
  } else if (chargebackNum !== null && chargebackNum > 5 && row.status === 'Mismatch' && !hasSharedFlag) {
    row.disputeStrength = 'Strong';
  }

  return row;
}

/* ===== Tab Filter (Task 10.1) ===== */

function filterByTab(rows, tab) {
  if (tab === 'All') return rows;
  if (tab === 'Unmatched') {
    return rows.filter((row) => row.shipmentId === 'N/A' || row.carrierAuditedTotal === 'N/A');
  }
  // Carrier tabs
  return rows.filter((row) => row.carrier === tab.toUpperCase());
}

function updateTabCounts(rows) {
  const tabs = document.querySelectorAll('#tab-bar .tab');
  tabs.forEach((tabBtn) => {
    const tab = tabBtn.dataset.tab;
    const count = filterByTab(rows, tab).length;
    // Render tab name with a badge for the count
    tabBtn.innerHTML = tab + (count > 0
      ? ' <span class="tab-badge">' + count + '</span>'
      : ' <span class="tab-badge tab-badge-zero">0</span>');
    // Hide carrier tabs with 0 rows; always show All and Unmatched
    if (tab === 'All' || tab === 'Unmatched') {
      tabBtn.style.display = '';
    } else {
      tabBtn.style.display = count > 0 ? '' : 'none';
    }
  });
}

function applyDropdownFilters(rows) {
  var f = state.filters;
  return rows.filter(function(r) {
    if (f.disputeStrength !== 'All' && r.disputeStrength !== f.disputeStrength) return false;
    if (f.status !== 'All' && r.status !== f.status) return false;
    if (f.chargebackAmount !== 'All') {
      var amt = r.chargebackAmount;
      if (amt === 'N/A') return false;
      if (f.chargebackAmount === 'Over $50' && amt <= 50) return false;
      if (f.chargebackAmount === 'Over $100' && amt <= 100) return false;
      if (f.chargebackAmount === 'Over $500' && amt <= 500) return false;
      if (f.chargebackAmount === 'Under $1' && amt >= 1) return false;
    }
    if (f.surchargeFlags !== 'All') {
      var hasFlags = Array.isArray(r.surchargeFlags) && r.surchargeFlags.length > 0;
      if (f.surchargeFlags === 'Has flags' && !hasFlags) return false;
      if (f.surchargeFlags === 'No flags' && hasFlags) return false;
    }
    return true;
  });
}

function getFilteredRows() {
  var tabFiltered = filterByTab(state.mergedRows, state.activeTab);
  return applyDropdownFilters(tabFiltered);
}

function refreshTableWithFilters() {
  var filtered = getFilteredRows();
  state.selectedRowIndices = new Set(filtered.map(function(_, i) { return i; }));
  renderTable(filtered);
}

function renderFilterBar() {
  var existing = document.getElementById('filter-bar');
  if (existing) existing.remove();

  var bar = document.createElement('div');
  bar.id = 'filter-bar';
  bar.className = 'filter-bar';

  function makeFilter(label, stateKey, options) {
    var wrapper = document.createElement('div');
    wrapper.className = 'filter-group';
    var lbl = document.createElement('label');
    lbl.className = 'filter-label';
    lbl.textContent = label;
    var sel = document.createElement('select');
    sel.className = 'filter-select';
    options.forEach(function(opt) {
      var o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      if (state.filters[stateKey] === opt) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function() {
      state.filters[stateKey] = sel.value;
      refreshTableWithFilters();
    });
    wrapper.appendChild(lbl);
    wrapper.appendChild(sel);
    return wrapper;
  }

  bar.appendChild(makeFilter('Strength:', 'disputeStrength', ['All', 'Strong', 'Moderate', 'Weak']));
  bar.appendChild(makeFilter('Status:', 'status', ['All', 'Match', 'Mismatch', 'Incomplete']));
  bar.appendChild(makeFilter('Chargeback:', 'chargebackAmount', ['All', 'Over $50', 'Over $100', 'Over $500', 'Under $1']));
  bar.appendChild(makeFilter('Flags:', 'surchargeFlags', ['All', 'Has flags', 'No flags']));

  var clearLink = document.createElement('a');
  clearLink.href = '#';
  clearLink.className = 'filter-clear';
  clearLink.textContent = 'Clear filters';
  clearLink.addEventListener('click', function(e) {
    e.preventDefault();
    state.filters.disputeStrength = 'All';
    state.filters.status = 'All';
    state.filters.chargebackAmount = 'All';
    state.filters.surchargeFlags = 'All';
    renderFilterBar();
    refreshTableWithFilters();
  });
  bar.appendChild(clearLink);

  var tableContainer = document.getElementById('table-container');
  tableContainer.parentNode.insertBefore(bar, tableContainer);
}


/* ===== Table Renderer (Task 10.3) ===== */

const COLUMNS = [
  // Default visible columns
  { key: 'trackingNumber', label: 'Tracking Number', monetary: false, defaultVisible: true },
  { key: 'carrier', label: 'Carrier', monetary: false, defaultVisible: true },
  { key: 'serviceName', label: 'Service Name', monetary: false, defaultVisible: true },
  { key: 'sellerDimsCombined', label: 'Seller Dims (in)', monetary: false, defaultVisible: true, computed: true },
  { key: 'sellerBillableWeight', label: 'Seller Billable Weight (lbs)', monetary: false, defaultVisible: true },
  { key: 'carrierDimsCombined', label: 'Carrier Dims (in)', monetary: false, defaultVisible: true, computed: true },
  { key: 'carrierBillableWeight', label: 'Carrier Billable Weight (lbs)', monetary: false, defaultVisible: true },
  { key: 'chargebackAmount', label: 'Chargeback Amount ($)', monetary: true, defaultVisible: true },
  { key: 'status', label: 'Status', monetary: false, defaultVisible: true },
  { key: 'surchargeFlags', label: 'Surcharge Flags', monetary: false, defaultVisible: true },
  // Hidden by default columns
  { key: 'shipmentId', label: 'Shipment ID', monetary: false, defaultVisible: false },
  { key: 'sellerWeight', label: 'Seller Weight', monetary: false, defaultVisible: false },
  { key: 'sellerLength', label: 'Seller Length', monetary: false, defaultVisible: false },
  { key: 'sellerWidth', label: 'Seller Width', monetary: false, defaultVisible: false },
  { key: 'sellerHeight', label: 'Seller Height', monetary: false, defaultVisible: false },
  { key: 'sellerDimWeight', label: 'Seller Dim Weight (lbs)', monetary: false, defaultVisible: false },
  { key: 'sellerBaseRate', label: 'Seller Base Rate ($)', monetary: true, defaultVisible: false },
  { key: 'carrierAuditedWeight', label: 'Carrier Audited Weight', monetary: false, defaultVisible: false },
  { key: 'carrierAuditedLength', label: 'Carrier Audited Length', monetary: false, defaultVisible: false },
  { key: 'carrierAuditedWidth', label: 'Carrier Audited Width', monetary: false, defaultVisible: false },
  { key: 'carrierAuditedHeight', label: 'Carrier Audited Height', monetary: false, defaultVisible: false },
  { key: 'carrierDimWeight', label: 'Carrier Dim Weight (lbs)', monetary: false, defaultVisible: false },
  { key: 'carrierAuditedTotal', label: 'Carrier Audited Total ($)', monetary: true, defaultVisible: false },
  { key: 'carrierAuditedBaseCharge', label: 'Carrier Audited Base Charge ($)', monetary: true, defaultVisible: false },
  { key: 'deliveryAreaSurcharge', label: 'Delivery Area Surcharge ($)', monetary: true, defaultVisible: false },
  { key: 'fuelSurcharge', label: 'Fuel Surcharge ($)', monetary: true, defaultVisible: false },
  { key: 'oversizeSurcharge', label: 'Oversize Surcharge ($)', monetary: true, defaultVisible: false },
  { key: 'specialHandlingSurcharge', label: 'Special Handling Surcharge ($)', monetary: true, defaultVisible: false },
  { key: 'overmaxSurcharge', label: 'Overmax Surcharge ($)', monetary: true, defaultVisible: false },
  { key: 'otherCharges', label: 'Other Charges ($)', monetary: true, defaultVisible: false },
  { key: 'cubicVolume', label: 'Cubic Volume (in³)', monetary: false, defaultVisible: false },
  { key: 'lengthPlusGirth', label: 'Length + Girth (in)', monetary: false, defaultVisible: false },
  { key: 'invoiceDate', label: 'Invoice Date', monetary: false, defaultVisible: false },
  { key: 'chargeBreakdown', label: 'Charge Breakdown', monetary: false, defaultVisible: false },
  { key: 'weightMatch', label: 'Weight Match', monetary: false, defaultVisible: false },
  { key: 'dimsMatch', label: 'Dims Match', monetary: false, defaultVisible: false }
];

// Column visibility state
var showAllColumns = false;

function getVisibleColumns() {
  if (showAllColumns) return COLUMNS;
  return COLUMNS.filter(function(col) { return col.defaultVisible; });
}

function formatDimsCombined(l, w, h) {
  if (l === 'N/A' || w === 'N/A' || h === 'N/A') return 'N/A';
  return l + ' x ' + w + ' x ' + h;
}

function getComputedValue(row, key) {
  if (key === 'sellerDimsCombined') return formatDimsCombined(row.sellerLength, row.sellerWidth, row.sellerHeight);
  if (key === 'carrierDimsCombined') return formatDimsCombined(row.carrierAuditedLength, row.carrierAuditedWidth, row.carrierAuditedHeight);
  return row[key];
}

function buildDisputePopup(row) {
  var popup = document.createElement('div');
  popup.className = 'dispute-popup';

  var strength = row.disputeStrength || 'Moderate';

  // Header badge
  var header = document.createElement('div');
  header.className = 'dispute-popup-header';
  var headerBadge = document.createElement('span');
  headerBadge.textContent = strength.toUpperCase() + ' DISPUTE';
  if (strength === 'Strong') headerBadge.className = 'badge-strong';
  else if (strength === 'Weak') headerBadge.className = 'badge-weak';
  else headerBadge.className = 'badge-moderate';
  header.appendChild(headerBadge);
  popup.appendChild(header);

  // "Why this is [strength]" subheader
  var whyLabel = document.createElement('div');
  whyLabel.className = 'dispute-popup-why';
  whyLabel.textContent = 'Why this is ' + strength.toLowerCase() + ':';
  popup.appendChild(whyLabel);

  // Dims comparison block
  var sellerDims = formatDimsCombined(row.sellerLength, row.sellerWidth, row.sellerHeight);
  var carrierDims = formatDimsCombined(row.carrierAuditedLength, row.carrierAuditedWidth, row.carrierAuditedHeight);
  var sDimW = (row.sellerDimWeight !== 'N/A' && row.sellerDimWeight !== undefined) ? row.sellerDimWeight : 'N/A';
  var cDimW = (row.carrierDimWeight !== 'N/A' && row.carrierDimWeight !== undefined) ? row.carrierDimWeight : 'N/A';
  var sBillW = (row.sellerBillableWeight !== 'N/A' && row.sellerBillableWeight !== undefined) ? row.sellerBillableWeight : 'N/A';
  var cBillW = (row.carrierBillableWeight !== 'N/A' && row.carrierBillableWeight !== undefined) ? row.carrierBillableWeight : 'N/A';

  var dimsBlock = document.createElement('div');
  dimsBlock.className = 'dispute-popup-dims';
  dimsBlock.innerHTML =
    '<div>Seller: ' + sellerDims + ' in (dim weight: ' + sDimW + ' lbs, billable: ' + sBillW + ' lbs)</div>' +
    '<div>Carrier: ' + carrierDims + ' in (dim weight: ' + cDimW + ' lbs, billable: ' + cBillW + ' lbs)</div>';
  popup.appendChild(dimsBlock);

  // Dimension difference analysis
  var analysisLines = [];
  if (row.sellerLength !== 'N/A' && row.carrierAuditedLength !== 'N/A' &&
      row.sellerWidth !== 'N/A' && row.carrierAuditedWidth !== 'N/A' &&
      row.sellerHeight !== 'N/A' && row.carrierAuditedHeight !== 'N/A') {
    var diffs = [
      { name: 'length', seller: row.sellerLength, carrier: row.carrierAuditedLength },
      { name: 'width', seller: row.sellerWidth, carrier: row.carrierAuditedWidth },
      { name: 'height', seller: row.sellerHeight, carrier: row.carrierAuditedHeight }
    ];
    var diffParts = diffs.filter(function(d) { return d.seller !== d.carrier; });
    if (diffParts.length === 0) {
      analysisLines.push('All dimensions match exactly.');
    } else {
      diffParts.forEach(function(d) {
        var diff = Math.abs(d.seller - d.carrier);
        var rounded = Math.round(diff * 10) / 10;
        analysisLines.push('The ' + d.name + ' differs by ' + rounded + ' inches (seller: ' + d.seller + ', carrier: ' + d.carrier + ').');
      });
      var allWithin1 = diffParts.every(function(d) { return Math.abs(d.seller - d.carrier) <= 1; });
      if (allWithin1) {
        analysisLines.push('Carriers round up to the nearest inch, so this is likely a valid carrier measurement.');
      }
    }
  }

  // Billable weight impact
  if (sBillW !== 'N/A' && cBillW !== 'N/A') {
    var bwDiff = Math.round(Math.abs(sBillW - cBillW) * 10) / 10;
    if (bwDiff > 0) {
      analysisLines.push('The billable weight ' + (cBillW > sBillW ? 'increased' : 'decreased') + ' by ' + bwDiff + ' lbs due to the dimension change.');
    }
  }

  // Surcharge flag explanations with actual values
  if (Array.isArray(row.surchargeFlags) && row.surchargeFlags.length > 0) {
    var sellerSorted = (row.sellerLength !== 'N/A' && row.sellerWidth !== 'N/A' && row.sellerHeight !== 'N/A')
      ? [row.sellerLength, row.sellerWidth, row.sellerHeight].sort(function(a, b) { return b - a; }) : null;
    var carrierSorted = (row.carrierAuditedLength !== 'N/A' && row.carrierAuditedWidth !== 'N/A' && row.carrierAuditedHeight !== 'N/A')
      ? [row.carrierAuditedLength, row.carrierAuditedWidth, row.carrierAuditedHeight].sort(function(a, b) { return b - a; }) : null;

    row.surchargeFlags.forEach(function(f) {
      if (f.carrierOnly) {
        analysisLines.push('The carrier\'s measurements triggered ' + f.name + ' which the seller\'s dimensions would not have. This is a strong basis for dispute with photo evidence.');
      } else {
        var detail = '';
        if (f.name === 'AHS-Dimension' && sellerSorted && carrierSorted) {
          detail = ' (longest side: seller ' + sellerSorted[0] + ' in, carrier ' + carrierSorted[0] + ' in; second longest: seller ' + sellerSorted[1] + ' in, carrier ' + carrierSorted[1] + ' in)';
        } else if (f.name === 'AHS-Weight') {
          detail = ' (seller billable: ' + sBillW + ' lbs, carrier billable: ' + cBillW + ' lbs)';
        } else if (f.name === 'Over Max' && carrierSorted) {
          detail = ' (carrier longest side: ' + carrierSorted[0] + ' in, weight: ' + row.carrierAuditedWeight + ' lbs)';
        }
        analysisLines.push('Both seller and carrier trigger ' + f.name + detail + '. This surcharge applies regardless of dispute outcome.');
      }
    });
  }

  // Build analysis section
  if (analysisLines.length > 0) {
    var analysisList = document.createElement('ul');
    analysisList.className = 'dispute-popup-analysis';
    analysisLines.forEach(function(line) {
      var li = document.createElement('li');
      li.textContent = line;
      analysisList.appendChild(li);
    });
    popup.appendChild(analysisList);
  }

  // Stats footer
  var stats = document.createElement('div');
  stats.className = 'dispute-popup-stats';
  var cbAmt = row.chargebackAmount !== 'N/A' ? '$' + Number(row.chargebackAmount).toFixed(2) : 'N/A';
  stats.appendChild(createStatLine('Chargeback: ' + cbAmt));

  if (Array.isArray(row.surchargeFlags) && row.surchargeFlags.length > 0) {
    var hasShared = row.surchargeFlags.some(function(f) { return !f.carrierOnly; });
    var hasCarrierOnly = row.surchargeFlags.some(function(f) { return f.carrierOnly; });
    if (hasShared && !hasCarrierOnly) {
      stats.appendChild(createStatLine('What the seller can recover: the rate difference only, not the surcharge.'));
    } else if (hasCarrierOnly) {
      stats.appendChild(createStatLine('The carrier-only surcharges are disputable with evidence.'));
    }
  }

  // Recommendation
  var rec = document.createElement('div');
  rec.className = 'dispute-popup-recommendation';
  if (strength === 'Strong') {
    rec.textContent = 'Recommendation: Strong dispute candidate. Request photo evidence from the seller and proceed.';
  } else if (strength === 'Weak') {
    if (row.chargebackAmount !== 'N/A' && row.chargebackAmount <= 0) {
      rec.textContent = 'Recommendation: No overcharge detected. No action needed.';
    } else {
      rec.textContent = 'Recommendation: Dispute is unlikely to succeed unless the seller has photo evidence proving their measurements are correct.';
    }
  } else {
    rec.textContent = 'Recommendation: Could go either way. Request photo evidence before deciding whether to dispute.';
  }
  stats.appendChild(rec);

  popup.appendChild(stats);
  return popup;
}

function createStatLine(text) {
  var div = document.createElement('div');
  div.className = 'dispute-popup-stat';
  div.textContent = text;
  return div;
}

function formatMonetary(val) {
  if (val === 'N/A') return 'N/A';
  return '$' + Number(val).toFixed(2);
}

function renderDisputeStrengthSummary(rows) {
  var existing = document.getElementById('dispute-strength-summary');
  if (existing) existing.remove();

  if (!rows || rows.length === 0) return;

  var strong = 0, moderate = 0, weak = 0;
  rows.forEach(function(r) {
    if (r.disputeStrength === 'Strong') strong++;
    else if (r.disputeStrength === 'Weak') weak++;
    else moderate++;
  });

  var bar = document.createElement('div');
  bar.id = 'dispute-strength-summary';
  bar.className = 'dispute-strength-summary';
  bar.innerHTML =
    '<span class="badge-strong">' + strong + ' Strong</span> ' +
    '<span class="badge-moderate">' + moderate + ' Moderate</span> ' +
    '<span class="badge-weak">' + weak + ' Weak</span>';

  var exportBtn = document.createElement('button');
  exportBtn.className = 'btn-export-insights';
  exportBtn.textContent = 'Export Insights';
  exportBtn.addEventListener('click', function() { exportInsightsCSV(rows); });
  bar.appendChild(exportBtn);

  var tableContainer = document.getElementById('table-container');
  tableContainer.parentNode.insertBefore(bar, tableContainer);
}

function buildInsightText(row) {
  var lines = [];
  var strength = row.disputeStrength || 'Moderate';
  lines.push(strength.toUpperCase() + ' DISPUTE');

  // Dims comparison
  var sellerDims = formatDimsCombined(row.sellerLength, row.sellerWidth, row.sellerHeight);
  var carrierDims = formatDimsCombined(row.carrierAuditedLength, row.carrierAuditedWidth, row.carrierAuditedHeight);
  var sDimW = (row.sellerDimWeight !== 'N/A' && row.sellerDimWeight !== undefined) ? row.sellerDimWeight : 'N/A';
  var cDimW = (row.carrierDimWeight !== 'N/A' && row.carrierDimWeight !== undefined) ? row.carrierDimWeight : 'N/A';
  var sBillW = (row.sellerBillableWeight !== 'N/A' && row.sellerBillableWeight !== undefined) ? row.sellerBillableWeight : 'N/A';
  var cBillW = (row.carrierBillableWeight !== 'N/A' && row.carrierBillableWeight !== undefined) ? row.carrierBillableWeight : 'N/A';

  lines.push('Seller: ' + sellerDims + ' in (dim: ' + sDimW + ' lbs, billable: ' + sBillW + ' lbs)');
  lines.push('Carrier: ' + carrierDims + ' in (dim: ' + cDimW + ' lbs, billable: ' + cBillW + ' lbs)');

  // Dim diffs
  if (row.sellerLength !== 'N/A' && row.carrierAuditedLength !== 'N/A') {
    var diffs = [
      { name: 'length', s: row.sellerLength, c: row.carrierAuditedLength },
      { name: 'width', s: row.sellerWidth, c: row.carrierAuditedWidth },
      { name: 'height', s: row.sellerHeight, c: row.carrierAuditedHeight }
    ].filter(function(d) { return d.s !== 'N/A' && d.c !== 'N/A' && d.s !== d.c; });
    diffs.forEach(function(d) {
      lines.push('The ' + d.name + ' differs by ' + (Math.round(Math.abs(d.s - d.c) * 10) / 10) + ' in (seller: ' + d.s + ', carrier: ' + d.c + ')');
    });
  }

  if (sBillW !== 'N/A' && cBillW !== 'N/A') {
    var bwDiff = Math.round(Math.abs(sBillW - cBillW) * 10) / 10;
    if (bwDiff > 0) lines.push('Billable weight diff: ' + bwDiff + ' lbs');
  }

  if (Array.isArray(row.surchargeFlags) && row.surchargeFlags.length > 0) {
    row.surchargeFlags.forEach(function(f) {
      if (f.carrierOnly) {
        lines.push('Carrier-only surcharge: ' + f.name);
      } else {
        lines.push('Shared surcharge: ' + f.name + ' (applies regardless)');
      }
    });
  }

  var cbAmt = row.chargebackAmount !== 'N/A' ? '$' + Number(row.chargebackAmount).toFixed(2) : 'N/A';
  lines.push('Chargeback: ' + cbAmt);

  if (strength === 'Strong') {
    lines.push('Recommendation: Strong dispute candidate. Request photo evidence and proceed.');
  } else if (strength === 'Weak') {
    lines.push('Recommendation: Dispute unlikely to succeed without strong evidence.');
  } else {
    lines.push('Recommendation: Could go either way. Request photo evidence before deciding.');
  }

  return lines.join('\n');
}

function exportInsightsCSV(rows) {
  var headers = ['Tracking Number', 'Dispute Strength', 'Chargeback Amount', 'Insight'];
  var csvRows = [headers.join(',')];
  rows.forEach(function(r) {
    var cbAmt = r.chargebackAmount !== 'N/A' ? Number(r.chargebackAmount).toFixed(2) : 'N/A';
    var insight = buildInsightText(r);
    var vals = [
      r.trackingNumber,
      r.disputeStrength || 'Moderate',
      cbAmt,
      '"' + insight.replace(/"/g, '""') + '"'
    ];
    csvRows.push(vals.join(','));
  });
  downloadCSV(csvRows.join('\n'), 'veeqo-dispute-insights');
}

function renderTable(rows) {
  const table = document.getElementById('data-table');
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  thead.innerHTML = '';
  tbody.innerHTML = '';

  // Dispute strength summary counts above the table
  renderDisputeStrengthSummary(rows);

  // Filter bar
  renderFilterBar();

  // Column toggle button
  var toggleBar = document.getElementById('column-toggle-bar');
  if (!toggleBar) {
    toggleBar = document.createElement('div');
    toggleBar.id = 'column-toggle-bar';
    toggleBar.className = 'column-toggle-bar';
    var tableContainer = document.getElementById('table-container');
    tableContainer.parentNode.insertBefore(toggleBar, tableContainer);
  }
  toggleBar.innerHTML = '';
  var toggleBtn = document.createElement('button');
  toggleBtn.className = 'btn-toggle-columns';
  toggleBtn.textContent = showAllColumns ? 'Hide extra columns' : 'Show all columns';
  toggleBtn.addEventListener('click', function() {
    showAllColumns = !showAllColumns;
    renderTable(rows);
  });
  toggleBar.appendChild(toggleBtn);

  var visibleCols = getVisibleColumns();

  // Header row
  const headerRow = document.createElement('tr');
  const selectAllTh = document.createElement('th');
  const selectAllCb = document.createElement('input');
  selectAllCb.type = 'checkbox';
  selectAllCb.id = 'select-all-cb';
  selectAllCb.setAttribute('aria-label', 'Select All');
  selectAllTh.appendChild(selectAllCb);
  headerRow.appendChild(selectAllTh);

  // Dispute Strength header (second column, after checkbox)
  const strengthTh = document.createElement('th');
  strengthTh.textContent = 'Dispute Strength';
  strengthTh.style.cursor = 'pointer';
  // Hint text on first load
  if (!window._disputeHoverHintShown) {
    var hint = document.createElement('div');
    hint.className = 'dispute-hover-hint';
    hint.id = 'dispute-hover-hint';
    hint.textContent = 'Hover over badges for details';
    strengthTh.appendChild(hint);
  }
  strengthTh.addEventListener('click', function() {
    var order = strengthTh._sortAsc ? -1 : 1;
    strengthTh._sortAsc = !strengthTh._sortAsc;
    var priority = { 'Strong': 0, 'Moderate': 1, 'Weak': 2 };
    rows.sort(function(a, b) {
      var pa = priority[a.disputeStrength] !== undefined ? priority[a.disputeStrength] : 1;
      var pb = priority[b.disputeStrength] !== undefined ? priority[b.disputeStrength] : 1;
      return (pa - pb) * order;
    });
    renderTable(rows);
  });
  headerRow.appendChild(strengthTh);

  visibleCols.forEach(function(col) {
    const th = document.createElement('th');
    th.textContent = col.label;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);

  // Data rows
  rows.forEach(function(row, idx) {
    const tr = document.createElement('tr');

    // Checkbox cell
    const cbTd = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.setAttribute('aria-label', 'Select row ' + (idx + 1));
    cb.dataset.rowIndex = idx;
    if (state.selectedRowIndices.has(idx)) cb.checked = true;
    cb.addEventListener('change', function() {
      if (cb.checked) {
        state.selectedRowIndices.add(idx);
      } else {
        state.selectedRowIndices.delete(idx);
      }
      syncSelectAll(rows);
    });
    cbTd.appendChild(cb);
    tr.appendChild(cbTd);

    // Dispute Strength badge cell with hover popup
    const strengthTd = document.createElement('td');
    strengthTd.className = 'dispute-strength-cell';
    const badge = document.createElement('span');
    const strength = row.disputeStrength || 'Moderate';
    badge.textContent = strength;
    if (strength === 'Strong') badge.className = 'badge-strong badge-hoverable';
    else if (strength === 'Weak') badge.className = 'badge-weak badge-hoverable';
    else badge.className = 'badge-moderate badge-hoverable';

    var hoverTimeout = null;
    var currentPopup = null;

    strengthTd.addEventListener('mouseenter', function() {
      clearTimeout(hoverTimeout);
      // Remove hint on first hover
      if (!window._disputeHoverHintShown) {
        window._disputeHoverHintShown = true;
        var hintEl = document.getElementById('dispute-hover-hint');
        if (hintEl) hintEl.remove();
      }
      // Close any other open popups
      document.querySelectorAll('.dispute-popup').forEach(function(p) { p.remove(); });
      document.querySelectorAll('.badge-active').forEach(function(b) { b.classList.remove('badge-active'); });
      currentPopup = buildDisputePopup(row);
      document.body.appendChild(currentPopup);
      // Position next to the badge using viewport coords
      var rect = badge.getBoundingClientRect();
      currentPopup.style.left = (rect.right + 8) + 'px';
      currentPopup.style.display = 'block';
      var popupRect = currentPopup.getBoundingClientRect();
      // If popup goes off-screen right, flip to left side
      if (popupRect.right > window.innerWidth - 10) {
        currentPopup.style.left = (rect.left - popupRect.width - 8) + 'px';
      }
      // If popup would overflow bottom of viewport, anchor to bottom instead of top
      var popupHeight = popupRect.height;
      if (rect.top + popupHeight > window.innerHeight - 10) {
        currentPopup.style.top = Math.max(10, window.innerHeight - popupHeight - 10) + 'px';
      } else {
        currentPopup.style.top = rect.top + 'px';
      }
      badge.classList.add('badge-active');
      // Keep popup alive when hovering over it
      currentPopup.addEventListener('mouseenter', function() { clearTimeout(hoverTimeout); });
      currentPopup.addEventListener('mouseleave', function() {
        hoverTimeout = setTimeout(function() {
          if (currentPopup) { currentPopup.remove(); currentPopup = null; }
          badge.classList.remove('badge-active');
        }, 300);
      });
    });

    strengthTd.addEventListener('mouseleave', function(e) {
      hoverTimeout = setTimeout(function() {
        if (currentPopup) { currentPopup.remove(); currentPopup = null; }
        badge.classList.remove('badge-active');
      }, 300);
    });

    strengthTd.appendChild(badge);
    tr.appendChild(strengthTd);

    // Data columns
    visibleCols.forEach(function(col) {
      const td = document.createElement('td');
      const val = col.computed ? getComputedValue(row, col.key) : row[col.key];

      // Special rendering for surchargeFlags
      if (col.key === 'surchargeFlags') {
        if (Array.isArray(val) && val.length > 0) {
          val.forEach(function(flag, fi) {
            if (fi > 0) td.appendChild(document.createTextNode(', '));
            var span = document.createElement('span');
            if (flag.carrierOnly) {
              span.className = 'flag-carrier-only';
              span.textContent = flag.name + ' (carrier only)';
            } else {
              span.className = 'flag-shared';
              span.textContent = flag.name;
            }
            td.appendChild(span);
          });
        }
      }
      else if (col.monetary) {
        td.textContent = formatMonetary(val);
      } else {
        td.textContent = (val !== undefined && val !== null) ? val : '';
      }

      // Status color coding
      if (col.key === 'status') {
        if (val === 'Match') td.classList.add('status-match');
        else if (val === 'Mismatch') td.classList.add('status-mismatch');
        else if (val === 'Incomplete') td.classList.add('status-incomplete');
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });

  // Select All handler
  selectAllCb.addEventListener('change', function() {
    const checkboxes = tbody.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(function(cb) {
      const i = parseInt(cb.dataset.rowIndex, 10);
      cb.checked = selectAllCb.checked;
      if (selectAllCb.checked) {
        state.selectedRowIndices.add(i);
      } else {
        state.selectedRowIndices.delete(i);
      }
    });
  });

  syncSelectAll(rows);

  // Update row count
  document.getElementById('row-count').textContent = rows.length + ' shipments';

  // Update action buttons visibility
  updateActionButtons();
}

function syncSelectAll(rows) {
  const selectAllCb = document.getElementById('select-all-cb');
  if (!selectAllCb || rows.length === 0) return;
  const allSelected = rows.every((_, idx) => state.selectedRowIndices.has(idx));
  selectAllCb.checked = allSelected;
}

function updateActionButtons() {
  const actionBar = document.getElementById('action-buttons');
  if (state.mergedRows.length === 0) {
    actionBar.style.display = 'none';
    return;
  }
  actionBar.style.display = 'flex';

  const fedexBtn = document.getElementById('send-fedex-email-btn');
  const disputeBtn = document.getElementById('create-dispute-tcorp-btn');
  const splatBtn = document.getElementById('create-splat-tcorp-btn');
  const disputeCsvBtn = document.getElementById('export-dispute-csv-btn');
  const splatCsvBtn = document.getElementById('export-splat-csv-btn');

  const tab = state.activeTab;

  if (tab === 'FedEx') {
    fedexBtn.style.display = '';
    disputeBtn.style.display = 'none';
    splatBtn.style.display = '';
    disputeCsvBtn.style.display = '';
    splatCsvBtn.style.display = '';
  } else if (tab === 'Unmatched') {
    fedexBtn.style.display = 'none';
    disputeBtn.style.display = 'none';
    splatBtn.style.display = 'none';
    disputeCsvBtn.style.display = '';
    splatCsvBtn.style.display = '';
  } else if (tab === 'All') {
    fedexBtn.style.display = 'none';
    disputeBtn.style.display = '';
    splatBtn.style.display = '';
    disputeCsvBtn.style.display = '';
    splatCsvBtn.style.display = '';
  } else {
    // UPS, USPS, DHL, OnTrac
    fedexBtn.style.display = 'none';
    disputeBtn.style.display = '';
    splatBtn.style.display = '';
    disputeCsvBtn.style.display = '';
    splatCsvBtn.style.display = '';
  }
}


/* ===== FedEx Email Template (Task 11.1) ===== */

function generateFedExEmail(rows, agentName) {
  let text = 'Dear FedEx QuickResponse Team,\n\n';
  text += 'I am ' + agentName + ', from the Veeqo Support Team. I am writing to request assistance with chargeback/adjustment disputes on behalf of a seller using Veeqo. Full details for all affected labels are provided below:\n\n';

  rows.forEach((row) => {
    text += 'Shipment Details:\n';
    text += 'Order ID: \n';
    text += 'Tracking ID: ' + row.trackingNumber + '\n';
    text += 'Ship Method: ' + row.serviceName + '\n';
    text += 'Linked Account?: \n\n';

    text += 'Dimensions:\n';
    var sDimW = (row.sellerDimWeight !== undefined && row.sellerDimWeight !== 'N/A') ? row.sellerDimWeight : 'N/A';
    var sBillW = (row.sellerBillableWeight !== undefined && row.sellerBillableWeight !== 'N/A') ? row.sellerBillableWeight : 'N/A';
    text += 'Seller: ' + row.sellerLength + ' x ' + row.sellerWidth + ' x ' + row.sellerHeight + ' in, ' + row.sellerWeight + ' lbs (dim weight: ' + sDimW + ' lbs, billable: ' + sBillW + ' lbs)\n';
    var cDimW = (row.carrierDimWeight !== undefined && row.carrierDimWeight !== 'N/A') ? row.carrierDimWeight : 'N/A';
    var cBillW = (row.carrierBillableWeight !== undefined && row.carrierBillableWeight !== 'N/A') ? row.carrierBillableWeight : 'N/A';
    text += 'Carrier Audit: ' + row.carrierAuditedLength + ' x ' + row.carrierAuditedWidth + ' x ' + row.carrierAuditedHeight + ' in, ' + row.carrierAuditedWeight + ' lbs (dim weight: ' + cDimW + ' lbs, billable: ' + cBillW + ' lbs)\n\n';

    text += 'Chargeback/adjustment amount: $' + (row.chargebackAmount === 'N/A' ? 'N/A' : Number(row.chargebackAmount).toFixed(2)) + '\n\n';
    text += '---\n\n';
  });

  text += 'The seller is disputing these charges as they have reported that their dimensions were correct and have provided evidence (attached).\n\n';
  text += 'REMINDER: Attach the CSV export and seller evidence before sending.\n\n';
  text += 'Thank you, ' + agentName;

  return text;
}

/* ===== T.Corp Fields Template (Task 11.3) ===== */

function generateTCorpFields(rows) {
  const trackingIds = rows.map(r => r.trackingNumber).join(', ');
  const amounts = rows.map(r => (r.chargebackAmount === 'N/A' ? 0 : Number(r.chargebackAmount)));
  const totalAmount = amounts.reduce((a, b) => a + b, 0);
  const carrier = rows[0] ? rows[0].carrier : 'N/A';
  const count = rows.length;

  // Date range
  const dates = rows.map(r => r.invoiceDate).filter(d => d && d !== 'N/A').sort();
  const earliest = dates.length > 0 ? dates[0] : 'N/A';
  const latest = dates.length > 0 ? dates[dates.length - 1] : 'N/A';

  let text = 'Tracking IDs: ' + trackingIds + '\n';
  text += 'Total Dispute Amount: $' + totalAmount.toFixed(2) + '\n';
  text += 'Carrier: ' + carrier + '\n';
  text += 'Number of Shipments: ' + count + '\n';
  text += 'Ship Dates: ' + earliest + ' to ' + latest + '\n\n';
  text += 'Per-shipment breakdown:\n';

  rows.forEach((row) => {
    const amt = row.chargebackAmount === 'N/A' ? 'N/A' : '$' + Number(row.chargebackAmount).toFixed(2);
    var sDimW = (row.sellerDimWeight !== undefined && row.sellerDimWeight !== 'N/A') ? row.sellerDimWeight : 'N/A';
    var sBillW = (row.sellerBillableWeight !== undefined && row.sellerBillableWeight !== 'N/A') ? row.sellerBillableWeight : 'N/A';
    var cDimW = (row.carrierDimWeight !== undefined && row.carrierDimWeight !== 'N/A') ? row.carrierDimWeight : 'N/A';
    var cBillW = (row.carrierBillableWeight !== undefined && row.carrierBillableWeight !== 'N/A') ? row.carrierBillableWeight : 'N/A';
    text += row.trackingNumber + ' | Seller: ' + row.sellerLength + 'x' + row.sellerWidth + 'x' + row.sellerHeight + ' ' + row.sellerWeight + 'lbs (dim: ' + sDimW + 'lbs, billable: ' + sBillW + 'lbs) | Carrier: ' + row.carrierAuditedLength + 'x' + row.carrierAuditedWidth + 'x' + row.carrierAuditedHeight + ' ' + row.carrierAuditedWeight + 'lbs (dim: ' + cDimW + 'lbs, billable: ' + cBillW + 'lbs) | Chargeback: ' + amt + '\n';
  });

  return text;
}

/* ===== SPLAT T.Corp Fields Template (Task 11.5) ===== */

function generateSplatTCorpFields(rows) {
  const count = rows.length;
  const amounts = rows.map(r => (r.chargebackAmount === 'N/A' ? 0 : Number(r.chargebackAmount)));
  const totalAmount = amounts.reduce((a, b) => a + b, 0);

  let text = 'Number of Orders: ' + count + '\n';
  text += 'Total Refund Amount: $' + totalAmount.toFixed(2) + '\n\n';

  rows.forEach((row) => {
    const amt = row.chargebackAmount === 'N/A' ? 'N/A' : '$' + Number(row.chargebackAmount).toFixed(2);
    text += 'Tracking ID: ' + row.trackingNumber + '\n';
    text += 'Refund Amount: ' + amt + '\n';
  });

  return text;
}

/* ===== CSV Export (Task 12.1) ===== */

function exportCSV(rows, tabName) {
  const headers = COLUMNS.map(c => c.label);
  const csvRows = [headers.join(',')];

  rows.forEach((row) => {
    const vals = COLUMNS.map((col) => {
      let val = row[col.key];
      if (col.monetary) {
        val = formatMonetary(val);
      }
      // Escape for CSV
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    });
    csvRows.push(vals.join(','));
  });

  const csvString = csvRows.join('\n');
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const today = new Date();
  const dateStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  a.href = url;
  a.download = 'veeqo-chargeback-' + tabName + '-' + dateStr + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ===== Datanet SQL Generator (Requirement 18) ===== */

function generateDatanetSQL(trackingNumbers) {
  const formatted = trackingNumbers
    .map(tn => "'" + String(tn).replace(/'/g, "''") + "'")
    .join(',\n');

  const today = new Date();
  const runDate = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');

  return `/*+ETLM { depend:{ replace:[ {name:"andes.tfs_tips.freight_invoice_transactions"}, ] } }*/

----drop table if exists pre_original_invoice_base;
create temp table pre_original_invoice_base distkey(pkg_track_number) as (
select * from andes_ext.tfs_tips.freight_invoice_transactions
 where invoice_load_day >= DATE '${runDate}'- 180
AND carrier_ref_id in (
${formatted}
)
);

----drop table if exists pre_original_invoice;
create temp table pre_original_invoice distkey(pkg_track_number) as
(select
    inv.*
from pre_original_invoice_base as inv
);

----drop table if exists original_invoice;
create temp table original_invoice distkey(pkg_track_number) as (
select
   line_item_id,
   pkg_track_number,
   invoice_identifier,
   pkg_length as original_invoice_length,
   pkg_height as original_invoice_height,
pkg_width as original_invoice_width,
pkg_length_uom as original_invoice_dim_uom,
   pkg_weight as  original_invoice_weight,
   pkg_weight_uom as original_invoice_weight_uom,
   max(pkg_net_charge) as original_invoice_net_charge,
sum(charge_amount) as original_invoice_amount,
SUM(CASE WHEN CHARGE_TYPE = 'BaseRateCharge' THEN charge_amount ELSE 0 END) AS ORIGINAL_INVOICE_BASE_CHARGE,
   SUM(CASE WHEN CHARGE_TYPE = 'DeliveryAreaSurcharge' THEN charge_amount ELSE 0 END) AS ORIGINAL_INVOICE_DELIVERY_AREA_SURCHARGE,
   SUM(CASE WHEN CHARGE_TYPE = 'FuelCharge' THEN charge_amount ELSE 0 END) AS ORIGINAL_INVOICE_FUEL_SURCHARGE,
   SUM(CASE WHEN CHARGE_TYPE = 'OversizeCharge' THEN charge_amount ELSE 0 END) AS ORIGINAL_INVOICE_OVERSIZE_SURCHARGE,
   SUM(CASE WHEN CHARGE_TYPE = 'SpecialHandlingCharge' THEN charge_amount ELSE 0 END) AS ORIGINAL_INVOICE_SPECIAL_HANDLING_SURCHARGE,
   SUM(CASE WHEN CHARGE_TYPE = 'OvermaxCharges' THEN charge_amount ELSE 0 END) AS ORIGINAL_INVOICE_OVERMAX_SURCHARGE,
   SUM(CASE WHEN CHARGE_TYPE NOT IN ('BaseRateCharge','DeliveryAreaSurcharge','FuelCharge','OversizeCharge','SpecialHandlingCharge','OvermaxCharges') THEN charge_amount ELSE 0 END) AS ORIGINAL_INVOICE_OTHER_CHARGES,
   max(invoice_load_day) as invoice_load_day
   from pre_original_invoice
group by
   line_item_id,
   pkg_track_number,
   invoice_identifier,
   pkg_length,
   pkg_height,
   pkg_width,
   pkg_length_uom,
   pkg_weight,
   pkg_weight_uom
);

----drop table if exists pre_final;
create temp table pre_final distkey(tracking_id) as (
   SELECT
            pkg_track_number as tracking_id,
           line_item_id as TCDA_ID,
           MAX(original_invoice_length) As original_invoice_length,
           MAX(original_invoice_width) AS original_invoice_width,
           MAX(original_invoice_height) AS original_invoice_height,
           MAX(original_invoice_dim_uom) AS original_invoice_dim_uom,
           MAX(original_invoice_weight) AS original_invoice_weight,
           MAX(original_invoice_weight_uom) AS original_invoice_weight_uom,
           SUM(original_invoice_amount) AS original_invoice_amount,
           SUM(ORIGINAL_INVOICE_BASE_CHARGE) AS ORIGINAL_INVOICE_BASE_CHARGE,
           SUM(ORIGINAL_INVOICE_DELIVERY_AREA_SURCHARGE) AS ORIGINAL_INVOICE_DELIVERY_AREA_SURCHARGE,
           SUM(ORIGINAL_INVOICE_FUEL_SURCHARGE) AS ORIGINAL_INVOICE_FUEL_SURCHARGE,
           SUM(ORIGINAL_INVOICE_OVERSIZE_SURCHARGE) AS ORIGINAL_INVOICE_OVERSIZE_SURCHARGE,
           SUM(ORIGINAL_INVOICE_SPECIAL_HANDLING_SURCHARGE) AS ORIGINAL_INVOICE_SPECIAL_HANDLING_SURCHARGE,
           SUM(ORIGINAL_INVOICE_OVERMAX_SURCHARGE) AS ORIGINAL_INVOICE_OVERMAX_SURCHARGE,
           SUM(ORIGINAL_INVOICE_OTHER_CHARGES) AS ORIGINAL_INVOICE_OTHER_CHARGES,
           MAX(invoice_load_day) AS invoice_load_day
   FROM original_invoice
    GROUP BY
             pkg_track_number,
           line_item_id
   );

----drop table if exists Invoice_Charge_ID_Amount;
create temp table Invoice_Charge_ID_Amount as (
Select trans.pkg_track_number, trans.line_item_id,
   trans.charge_type,
   sum(charge_amount) as Charge_type_amount
from pre_original_invoice as trans
Group by
   trans.pkg_track_number, trans.line_item_id,
   trans.charge_type
);

----drop table if exists Invoice_Charge_final;
create temp table Invoice_Charge_final as (
select pkg_track_number, line_item_id,
   listagg(charge_type || '= '|| cast(nvl(Charge_type_amount,0) ::decimal(32, 2) as varchar(30)),', ') as invoice_Charge_type_list_with_amount
from Invoice_Charge_ID_Amount
group by 1,2
);

----drop table if exists final;
create temp table final as
   (select p.*,
           i.invoice_Charge_type_list_with_amount
    from pre_final as p
             left join Invoice_Charge_final as i
                       on i.line_item_id = p.TCDA_ID
                           and i.pkg_track_number = p.tracking_id
    );

Select * from final;`;
}

/* ===== Dispute CSV Export (Requirement 20) ===== */

function formatDateMMDDYYYY(dateStr) {
  if (!dateStr || dateStr === 'N/A') return 'N/A';
  // Try to parse various date formats
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + '-' + d.getFullYear();
}

function exportDisputeCSV(rows, tabName) {
  const headers = [
    'Tracking ID', 'Order ID', 'Ship Method',
    'Seller_Dimensions (IN)', 'Seller_Weight (LB)', 'Seller Billable Weight (lbs)',
    'Carrier Audit_Dimensions (IN)', 'Carrier Audit_Weight (LB)', 'Carrier Billable Weight (lbs)',
    'Carrier Dim_On_Tracking Site (IN)', 'Carrier Weight_On_Tracking Site (LB)',
    'Seller Dispute Amount', 'Invoice Date'
  ];
  const csvRows = [headers.join(',')];
  rows.forEach(r => {
    const sellerDims = (r.sellerLength !== 'N/A' ? r.sellerLength + ' X ' + r.sellerWidth + ' X ' + r.sellerHeight : 'N/A');
    const carrierDims = (r.carrierAuditedLength !== 'N/A' ? r.carrierAuditedLength + ' X ' + r.carrierAuditedWidth + ' X ' + r.carrierAuditedHeight : 'N/A');
    const amt = r.chargebackAmount === 'N/A' ? 'N/A' : '$' + Number(r.chargebackAmount).toFixed(2);
    const vals = [
      r.trackingNumber, r.orderId || '', r.serviceName || '',
      sellerDims, r.sellerWeight !== 'N/A' ? r.sellerWeight : 'N/A',
      r.sellerBillableWeight !== undefined && r.sellerBillableWeight !== 'N/A' ? r.sellerBillableWeight : 'N/A',
      carrierDims, r.carrierAuditedWeight !== 'N/A' ? r.carrierAuditedWeight : 'N/A',
      r.carrierBillableWeight !== undefined && r.carrierBillableWeight !== 'N/A' ? r.carrierBillableWeight : 'N/A',
      'N/A', 'N/A',
      amt, formatDateMMDDYYYY(r.invoiceDate)
    ];
    csvRows.push(vals.map(v => {
      const s = String(v);
      return (s.includes(',') || s.includes('"')) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(','));
  });
  downloadCSV(csvRows.join('\n'), 'veeqo-dispute-' + tabName);
}

function exportSplatCSV(rows) {
  const headers = ['MarketplaceId', 'MerchantId', 'ReferenceId', 'AccountType', 'Amount', 'Credit/Debit', 'OrderId'];
  const csvRows = [headers.join(',')];
  rows.forEach(r => {
    const amt = r.chargebackAmount === 'N/A' ? '' : Number(r.chargebackAmount).toFixed(2);
    const vals = [
      state.seller.marketplaceId || 'ATVPDKIKX0DER',
      state.seller.mcid || '',
      r.trackingNumber,
      '',
      amt,
      'Credit',
      r.orderId || ''
    ];
    csvRows.push(vals.map(v => {
      const s = String(v);
      return (s.includes(',') || s.includes('"')) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(','));
  });
  downloadCSV(csvRows.join('\n'), 'veeqo-splat');
}

function downloadCSV(csvString, prefix) {
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const today = new Date();
  const dateStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  a.href = url;
  a.download = prefix + '-' + dateStr + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ===== Notification System (Task 13) ===== */

function showNotification(message, type) {
  const area = document.getElementById('notification-area');
  const div = document.createElement('div');
  div.className = 'notification ' + (type || 'success');
  div.textContent = message;
  area.appendChild(div);
  setTimeout(() => {
    if (div.parentNode) div.parentNode.removeChild(div);
  }, 5000);
}


/* ===== Clipboard and Button Wiring (Task 13) ===== */

function getSelectedRows() {
  const filtered = filterByTab(state.mergedRows, state.activeTab);
  return Array.from(state.selectedRowIndices)
    .filter(i => i < filtered.length)
    .sort((a, b) => a - b)
    .map(i => filtered[i]);
}

function wireActionButtons() {
  const MAILTO_URL_LIMIT = 2000;
  const DISPUTE_OUTBOUND_URL = 'https://t.corp.amazon.com/create/templates/21a64813-829d-4d9f-801b-b56e22f41c26';
  const DISPUTE_RETURN_URL = 'https://t.corp.amazon.com/create/templates/e5cd6e2a-d57e-4d10-a570-ba647cf43d86';
  const SPLAT_URL = 'https://t.corp.amazon.com/create/templates/d60194e4-8411-4804-ad79-25de2113e164';

  // Send FedEx Email
  document.getElementById('send-fedex-email-btn').addEventListener('click', async () => {
    try {
      const selected = getSelectedRows();
      if (selected.length === 0) { showNotification('Please select at least one row.', 'error'); return; }
      const agentName = state.agentName.trim();
      if (!agentName) { showNotification('Please enter your name before generating the email template.', 'error'); return; }
      const ticket = (document.getElementById('intercom-ticket').value || '').trim();
      const subject = 'Veeqo Chargebacks Dispute' + (ticket ? ' ' + ticket : '');
      const body = generateFedExEmail(selected, agentName);
      const to = 'quickresponse15@fedex.com';
      const fullMailto = 'mailto:' + encodeURIComponent(to) + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
      if (fullMailto.length <= MAILTO_URL_LIMIT) {
        window.open(fullMailto, '_blank');
      } else {
        await navigator.clipboard.writeText(body);
        window.open('mailto:' + encodeURIComponent(to) + '?subject=' + encodeURIComponent(subject), '_blank');
        showNotification('Email body copied to clipboard — paste into the email.', 'success');
      }
    } catch (e) { showNotification('Could not open email client. Please try again.', 'error'); }
  });

  // Create Dispute T.Corp (non-FedEx)
  document.getElementById('create-dispute-tcorp-btn').addEventListener('click', () => {
    const selected = getSelectedRows();
    if (selected.length === 0) { showNotification('Please select at least one row.', 'error'); return; }
    state._tcorpType = 'dispute';
    state._tcorpSelectedRows = selected;
    openTCorpModal(selected);
  });

  // Create SPLAT T.Corp (all carriers)
  document.getElementById('create-splat-tcorp-btn').addEventListener('click', () => {
    const selected = getSelectedRows();
    if (selected.length === 0) { showNotification('Please select at least one row.', 'error'); return; }
    state._tcorpType = 'splat';
    state._tcorpSelectedRows = selected;
    openTCorpModal(selected);
  });

  // Export Dispute CSV
  document.getElementById('export-dispute-csv-btn').addEventListener('click', () => {
    const selected = getSelectedRows();
    if (selected.length === 0) { showNotification('Please select at least one row.', 'error'); return; }
    exportDisputeCSV(selected, state.activeTab);
  });

  // Export SPLAT CSV
  document.getElementById('export-splat-csv-btn').addEventListener('click', () => {
    const selected = getSelectedRows();
    if (selected.length === 0) { showNotification('Please select at least one row.', 'error'); return; }
    exportSplatCSV(selected);
  });

  // T.Corp Modal — Copy All Fields
  document.getElementById('tcorp-copy-btn').addEventListener('click', async () => {
    try {
      const text = getTCorpFormText();
      await navigator.clipboard.writeText(text);
      showNotification('T.Corp fields copied to clipboard!', 'success');
    } catch (e) { showNotification('Could not copy to clipboard. Please try again.', 'error'); }
  });

  // T.Corp Modal — Open T.Corp & Auto-fill
  document.getElementById('tcorp-open-btn').addEventListener('click', async () => {
    try {
      const ticketId = (document.getElementById('tcorp-ticket-id').value || '').trim();
      if (!ticketId) {
        showNotification('Please enter a Veeqo Ticket ID before creating the T.Corp.', 'error');
        document.getElementById('tcorp-ticket-id').focus();
        return;
      }
      const description = getTCorpFormText();
      const direction = document.getElementById('tcorp-return-outbound').value;
      const data = {
        templateType: state._tcorpType || 'dispute',
        mcid: document.getElementById('tcorp-mcid').value,
        companyId: document.getElementById('tcorp-company-id').value,
        ticketId: ticketId,
        sellerName: document.getElementById('tcorp-seller-name').value,
        carrier: document.getElementById('tcorp-carrier').value,
        marketplace: document.getElementById('tcorp-marketplace').value,
        returnOutbound: direction,
        shipDate: document.getElementById('tcorp-ship-date').value,
        amount: document.getElementById('tcorp-amount').value,
        issueSummary: document.getElementById('tcorp-issue-summary').value,
        sellerAction: document.getElementById('tcorp-seller-action').value,
        sellerSupport: document.getElementById('tcorp-seller-support').value,
        description: description,
        emailTitle: state._tcorpType === 'splat' && state.activeTab === 'FedEx'
          ? 'Veeqo Chargebacks Dispute ' + ticketId : 'N/A',
        relatedSim: 'N/A'
      };

      await chrome.storage.local.set({ tcorpAutofill: data });

      let tcorpUrl;
      if (state._tcorpType === 'splat') {
        tcorpUrl = SPLAT_URL;
      } else if (direction === 'Return') {
        tcorpUrl = DISPUTE_RETURN_URL;
      } else {
        tcorpUrl = DISPUTE_OUTBOUND_URL;
      }
      window.open(tcorpUrl, '_blank');

      showNotification('T.Corp page opened — fields will auto-fill when the page loads.', 'success');
      document.getElementById('tcorp-modal').style.display = 'none';
    } catch (e) { showNotification('Could not open T.Corp. Please try again.', 'error'); }
  });

  // T.Corp Modal — Close
  document.getElementById('tcorp-close-btn').addEventListener('click', () => {
    document.getElementById('tcorp-modal').style.display = 'none';
  });
  document.getElementById('tcorp-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('tcorp-modal')) {
      document.getElementById('tcorp-modal').style.display = 'none';
    }
  });

  // Copy Datanet SQL
  document.getElementById('copy-datanet-sql-btn').addEventListener('click', async () => {
    try {
      if (!state.taskEngineRows || state.taskEngineRows.length === 0) {
        showNotification('Upload a Task Engine export first.', 'error'); return;
      }
      const trackingNumbers = state.taskEngineRows.map(r => r.trackingNumber).filter(tn => tn && tn.trim() !== '');
      if (trackingNumbers.length === 0) { showNotification('No tracking numbers found.', 'error'); return; }
      const sql = generateDatanetSQL(trackingNumbers);
      await navigator.clipboard.writeText(sql);
      const savedUrl = (document.getElementById('datanet-profile-url').value || '').trim();
      if (savedUrl) {
        window.open(savedUrl, '_blank');
        showNotification('SQL copied (' + trackingNumbers.length + ' tracking numbers) — Datanet profile opened.', 'success');
      } else {
        showNotification('SQL copied (' + trackingNumbers.length + ' tracking numbers). Save your Datanet profile URL to open it automatically.', 'success');
      }
    } catch (e) { showNotification('Could not copy SQL to clipboard.', 'error'); }
  });
}

/* ===== Tab Wiring ===== */

function wireTabHandlers() {
  const tabs = document.querySelectorAll('#tab-bar .tab');
  tabs.forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tabBtn.classList.add('active');
      state.activeTab = tabBtn.dataset.tab;
      refreshTableWithFilters();
    });
  });
}

/* ===== Merge Button Wiring ===== */

/* ===== (Merge is now automatic — no button wiring needed) ===== */

/* ===== Init (Bootstrap) ===== */

function init() {
  loadAgentName();
  loadDatanetProfileUrl();

  // Agent name input handler (debounced 500ms)
  const agentInput = document.getElementById('agent-name');
  agentInput.addEventListener('input', () => {
    state.agentName = agentInput.value;
    if (saveAgentNameTimer) clearTimeout(saveAgentNameTimer);
    saveAgentNameTimer = setTimeout(() => {
      saveAgentName(agentInput.value);
    }, 500);
  });

  // Datanet profile URL input handler (debounced 500ms)
  let saveDatanetTimer = null;
  const datanetInput = document.getElementById('datanet-profile-url');
  datanetInput.addEventListener('input', () => {
    if (saveDatanetTimer) clearTimeout(saveDatanetTimer);
    saveDatanetTimer = setTimeout(() => {
      saveDatanetProfileUrl(datanetInput.value);
    }, 500);
  });

  // Auto-fetch seller details on load
  fetchSellerDetails();

  setupUploadHandlers();
  wireTabHandlers();
  wireActionButtons();
}

document.addEventListener('DOMContentLoaded', init);
