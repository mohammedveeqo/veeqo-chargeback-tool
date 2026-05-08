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
    surchargeFlags: 'All',
    multiShip: 'All'
  },
  _trackingToOrderMap: new Map() // Requirement 28: Metabase order ID backfill
};

let saveAgentNameTimer = null;
let _datanetFetchInProgress = false;

/* ===== Order ID Mapping (Requirement 28) ===== */
function updateTrackingToOrderMap(rows) {
  if (!rows) return;
  rows.forEach(r => {
    if (r.trackingNumber && r.orderId && r.orderId !== '' && r.orderId !== 'N/A') {
      state._trackingToOrderMap.set(r.trackingNumber, r.orderId);
    }
  });
}

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

  // Show SPLAT CSV export button only for SPLAT modals
  document.getElementById('tcorp-export-splat-btn').style.display = state._tcorpType === 'splat' ? '' : 'none';

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
        updateTrackingToOrderMap(deduped);
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
  if (_datanetFetchInProgress) return;
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

    // Requirement 28: Backfill missing order IDs from Metabase mapping
    if (state._trackingToOrderMap.size > 0) {
      merged.forEach(row => {
        if ((!row.orderId || row.orderId === '' || row.orderId === 'N/A') && state._trackingToOrderMap.has(row.trackingNumber)) {
          row.orderId = state._trackingToOrderMap.get(row.trackingNumber);
        }
      });
    }

    state.mergedRows = merged;

    // Requirement 28b: Flag multi-ship orders (same order ID on multiple rows)
    const orderIdCounts = new Map();
    merged.forEach(row => {
      if (row.orderId && row.orderId !== '' && row.orderId !== 'N/A') {
        orderIdCounts.set(row.orderId, (orderIdCounts.get(row.orderId) || 0) + 1);
      }
    });
    merged.forEach(row => {
      const count = orderIdCounts.get(row.orderId) || 0;
      row._isMultiShip = count > 1;
      row._multiShipCount = count;
    });

    // Find the carrier tab with the highest row count (only on first merge)
    var carrierTabs = ['FEDEX', 'UPS', 'USPS', 'DHL', 'ONTRAC'];
    var bestTab = state.activeTab || 'All';
    if (state.mergedRows.length === 0) {
      var bestCount = 0;
      carrierTabs.forEach(function(c) {
        var count = merged.filter(function(r) { return r.carrier === c; }).length;
        if (count > bestCount) {
          bestCount = count;
          bestTab = c === 'FEDEX' ? 'FedEx' : c === 'ONTRAC' ? 'OnTrac' : c;
        }
      });
    }
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

    // Update combined flow step 3
    const strongCount = merged.filter(r => r.disputeStrength === 'Strong').length;
    const moderateCount = merged.filter(r => r.disputeStrength === 'Moderate').length;
    const weakCount = merged.filter(r => r.disputeStrength === 'Weak').length;
  } catch (e) {
    showNotification('An error occurred during merge. Please check your files.', 'error');
  }
}

function setupUploadHandlers() {
  const teFile = document.getElementById('task-engine-file');
  const dnFile = document.getElementById('datanet-file');
  const step2Upload = document.querySelector('.step2-upload');

  // Task engine file (now inside a details/fallback section)
  teFile.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFileUpload(e.target.files[0], 'task-engine');
      // Also store tracking numbers for Datanet SQL
      setTimeout(() => {
        if (state.taskEngineRows && state.taskEngineRows.length > 0) {
          const tns = state.taskEngineRows.map(r => r.trackingNumber).filter(Boolean);
          state._metabaseTrackingNumbers = tns;
          document.getElementById('copy-datanet-sql-btn').style.display = '';
        }
      }, 500);
    }
  });

  // Step 2 upload area click
  if (step2Upload) {
    step2Upload.addEventListener('click', () => dnFile.click());
    step2Upload.addEventListener('dragover', (e) => { e.preventDefault(); step2Upload.style.borderColor = '#0066ff'; });
    step2Upload.addEventListener('dragleave', () => { step2Upload.style.borderColor = '#dee2e6'; });
    step2Upload.addEventListener('drop', (e) => {
      e.preventDefault(); step2Upload.style.borderColor = '#dee2e6';
      if (e.dataTransfer.files.length > 0) handleFileUpload(e.dataTransfer.files[0], 'datanet');
    });
  }

  dnFile.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleFileUpload(e.target.files[0], 'datanet');
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
/* ===== Dispute Reason Generator ===== */

function generateDisputeReason(row) {
  const reasons = [];
  const txns = row._turingTransactions || [];
  const pa = row._turingPhysicalAttributes || {};
  const carrier = (row.carrier || '').toUpperCase();
  const service = (row.serviceName || '').toUpperCase();

  if (txns.length === 0) return { reasons: [], strength: null };

  const promise = txns.find(t => t.TransactionType === 'PROMISE_RATE');
  const charge = txns.find(t => t.TransactionType === 'CHARGE_SELLER');
  const chargeback = txns.find(t => t.TransactionType === 'CHARGEBACK_SELLER');

  function getCharge(txn, chargeId, field) {
    if (!txn || !txn.Charges) return 0;
    const c = txn.Charges.find(ch => ch.ChargeId === chargeId);
    return c ? ((c[field] || {}).Value || 0) : 0;
  }
  function sumCharges(txn, field) {
    if (!txn || !txn.Charges) return 0;
    return txn.Charges.reduce((s, c) => s + ((c[field] || {}).Value || 0), 0);
  }

  const chargeBase = getCharge(charge, 'BASE_CHARGE', 'SellerCurrency');
  const cbTotal = chargeback ? sumCharges(chargeback, 'CarrierCurrency') : 0;

  if (!chargeback || cbTotal === 0) {
    reasons.push('No chargeback — original charge stands');
    return { reasons, strength: 'Weak' };
  }

  // Parse chargeback components
  const cbBase = getCharge(chargeback, 'BASE_CHARGE', 'CarrierCurrency');
  const cbOther = getCharge(chargeback, 'OTHER', 'CarrierCurrency');
  const cbDiscount = getCharge(chargeback, 'DISCOUNT', 'CarrierCurrency');
  const cbDAS = getCharge(chargeback, 'DELIVERY_AREA_SURCHARGE', 'CarrierCurrency');
  const cbFuel = getCharge(chargeback, 'FUEL_SURCHARGE', 'CarrierCurrency');
  const cbOversize = getCharge(chargeback, 'OVERSIZE_CHARGE', 'CarrierCurrency');
  const cbAHS = getCharge(chargeback, 'ADDITIONAL_HANDLING_SURCHARGE', 'CarrierCurrency');
  const cbSpecial = getCharge(chargeback, 'SPECIAL_HANDLING_CHARGE', 'CarrierCurrency');

  if (cbBase !== 0) {
    const invMeta = chargeback.InvoiceMetadata || {};
    const updatedCharges = invMeta.UpdatedCharges || [];
    const newBase = updatedCharges.reduce((s, c) => c.ChargeId === 'BASE_CHARGE' ? s + (c.CarrierCurrency && c.CarrierCurrency.BalanceType !== 'CREDIT' ? c.CarrierCurrency.Value : 0) : s, 0);
    if (newBase > 0) {
      reasons.push('Base re-rated: $' + chargeBase.toFixed(2) + ' → $' + newBase.toFixed(2));
    } else {
      reasons.push('Base adjustment: ' + (cbBase > 0 ? '+' : '') + '$' + cbBase.toFixed(2));
    }
  }
  if (cbDAS !== 0) reasons.push('Delivery area surcharge: +$' + cbDAS.toFixed(2));
  if (cbFuel !== 0) reasons.push('Fuel surcharge: +$' + cbFuel.toFixed(2));
  if (cbOversize !== 0) reasons.push('Oversize surcharge: +$' + cbOversize.toFixed(2));
  if (cbAHS !== 0) reasons.push('Additional handling: +$' + cbAHS.toFixed(2));
  if (cbSpecial !== 0) reasons.push('Special handling: +$' + cbSpecial.toFixed(2));
  if (cbOther !== 0) reasons.push('Other charges: +$' + cbOther.toFixed(2));
  if (cbDiscount < 0) reasons.push('Discount: -$' + Math.abs(cbDiscount).toFixed(2));

  // Weight analysis
  const sellerWeightLbs = pa.Weight ? (pa.Weight.Unit === 'OZ' ? pa.Weight.Value / 16 : pa.Weight.Value) : null;
  if (sellerWeightLbs !== null && row.carrierAuditedWeight !== 'N/A') {
    const diff = Math.abs(sellerWeightLbs - row.carrierAuditedWeight);
    if (diff <= 1) reasons.push('Weight: rounding only (' + sellerWeightLbs.toFixed(1) + ' → ' + row.carrierAuditedWeight + ' lbs)');
  }

  // Dims analysis
  if (row.sellerLength !== 'N/A' && row.carrierAuditedLength !== 'N/A') {
    if (row.sellerLength === row.carrierAuditedLength && row.sellerWidth === row.carrierAuditedWidth && row.sellerHeight === row.carrierAuditedHeight) {
      reasons.push('Dims match exactly — pricing adjustment, not measurement error');
    }
  }

  // One Rate detection
  if (service.includes('ONE_RATE') || service.includes('ONERATE')) {
    const cv = row.sellerLength !== 'N/A' ? row.sellerLength * row.sellerWidth * row.sellerHeight : 0;
    if (cv > 2200 || (sellerWeightLbs && sellerWeightLbs > 50)) {
      reasons.push('One Rate limits exceeded (50 lbs / 2,200 in³) — re-rated to standard');
    } else {
      reasons.push('One Rate service — carrier may have re-rated to standard pricing');
    }
  }

  // Strength from transaction analysis
  let strength = null;
  const dimsOK = row.sellerLength === 'N/A' || row.carrierAuditedLength === 'N/A' ||
    (Math.abs(row.sellerLength - row.carrierAuditedLength) <= 1 && Math.abs(row.sellerWidth - row.carrierAuditedWidth) <= 1 && Math.abs(row.sellerHeight - row.carrierAuditedHeight) <= 1);
  const weightOK = sellerWeightLbs === null || row.carrierAuditedWeight === 'N/A' || Math.abs(sellerWeightLbs - row.carrierAuditedWeight) <= 1;

  if (dimsOK && weightOK && cbTotal > 0) {
    strength = 'Strong'; // Seller data correct, chargeback is carrier pricing issue
  } else if (cbTotal > 0 && cbTotal < 2) {
    strength = 'Moderate';
  }

  if (reasons.length === 0) reasons.push('Chargeback: $' + cbTotal.toFixed(2));
  return { reasons, strength };
}


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

  // Rule 29.1: UPS/FedEx rounding rule
  if (sellerDimsSorted && carrierDimsSorted && (row.carrier === 'FEDEX' || row.carrier === 'UPS')) {
    var sellerRaw = [row.sellerLength, row.sellerWidth, row.sellerHeight];
    var carrierRaw = [row.carrierAuditedLength, row.carrierAuditedWidth, row.carrierAuditedHeight];
    for (var ri = 0; ri < 3; ri++) {
      if (sellerRaw[ri] !== 'N/A' && carrierRaw[ri] !== 'N/A') {
        var diff29 = carrierRaw[ri] - sellerRaw[ri];
        if (diff29 > 0 && diff29 <= 1 && sellerRaw[ri] % 1 !== 0) {
          row.disputeInsights.push('Carrier likely rounded up from ' + sellerRaw[ri] + '" to ' + carrierRaw[ri] + '". Carriers round every fraction of an inch up to the next whole inch. Dispute unlikely to succeed on this dimension alone.');
          break;
        }
      }
    }
  }

  // Rule 29.2: Borderline threshold detection
  if (sellerDimsSorted) {
    var thresholds29 = SURCHARGE_THRESHOLDS[(row.carrier || '').toUpperCase()];
    if (thresholds29) {
      Object.keys(thresholds29).forEach(function(tk) {
        var t = thresholds29[tk];
        if (t.longestSide && sellerDimsSorted[0] >= t.longestSide - 2 && sellerDimsSorted[0] < t.longestSide) {
          row.disputeInsights.push('Package is close to ' + tk.replace(/_/g, ' ') + ' threshold (longest side ' + sellerDimsSorted[0] + '" vs ' + t.longestSide + '" limit). Carrier rounding or slight bulging during transit could push it over. Higher risk of surcharge.');
        }
        if (t.cubicVolume && sellerCubicVolume !== 'N/A' && sellerCubicVolume >= t.cubicVolume * 0.95 && sellerCubicVolume < t.cubicVolume) {
          row.disputeInsights.push('Package is close to ' + tk.replace(/_/g, ' ') + ' cubic threshold (' + Math.round(sellerCubicVolume) + ' vs ' + t.cubicVolume + ' limit). Higher risk of surcharge.');
        }
      });
    }
  }

  // Rule 29.3: Dimensional weight explanation
  if (row.sellerDimWeight !== 'N/A' && row.sellerWeight !== 'N/A' && row.sellerDimWeight > row.sellerWeight) {
    var divisor29 = getDimDivisor(row.carrier);
    row.disputeInsights.push('The billable weight of ' + row.sellerBillableWeight + ' lbs is the dimensional weight (' + row.sellerLength + ' x ' + row.sellerWidth + ' x ' + row.sellerHeight + ' / ' + divisor29 + '), not the actual weight. The seller entered ' + row.sellerWeight + ' lbs but the carrier bills at ' + Math.round(row.sellerDimWeight * 100) / 100 + ' lbs because it is higher. This is standard carrier practice, not an error.');
  }

  // Rule 29.4: $0.00 chargeback with surcharge flags
  if (row.chargebackAmount !== 'N/A' && row.chargebackAmount === 0 && row.surchargeFlags.length > 0) {
    row.disputeInsights.push('Chargeback shows $0.00 but surcharges are flagged. The surcharges may have been included in the original label price at purchase. Check the seller\'s billing records to confirm the actual amount charged vs what they expected to pay.');
  }

  // Rule 29.5: DHL/OnTrac urgency
  if (row.carrier === 'DHL') {
    row.disputeInsights.unshift('⚠️ DHL claim window is 30 days only. Check label purchase date and act urgently.');
  }
  if (row.carrier === 'ONTRAC') {
    row.disputeInsights.unshift('⚠️ OnTrac claim window is 15 days. Verify label date immediately.');
  }

  // Rule 29.6: "Others" charge flag
  if (row.chargeBreakdown && row.chargeBreakdown !== 'N/A') {
    var bd = row.chargeBreakdown.toLowerCase();
    if (bd.includes('other') || bd.includes('unspecified') || bd.includes('misc')) {
      row.disputeInsights.push('Unspecified charge detected (\'Others\'). Request a specific breakdown from the carrier — this charge has not been explained and the seller is entitled to know what it is.');
    }
  }

  // Rule 29.7: Scanning error detection (>50% difference on any dimension)
  if (sellerDimsSorted && carrierDimsSorted) {
    var dimLabels = ['length', 'width', 'height'];
    var sellerRaw29 = [row.sellerLength, row.sellerWidth, row.sellerHeight];
    var carrierRaw29 = [row.carrierAuditedLength, row.carrierAuditedWidth, row.carrierAuditedHeight];
    for (var si = 0; si < 3; si++) {
      if (sellerRaw29[si] !== 'N/A' && carrierRaw29[si] !== 'N/A' && sellerRaw29[si] > 0) {
        var pctDiff = ((carrierRaw29[si] - sellerRaw29[si]) / sellerRaw29[si]) * 100;
        if (pctDiff > 50) {
          row.disputeInsights.push('Carrier audited ' + dimLabels[si] + ' is ' + Math.round(pctDiff) + '% larger than seller declared (' + carrierRaw29[si] + '" vs ' + sellerRaw29[si] + '"). This exceeds normal rounding and may indicate a scanning error. Strong basis for dispute with photo evidence.');
          break;
        }
      }
    }
  }

  // Rule 29.8: Photo evidence alternatives
  if ((row.disputeStrength === 'Strong' || row.disputeStrength === 'Moderate') && row.disputeInsights.some(function(i) { return i.includes('evidence') || i.includes('photo'); })) {
    row.disputeInsights.push('If the seller cannot provide photos (package already shipped), acceptable alternatives include: a third-party weigh receipt, product spec sheet with dimensions, or manufacturer listing confirming size/weight.');
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

  // ABSOLUTE RULE: Negative or zero chargeback = Weak, always (Req 30 fix)
  if (chargebackNum !== null && chargebackNum <= 0) {
    row.disputeStrength = 'Weak';
  }
  // WEAK conditions (check first, first match wins)
  else if (row.status === 'Match' && !hasCarrierOnlyFlag) {
    row.disputeStrength = 'Weak';
  } else if (row.surchargeFlags.some(function(f) { return f.name === 'Over Max'; })) {
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

  // Generate detailed reason from Turing transaction data
  const reasonResult = generateDisputeReason(row);
  row.disputeReason = reasonResult.reasons.join('; ');
  // Override strength if Turing analysis gives a stronger signal
  if (reasonResult.strength) row.disputeStrength = reasonResult.strength;

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
    if (f.multiShip !== 'All') {
      if (f.multiShip === 'Multi-ship only' && !r._isMultiShip) return false;
      if (f.multiShip === 'Single only' && r._isMultiShip) return false;
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
  bar.appendChild(makeFilter('Multi-ship:', 'multiShip', ['All', 'Multi-ship only', 'Single only']));

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
    state.filters.multiShip = 'All';
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
  { key: 'orderId', label: 'Order ID', monetary: false, defaultVisible: true },
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

  // Carrier rules reference
  var carrierUpper = (row.carrier || '').toUpperCase();
  var rulesLines = [];
  if (carrierUpper === 'FEDEX') {
    rulesLines.push('FedEx rules: Dim weight = L×W×H / 139. Bills greater of actual or dim weight.');
    rulesLines.push('AHS-Weight: >50 lbs. AHS-Dim: longest >48" or 2nd >30". AHS-Cubic: >10,368 in³.');
    rulesLines.push('Oversize: longest >96" or L+G >130" or >17,280 in³. Over Max: >150 lbs or >108" or L+G >165".');
    if ((row.serviceName || '').toUpperCase().includes('ONE_RATE') || (row.serviceName || '').toUpperCase().includes('ONERATE')) {
      rulesLines.push('One Rate limits: max 50 lbs, max 2,200 in³. If exceeded, carrier re-rates to standard commercial pricing.');
    }
    rulesLines.push('Only the highest surcharge applies if multiple triggered. Rounds up to nearest inch.');
  } else if (carrierUpper === 'UPS') {
    rulesLines.push('UPS rules: Dim weight = L×W×H / 139. Bills greater of actual or dim weight.');
    rulesLines.push('AHS-Weight: >50 lbs. AHS-Dim: longest >48" or 2nd >30". AHS-Cubic: >10,368 in³.');
    rulesLines.push('Large Package: longest >96" or L+G >130" or >17,280 in³ or >110 lbs.');
    rulesLines.push('Over Max: >150 lbs or >108" or L+G >165". Rounds up to nearest inch.');
  } else if (carrierUpper === 'USPS') {
    rulesLines.push('USPS rules: Dim weight = L×W×H / 166 (Priority/Express over 1,728 in³).');
    rulesLines.push('Non-Standard small: longest 22-30" ($4.50). Non-Standard large: longest >30" ($10-$21).');
    rulesLines.push('Volume surcharge: >3,456 in³ ($21). Balloon: L+G 84-108" and <20 lbs (charged at 20 lb rate).');
    rulesLines.push('Over Max: >70 lbs or L+G >130". Dim noncompliance fee: $3.');
  } else if (carrierUpper === 'DHL') {
    rulesLines.push('DHL rules: Dim weight = L×W×H / 139. AHS-Weight: >50 lbs. AHS-Dim: longest >48".');
  }
  if (rulesLines.length > 0) {
    rulesLines.push('L+G = Length + (2 × Width) + (2 × Height). All carriers round up to nearest inch.');
    var rulesBlock = document.createElement('div');
    rulesBlock.style.cssText = 'margin-top:8px;padding:6px 8px;background:#f8f9fa;border-radius:4px;font-size:10px;color:#666;line-height:1.5;';
    rulesBlock.innerHTML = rulesLines.join('<br>');
    stats.appendChild(rulesBlock);
  }
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

  // Use Turing transaction analysis if available
  var reasonText = row.disputeReason || '';
  if (reasonText && reasonText !== 'No chargeback — original charge stands') {
    var txnBlock = document.createElement('div');
    txnBlock.className = 'dispute-popup-stat';
    txnBlock.style.cssText = 'margin-top:6px;font-size:11px;color:#555;';
    txnBlock.textContent = 'Transaction: ' + reasonText;
    stats.appendChild(txnBlock);
  }

  if (strength === 'Strong') {
    if (reasonText.includes('Dims match exactly') || reasonText.includes('pricing adjustment')) {
      rec.textContent = 'Recommendation: Raise to ' + (row.carrier || 'carrier') + ' — seller entered correct dimensions. Chargeback is a carrier-side pricing adjustment, not a measurement error.';
    } else if (reasonText.includes('rounding only')) {
      rec.textContent = 'Recommendation: Raise to ' + (row.carrier || 'carrier') + ' — weight difference is standard carrier rounding. Seller data is correct.';
    } else {
      rec.textContent = 'Recommendation: Raise to ' + (row.carrier || 'carrier') + ' — strong dispute candidate. Request photo evidence from the seller and proceed.';
    }
  } else if (strength === 'Weak') {
    if (row.chargebackAmount !== 'N/A' && row.chargebackAmount <= 0) {
      rec.textContent = 'Recommendation: No overcharge detected. No action needed.';
    } else if (reasonText.includes('No chargeback')) {
      rec.textContent = 'Recommendation: No chargeback found. Original charge stands — no dispute needed.';
    } else {
      rec.textContent = 'Recommendation: Push back on seller — carrier measurements show significant difference. Dispute unlikely to succeed without strong photo evidence.';
    }
  } else {
    if (reasonText.includes('One Rate')) {
      rec.textContent = 'Recommendation: Check if One Rate re-rate is valid. If seller package was within One Rate limits, raise to ' + (row.carrier || 'carrier') + '. Otherwise push back on seller.';
    } else {
      rec.textContent = 'Recommendation: Could go either way. Request photo evidence from the seller before deciding whether to raise to ' + (row.carrier || 'carrier') + ' or push back.';
    }
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

  var strongSpan = document.createElement('span');
  strongSpan.className = 'badge-strong summary-badge-tip';
  strongSpan.textContent = strong + ' Strong';

  var modSpan = document.createElement('span');
  modSpan.className = 'badge-moderate summary-badge-tip';
  modSpan.textContent = moderate + ' Moderate';

  var weakSpan = document.createElement('span');
  weakSpan.className = 'badge-weak summary-badge-tip';
  weakSpan.textContent = weak + ' Weak';

  var tooltips = {
    Strong: 'Significant dimension differences with carrier-only surcharges, large billable weight gaps, or clear mismatches with no shared surcharges. Best candidates for dispute.',
    Moderate: 'Small dimension differences with billable weight impact, seller dims close to surcharge thresholds, low chargeback amounts, or One Rate issues. May need photo evidence to win.',
    Weak: 'Data matches with no surcharge differences, Over Max flags, zero/negative chargebacks, or identical surcharges with minimal dim differences. Unlikely to succeed.'
  };

  [['Strong', strongSpan], ['Moderate', modSpan], ['Weak', weakSpan]].forEach(function(pair) {
    var key = pair[0], span = pair[1];
    var wrapper = document.createElement('div');
    wrapper.className = 'summary-tip-wrapper';

    var popup = document.createElement('div');
    popup.className = 'summary-tip-popup';
    popup.textContent = tooltips[key];

    var hideTimer = null;
    wrapper.addEventListener('mouseenter', function() {
      clearTimeout(hideTimer);
      // Close other summary popups
      document.querySelectorAll('.summary-tip-popup').forEach(function(p) { p.style.display = 'none'; });
      popup.style.display = 'block';
    });
    wrapper.addEventListener('mouseleave', function() {
      hideTimer = setTimeout(function() { popup.style.display = 'none'; }, 200);
    });

    wrapper.appendChild(span);
    wrapper.appendChild(popup);
    bar.appendChild(wrapper);
  });

  var exportBtn = document.createElement('button');
  exportBtn.className = 'btn-export-insights';
  exportBtn.textContent = 'Export Insights';
  exportBtn.addEventListener('click', function() { exportInsightsCSV(rows); });
  bar.appendChild(exportBtn);

  var tableContainer = document.getElementById('table-container');
  tableContainer.parentNode.insertBefore(bar, tableContainer);

  // Requirement 29.5: DHL/OnTrac urgency banner
  var urgencyBanner = document.getElementById('urgency-banner');
  if (urgencyBanner) urgencyBanner.remove();
  if (state.activeTab === 'DHL') {
    urgencyBanner = document.createElement('div');
    urgencyBanner.id = 'urgency-banner';
    urgencyBanner.style.cssText = 'padding:10px 16px;background:#fff3e0;border:2px solid #ff6d00;border-radius:6px;margin-bottom:8px;font-size:13px;font-weight:600;color:#e65100;';
    urgencyBanner.textContent = '⚠️ DHL claim window is 30 days only. Check label purchase date and act urgently.';
    tableContainer.parentNode.insertBefore(urgencyBanner, tableContainer);
  } else if (state.activeTab === 'OnTrac') {
    urgencyBanner = document.createElement('div');
    urgencyBanner.id = 'urgency-banner';
    urgencyBanner.style.cssText = 'padding:10px 16px;background:#ffebee;border:2px solid #d32f2f;border-radius:6px;margin-bottom:8px;font-size:13px;font-weight:600;color:#c62828;';
    urgencyBanner.textContent = '⚠️ OnTrac claim window is 15 days. Verify label date immediately.';
    tableContainer.parentNode.insertBefore(urgencyBanner, tableContainer);
  }
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
      // Multi-ship badge on Order ID column
      else if (col.key === 'orderId') {
        td.textContent = (val !== undefined && val !== null) ? val : '';
        if (row._isMultiShip) {
          var msBadge = document.createElement('span');
          msBadge.className = 'badge-multiship';
          msBadge.textContent = 'Multi-ship';
          msBadge.title = 'This order has ' + row._multiShipCount + ' shipments — check if all need disputing';
          td.appendChild(msBadge);
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

  // Requirement 28b: Consolidate multi-ship orders (SPLAT doesn't accept duplicate order IDs)
  const orderGroups = new Map();
  let multiShipCount = 0;
  rows.forEach(r => {
    const oid = r.orderId || '';
    if (oid && oid !== 'N/A' && orderGroups.has(oid)) {
      // Consolidate: add amount to existing row
      const existing = orderGroups.get(oid);
      const existingAmt = existing.chargebackAmount === 'N/A' ? 0 : Number(existing.chargebackAmount);
      const newAmt = r.chargebackAmount === 'N/A' ? 0 : Number(r.chargebackAmount);
      existing._consolidatedAmount = (existing._consolidatedAmount || existingAmt) + newAmt;
      existing._consolidatedTrackings = (existing._consolidatedTrackings || [existing.trackingNumber]);
      existing._consolidatedTrackings.push(r.trackingNumber);
      multiShipCount++;
    } else {
      orderGroups.set(oid || r.trackingNumber, { ...r });
    }
  });

  if (multiShipCount > 0) {
    showNotification(multiShipCount + ' orders have multiple shipments. SPLAT does not accept duplicate order IDs — totals have been consolidated per order.', 'error');
  }

  orderGroups.forEach(r => {
    const amt = r._consolidatedAmount !== undefined
      ? r._consolidatedAmount.toFixed(2)
      : (r.chargebackAmount === 'N/A' ? '' : Number(r.chargebackAmount).toFixed(2));
    const refId = r._consolidatedTrackings
      ? r._consolidatedTrackings.join('; ')
      : r.trackingNumber;
    const vals = [
      state.seller.marketplaceId || 'ATVPDKIKX0DER',
      state.seller.mcid || '',
      refId,
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

  // T.Corp Modal — Export SPLAT CSV
  document.getElementById('tcorp-export-splat-btn').addEventListener('click', () => {
    if (state._tcorpSelectedRows && state._tcorpSelectedRows.length > 0) {
      exportSplatCSV(state._tcorpSelectedRows);
    }
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
      // Use Metabase-fetched tracking numbers if available, otherwise fall back to task engine rows
      let trackingNumbers = state._metabaseTrackingNumbers || [];
      if (trackingNumbers.length === 0 && state.taskEngineRows && state.taskEngineRows.length > 0) {
        trackingNumbers = state.taskEngineRows.map(r => r.trackingNumber).filter(tn => tn && tn.trim() !== '');
      }
      if (trackingNumbers.length === 0) { showNotification('No tracking numbers found. Fetch seller data or upload a Task Engine export first.', 'error'); return; }
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

  // Generate Seller Summary
  document.getElementById('generate-summary-btn').addEventListener('click', async () => {
    const rows = state.mergedRows;
    if (!rows || rows.length === 0) { showNotification('No data to summarise.', 'error'); return; }
    const summary = generateSellerSummary(rows);
    try {
      await navigator.clipboard.writeText(summary);
      showNotification('Seller summary copied to clipboard (' + rows.length + ' shipments).', 'success');
    } catch (e) { showNotification('Could not copy to clipboard.', 'error'); }
  });

  // Copy for AI
  document.getElementById('copy-for-ai-btn').addEventListener('click', async () => {
    const rows = state.mergedRows;
    if (!rows || rows.length === 0) { showNotification('No data to copy.', 'error'); return; }
    const aiText = generateAIPrompt(rows);
    try {
      await navigator.clipboard.writeText(aiText);
      showNotification('AI prompt copied (' + rows.length + ' shipments). Paste into Kiro or QuickSuite.', 'success');
    } catch (e) { showNotification('Could not copy to clipboard.', 'error'); }
  });

  // Generate Seller Reply
  document.getElementById('generate-reply-btn').addEventListener('click', async () => {
    const rows = state.mergedRows;
    if (!rows || rows.length === 0) { showNotification('No data to generate reply.', 'error'); return; }
    const reply = generateSellerReply(rows);
    try {
      await navigator.clipboard.writeText(reply);
      showNotification('Seller reply copied — paste into Intercom.', 'success');
    } catch (e) { showNotification('Could not copy to clipboard.', 'error'); }
  });

  // Export Seller CSV
  document.getElementById('export-seller-csv-btn').addEventListener('click', () => {
    const rows = state.mergedRows;
    if (!rows || rows.length === 0) { showNotification('No data to export.', 'error'); return; }
    exportSellerCSV(rows);
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

/* ===== Turing Quick Lookup ===== */

function turingFetch(trackingNumber) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'turingFetch', trackingNumber }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response || !response.ok) {
        const body = response ? response.body : 'No response';
        if (body.includes('Unauthenticated') || response.status === 401) return reject(new Error('Midway session expired.'));
        return reject(new Error('Turing API error: ' + body));
      }
      try { resolve(JSON.parse(response.body)); }
      catch (e) { reject(new Error('Invalid response from Turing')); }
    });
  });
}

function mapTuringToDatanetRow(data) {
  const sc = data.shippingContainer || {};
  const pa = sc.PhysicalAttributes || {};
  const len = pa.Length ? pa.Length.Value : 0;
  const wid = pa.Width ? pa.Width.Value : 0;
  const hgt = pa.Height ? pa.Height.Value : 0;
  let weight = pa.Weight ? pa.Weight.Value : 0;
  if (pa.Weight && pa.Weight.Unit === 'OZ') weight = weight / 16;

  const txns = data.financialTransactions || [];

  function signedVal(charge, field) {
    if (!charge || !charge[field]) return 0;
    var v = charge[field].Value || 0;
    return charge[field].BalanceType === 'CREDIT' ? -v : v;
  }

  // CHARGE_SELLER = original label purchase charge
  const csTxn = txns.find(t => t.TransactionType === 'CHARGE_SELLER') || {};
  const csCharges = csTxn.Charges || [];
  const sellerTotal = csCharges.reduce((s, c) => s + signedVal(c, 'SellerCurrency'), 0);
  const chargeBase = csCharges.reduce((s, c) => c.ChargeId === 'BASE_CHARGE' ? s + signedVal(c, 'SellerCurrency') : s, 0);

  // CHARGEBACK_SELLER = carrier audit adjustment
  const cbTxn = txns.find(t => t.TransactionType === 'CHARGEBACK_SELLER') || {};
  const cbCharges = cbTxn.Charges || [];
  const chargebackNet = cbCharges.reduce((s, c) => s + signedVal(c, 'CarrierCurrency'), 0);

  function cbVal(id) { var c = cbCharges.find(ch => ch.ChargeId === id); return c ? signedVal(c, 'CarrierCurrency') : 0; }
  const cbBase = cbVal('BASE_CHARGE');
  const cbOther = cbVal('OTHER');
  const cbDAS = cbVal('DELIVERY_AREA_SURCHARGE');
  const cbFuel = cbVal('FUEL_SURCHARGE');
  const cbOversize = cbVal('OVERSIZE_CHARGE');
  const cbAHS = cbVal('ADDITIONAL_HANDLING_SURCHARGE');
  const cbSpecial = cbVal('SPECIAL_HANDLING_CHARGE');

  // Carrier-audited dims from InvoiceMetadata
  const invMeta = cbTxn.InvoiceMetadata || {};
  const cPA = invMeta.PhysicalAttributes || {};
  const cLen = cPA.Length ? cPA.Length.Value : 'N/A';
  const cWid = cPA.Width ? cPA.Width.Value : 'N/A';
  const cHgt = cPA.Height ? cPA.Height.Value : 'N/A';
  let cWeight = cPA.Weight ? cPA.Weight.Value : 'N/A';
  if (cWeight !== 'N/A' && cPA.Weight && cPA.Weight.Unit === 'OZ') cWeight = cWeight / 16;

  // Updated base from InvoiceMetadata
  const updatedCharges = invMeta.UpdatedCharges || [];
  const updatedBase = updatedCharges.reduce((s, c) => c.ChargeId === 'BASE_CHARGE' ? s + signedVal(c, 'CarrierCurrency') : s, 0);

  // Build charge breakdown
  const parts = [];
  if (updatedBase) parts.push('New base: $' + updatedBase.toFixed(2) + ' (was $' + chargeBase.toFixed(2) + ')');
  else if (cbBase !== 0) parts.push('Base adj: ' + (cbBase > 0 ? '+' : '') + '$' + cbBase.toFixed(2));
  if (cbDAS !== 0) parts.push('DAS: +$' + cbDAS.toFixed(2));
  if (cbFuel !== 0) parts.push('Fuel: +$' + cbFuel.toFixed(2));
  if (cbOversize !== 0) parts.push('Oversize: +$' + cbOversize.toFixed(2));
  if (cbAHS !== 0) parts.push('AHS: +$' + cbAHS.toFixed(2));
  if (cbSpecial !== 0) parts.push('Special: +$' + cbSpecial.toFixed(2));
  if (cbOther < 0) parts.push('Discount: -$' + Math.abs(cbOther).toFixed(2));
  else if (cbOther > 0) parts.push('Other: +$' + cbOther.toFixed(2));
  parts.push('Net chargeback: $' + chargebackNet.toFixed(2));

  return {
    trackingNumber: sc.CarrierTransactionId || '',
    sellerLength: len, sellerWidth: wid, sellerHeight: hgt,
    sellerWeight: Math.round(weight * 100) / 100,
    sellerBaseRate: Math.round(sellerTotal * 100) / 100,
    sellerTotal: Math.round(sellerTotal * 100) / 100,
    carrierAuditedLength: cLen, carrierAuditedWidth: cWid, carrierAuditedHeight: cHgt,
    carrierAuditedWeight: cWeight !== 'N/A' ? Math.round(cWeight * 100) / 100 : 'N/A',
    carrierAuditedTotal: Math.round((sellerTotal + chargebackNet) * 100) / 100,
    carrierAuditedBaseCharge: updatedBase || Math.round((chargeBase + cbBase) * 100) / 100,
    deliveryAreaSurcharge: cbDAS, fuelSurcharge: cbFuel,
    oversizeSurcharge: cbOversize, specialHandlingSurcharge: cbSpecial,
    overmaxSurcharge: 0, otherCharges: cbOther,
    invoiceDate: invMeta.InvoiceDate ? new Date(invMeta.InvoiceDate).toISOString().slice(0, 10) : (csTxn.TransactionDate ? new Date(csTxn.TransactionDate).toISOString().slice(0, 10) : ''),
    chargeBreakdown: parts.join(', ') || 'No chargeback',
    _carrier: sc.CarrierId || '',
    _orderId: sc.OrderId || 'Off-Amazon',
    _serviceId: sc.ShippingServiceId || '',
    _turingTransactions: txns, _turingPhysicalAttributes: pa, _invoiceMetadata: invMeta
  };
}

async function turingQuickLookup() {
  const input = document.getElementById('turing-tracking-input');
  const statusEl = document.getElementById('turing-status');
  const errorEl = document.getElementById('turing-error');
  const btn = document.getElementById('turing-add-btn');
  const raw = (input.value || '').trim();

  errorEl.textContent = '';
  statusEl.textContent = '';

  if (!raw) { errorEl.textContent = 'Enter a tracking number.'; return; }

  // Split by commas, newlines, tabs, or whitespace — filter empty
  const trackingNumbers = raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  if (trackingNumbers.length === 0) { errorEl.textContent = 'No valid tracking numbers found.'; return; }

  btn.disabled = true;
  btn.textContent = '...';

  let added = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < trackingNumbers.length; i++) {
    const tn = trackingNumbers[i];
    statusEl.textContent = 'Looking up ' + (i + 1) + '/' + trackingNumbers.length + ': ' + tn;

    // Skip duplicates — check all sources
    const isDupe = state.mergedRows.some(r => r.trackingNumber === tn) ||
        (state.datanetRows && state.datanetRows.some(r => r.trackingNumber === tn)) ||
        (state.taskEngineRows && state.taskEngineRows.some(r => r.trackingNumber === tn));
    if (isDupe) {
      skipped++;
      continue;
    }

    try {
      const data = await turingFetch(tn);
      if (!data.shippingContainer) { failed++; continue; }

      const dnRow = mapTuringToDatanetRow(data);
      if (!state.datanetRows) state.datanetRows = [];
      state.datanetRows.push(dnRow);

      if (!state.taskEngineRows) {
        const row = {
          ...dnRow,
          carrier: dnRow._carrier,
          orderId: dnRow._orderId,
          serviceName: dnRow._serviceId,
          orderNumber: dnRow._orderId
        };
        calculateFields(row);
        state.mergedRows.push(row);
      }

      added++;
    } catch (err) {
      if (err.message.includes('Midway') || err.message.includes('Unauthenticated') || err.message.includes('401')) {
        errorEl.innerHTML = 'Midway session expired. <a href="https://midway-auth.amazon.com/login?next=https://na.turing.sfs.amazon.dev" target="_blank" style="color:#0066ff;">Log in to Midway</a>, then try again.';
        break;
      }
      failed++;
    }
  }

  // Refresh table
  if (state.taskEngineRows && added > 0 && !_datanetFetchInProgress) {
    tryAutoMerge();
  } else if (added > 0 && _datanetFetchInProgress) {
    // Datanet fetch in progress — add Turing rows directly to mergedRows for display
    // They'll be reconciled when the Datanet fetch completes and triggers a full merge
    for (let i = 0; i < trackingNumbers.length; i++) {
      const existing = state.mergedRows.find(r => r.trackingNumber === trackingNumbers[i]);
      if (existing) continue;
      const dnRow = (state.datanetRows || []).find(r => r.trackingNumber === trackingNumbers[i]);
      if (!dnRow) continue;
      const row = {
        ...dnRow,
        carrier: dnRow._carrier || 'N/A',
        orderId: dnRow._orderId || '',
        serviceName: dnRow._serviceId || '',
        orderNumber: dnRow._orderId || ''
      };
      calculateFields(row);
      state.mergedRows.push(row);
    }
    renderTable(filterByTab(state.mergedRows, state.activeTab));
    updateTabCounts(state.mergedRows);
    document.getElementById('action-buttons').style.display = '';
    document.getElementById('row-count').textContent = state.mergedRows.length + ' rows';
  } else if (added > 0) {
    renderTable(filterByTab(state.mergedRows, state.activeTab));
    updateTabCounts(state.mergedRows);
    document.getElementById('action-buttons').style.display = '';
    document.getElementById('row-count').textContent = state.mergedRows.length + ' rows';
  }

  const parts = [];
  if (added) parts.push(added + ' added');
  if (skipped) parts.push(skipped + ' skipped (duplicate)');
  if (failed) parts.push(failed + ' not found');
  statusEl.textContent = parts.join(', ');

  input.value = '';
  input.focus();
  btn.disabled = false;
  btn.textContent = 'Add';
}

/* ===== Datanet API Integration ===== */

const DATANET_API = 'https://datanet-service.amazon.com';

function parseDatanetProfileUrl(url) {
  const profileMatch = url.match(/profile_id\/(\d+)/);
  const jobMatch = url.match(/job_id\/(\d+)/);
  return {
    profileId: profileMatch ? profileMatch[1] : null,
    jobId: jobMatch ? jobMatch[1] : null
  };
}

async function datanetFetch(path, options = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'datanetFetch', path, options: { method: options.method, body: options.body, headers: options.headers } }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error('Extension error: ' + chrome.runtime.lastError.message));
        return;
      }
      if (!response || !response.ok) {
        const body = response ? response.body : 'No response';
        if (body.includes('Unauthenticated')) reject(new Error('Midway session expired. Please refresh your Midway login.'));
        else reject(new Error('Datanet API error: ' + (response ? response.status : 'unknown') + ' - ' + body));
        return;
      }
      try { resolve(JSON.parse(response.body)); }
      catch (e) { reject(new Error('Invalid JSON response from Datanet')); }
    });
  });
}

async function getDatanetProfile(profileId) {
  const data = await datanetFetch('/jobProfile/TRANSFORM/' + profileId);
  return data;
}

async function updateDatanetProfileSQL(profileId, profileObj, newSQL) {
  // Replace hardcoded date with Datanet's runtime placeholder for the profile
  const profileSQL = newSQL.replace(/DATE '\d{4}-\d{2}-\d{2}'/, "DATE '{RUN_DATE_YYYY-MM-DD}'");
  const updated = { ...profileObj, sql: profileSQL };
  delete updated.versionAttributes;
  await datanetFetch('/jobProfile/TRANSFORM/' + profileId, {
    method: 'POST',
    body: JSON.stringify(updated)
  });
}

async function runDatanetJob(jobId) {
  const today = new Date().toISOString().slice(0, 10);
  const data = await datanetFetch('/jobRun/-/' + jobId + '/' + today + '?scheduled=false', { method: 'POST' });
  const runs = data.jobRuns || [];
  if (runs.length === 0) throw new Error('No job run created');
  return runs[0].id;
}

async function pollJobRun(runId, statusEl, jobRunUrl) {
  const maxAttempts = 60; // 10 minutes max
  const link = jobRunUrl ? ' <a href="' + jobRunUrl + '" target="_blank" style="color:#0066ff;">View job</a>' : '';
  for (let i = 0; i < maxAttempts; i++) {
    const data = await datanetFetch('/jobRun/-/' + runId);
    const jr = data.jobRun || data;
    const status = jr.status;
    if (statusEl) statusEl.innerHTML = status + ' (' + (i * 10) + 's)' + link;
    if (status === 'SUCCESS') return jr;
    if (status === 'ERROR' || status === 'KILLED' || status === 'CANCELLED') {
      throw new Error('Job failed with status: ' + status);
    }
    await new Promise(r => setTimeout(r, 10000));
  }
  throw new Error('Job timed out after 10 minutes');
}

async function downloadJobResults(runId) {
  const meta = await datanetFetch('/jobRunResults/' + runId);
  const url = meta.downloadUrl;
  if (!url) throw new Error('No download URL in job results');
  // Fetch from S3 via background to avoid CORS
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'datanetFetch', path: '', options: { _rawUrl: url } }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response || !response.ok) return reject(new Error('Failed to download results'));
      resolve(response.body);
    });
  });
}

function parseTSVToRows(tsv) {
  const lines = tsv.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t');
  return lines.slice(1).map(line => {
    const vals = line.split('\t');
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (vals[i] || '').trim(); });
    return obj;
  });
}

async function fetchDatanetData() {
  const btn = document.getElementById('fetch-datanet-btn');
  const statusEl = document.getElementById('datanet-status');
  const filenameEl = document.getElementById('datanet-filename');
  const errorEl = document.getElementById('datanet-error');

  errorEl.textContent = '';
  filenameEl.textContent = '';

  // Validate prerequisites
  if ((!state.taskEngineRows || state.taskEngineRows.length === 0) && (!state._metabaseTrackingNumbers || state._metabaseTrackingNumbers.length === 0)) {
    errorEl.textContent = 'Fetch seller data or upload a Task Engine export first.';
    return;
  }

  const savedUrl = (document.getElementById('datanet-profile-url').value || '').trim();
  if (!savedUrl) {
    errorEl.textContent = 'Paste your Datanet profile URL in the header first.';
    return;
  }

  const { profileId } = parseDatanetProfileUrl(savedUrl);
  if (!profileId) {
    errorEl.textContent = 'Could not find profile_id in the URL. Use a Data Central profile or job URL.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Working...';
  statusEl.textContent = 'Checking Midway auth...';
  _datanetFetchInProgress = true;

  try {
    // 0. Check Midway auth first
    try {
      await datanetFetch('/whoAmI');
    } catch (authErr) {
      errorEl.innerHTML = 'Midway session expired. <a href="https://midway-auth.amazon.com/login?next=https://datanet-service.amazon.com" target="_blank" style="color:#0066ff;">Log in to Midway</a>, then try again.';
      return;
    }

    // 1. Get profile and its job IDs
    statusEl.textContent = 'Fetching profile...';
    const profileData = await getDatanetProfile(profileId);
    const profile = profileData.jobProfile;
    const jobIds = profileData.jobIds || [];
    if (jobIds.length === 0) throw new Error('No jobs found for this profile. Create a job in Data Central first.');

    // Use the first job ID (or the one from URL if available)
    const { jobId: urlJobId } = parseDatanetProfileUrl(savedUrl);
    const jobId = urlJobId || String(jobIds[0]);

    // 2. Generate and update SQL
    let trackingNumbers = (state._metabaseTrackingNumbers && state._metabaseTrackingNumbers.length > 0)
      ? state._metabaseTrackingNumbers
      : state.taskEngineRows.map(r => r.trackingNumber).filter(tn => tn && tn.trim());
    if (trackingNumbers.length === 0) throw new Error('No tracking numbers found. Fetch seller data or upload a Task Engine export first.');

    statusEl.textContent = 'Updating profile SQL (' + trackingNumbers.length + ' tracking numbers)...';
    const newSQL = generateDatanetSQL(trackingNumbers);
    await updateDatanetProfileSQL(profileId, profile, newSQL);

    // 3. Run the job
    statusEl.textContent = 'Running job ' + jobId + '...';
    const runId = await runDatanetJob(jobId);

    // 4. Poll for completion — show link to job run page
    const jobRunUrl = 'https://datacentral.a2z.com/datanet/etl-manager/jobs/' + jobId + '/runs/' + runId;
    statusEl.innerHTML = 'Waiting for results... <a href="' + jobRunUrl + '" target="_blank" style="color:#0066ff;">View job run</a>';
    await pollJobRun(runId, statusEl, jobRunUrl);

    // 5. Download results
    statusEl.textContent = 'Downloading results...';
    const tsv = await downloadJobResults(runId);
    const rows = parseTSVToRows(tsv);

    if (rows.length === 0) {
      throw new Error('Query returned no results. Check that the tracking numbers exist in the invoice data.');
    }

    // 6. Map and load into state — merge with any existing Turing rows
    const mapped = rows.map(mapDatanetRow);
    const seen = new Set();
    const deduped = mapped.filter(r => {
      if (seen.has(r.trackingNumber)) return false;
      seen.add(r.trackingNumber);
      return true;
    });

    // Preserve any Turing-added rows that aren't in the Datanet results
    const existingTuringRows = (state.datanetRows || []).filter(r => !seen.has(r.trackingNumber));
    state.datanetRows = deduped.concat(existingTuringRows);
    filenameEl.textContent = 'Datanet API (' + deduped.length + ' rows' + (existingTuringRows.length > 0 ? ' + ' + existingTuringRows.length + ' from Turing' : '') + ')';
    statusEl.textContent = 'Done — ' + state.datanetRows.length + ' rows loaded';
    btn.textContent = 'Fetched';

    _datanetFetchInProgress = false;
    tryAutoMerge();

  } catch (err) {
    if (err.message.includes('Midway') || err.message.includes('Unauthenticated')) {
      errorEl.innerHTML = 'Midway session expired. <a href="https://midway-auth.amazon.com/login?next=https://datanet-service.amazon.com" target="_blank" style="color:#0066ff;">Log in to Midway</a>, then try again.';
    } else {
      errorEl.textContent = err.message;
    }
    statusEl.textContent = '';
    btn.textContent = 'Fetch Datanet Data';
  } finally {
    _datanetFetchInProgress = false;
    btn.disabled = false;
    if (btn.textContent === 'Working...') btn.textContent = 'Fetch Datanet Data';
  }
}

/* ===== Metabase API Integration (Requirement 26) ===== */

const METABASE_URL = 'https://veeqo.metabaseapp.com';
let _metabaseDatabaseId = null;

function loadMetabaseApiKey() {
  const fallback = localStorage.getItem('metabaseApiKey') || '';
  const input = document.getElementById('metabase-api-key');
  if (isChromeAvailable()) {
    try {
      chrome.storage.local.get('metabaseApiKey', (result) => {
        const key = (result && result.metabaseApiKey) || fallback;
        if (input) input.value = key;
      });
    } catch (e) {
      if (input) input.value = fallback;
    }
  } else {
    if (input) input.value = fallback;
  }
}

function saveMetabaseApiKey(key) {
  localStorage.setItem('metabaseApiKey', key);
  if (isChromeAvailable()) {
    try {
      chrome.storage.local.set({ metabaseApiKey: key });
    } catch (e) {}
  }
}

function getMetabaseApiKey() {
  return (document.getElementById('metabase-api-key').value || '').trim();
}

async function metabaseQuery(sql, databaseId) {
  const dbId = databaseId || _metabaseDatabaseId;
  if (!dbId) throw new Error('Metabase database ID not found. Try refreshing.');

  const response = await new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      type: 'metabaseFetch',
      url: METABASE_URL + '/api/dataset',
      method: 'POST',
      body: JSON.stringify({
        database: dbId,
        type: 'native',
        native: { query: sql }
      })
    }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(res);
    });
  });

  if (!response || !response.ok) {
    const body = response ? response.body : '';
    if (response && response.status === 401) throw new Error('Not logged into Metabase. Please log in at veeqo.metabaseapp.com first.');
    throw new Error('Metabase query failed (' + (response ? response.status : '?') + '): ' + (body || 'unknown error').slice(0, 200));
  }

  const data = JSON.parse(response.body);
  if (data.error) throw new Error('Metabase error: ' + data.error);

  // Parse results into array of objects
  const cols = (data.data && data.data.cols) ? data.data.cols.map(c => c.name) : [];
  const rows = (data.data && data.data.rows) ? data.data.rows : [];
  return rows.map(row => {
    const obj = {};
    cols.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

async function fetchMetabaseDatabaseId() {
  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'metabaseFetch',
        url: METABASE_URL + '/api/database',
        method: 'GET'
      }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(res);
      });
    });
    if (!response || !response.ok) return;
    const data = JSON.parse(response.body);
    const dbs = data.data || data;
    // Find Snowflake database
    const snowflake = (Array.isArray(dbs) ? dbs : []).find(db =>
      db.engine === 'snowflake' || (db.name || '').toLowerCase().includes('snowflake')
    );
    if (snowflake) {
      _metabaseDatabaseId = snowflake.id;
    } else if (Array.isArray(dbs) && dbs.length > 0) {
      _metabaseDatabaseId = dbs[0].id;
    }
  } catch (e) {
    // Silently fail — will error when query is attempted
  }
}

function detectInputType(text) {
  const lines = text.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  const orderPattern = /^\d{3}-\d{7}-\d{7}$/;
  const orders = lines.filter(l => orderPattern.test(l));
  if (orders.length > lines.length * 0.5) {
    return { type: 'orders', values: lines };
  }
  return { type: 'tracking', values: lines };
}

function sqlInList(values, isText) {
  return values.map(v => "'" + String(v).replace(/'/g, "''") + "'").join(',');
}

function batchArray(arr, size) {
  const batches = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
}

async function runBatchedQueries(batches, buildSQL, maxConcurrent) {
  const results = [];
  for (let i = 0; i < batches.length; i += maxConcurrent) {
    const chunk = batches.slice(i, i + maxConcurrent);
    const promises = chunk.map(batch => metabaseQuery(buildSQL(batch)));
    const chunkResults = await Promise.all(promises);
    chunkResults.forEach(rows => results.push(...rows));
  }
  return results;
}

function updateMetabaseProgress(steps, activeIdx, summary) {
  const panel = document.getElementById('flow-progress');
  if (!panel) return;
  panel.style.display = '';
  let html = '';
  steps.forEach((step, i) => {
    let cls = '';
    if (i < activeIdx) cls = 'done';
    else if (i === activeIdx) cls = 'active';
    if (step.error) cls = 'error';
    const icon = i < activeIdx ? '✓' : (step.error ? '✗' : (i === activeIdx ? '⟳' : '○'));
    const time = step.time ? step.time + 's' : '';
    html += '<div class="step ' + cls + '">';
    html += '<span class="step-label">' + icon + ' ' + step.label + '</span>';
    html += '<span class="step-time">' + time + '</span>';
    html += '</div>';
  });
  if (summary) {
    html += '<div class="step-summary">' + summary + '</div>';
  }
  panel.innerHTML = html;
}

async function fetchSellerData() {
  const errorEl = document.getElementById('seller-data-error');
  const filenameEl = document.getElementById('seller-data-filename');
  const btn = document.getElementById('fetch-seller-data-btn');
  const input = document.getElementById('order-tracking-input');
  const companyIdInput = document.getElementById('metabase-company-id');

  errorEl.textContent = '';
  filenameEl.textContent = '';

  const raw = (input.value || '').trim();
  if (!raw) {
    errorEl.textContent = 'Paste order numbers or tracking numbers first.';
    return;
  }

  const companyId = (companyIdInput.value || '').trim();
  if (!companyId) {
    errorEl.textContent = 'Company ID is required. Log into Veeqo or enter it manually.';
    return;
  }

  // Ensure database ID is loaded
  if (!_metabaseDatabaseId) {
    await fetchMetabaseDatabaseId();
    if (!_metabaseDatabaseId) {
      errorEl.textContent = 'Could not determine Metabase database. Check your API key.';
      return;
    }
  }

  const { type, values } = detectInputType(raw);
  btn.disabled = true;
  btn.textContent = 'Working...';

  const steps = [];
  const startTime = Date.now();

  try {
    let orderIds = [];
    let orderNumberMap = new Map(); // ORDER_ID -> order NUMBER

    if (type === 'orders') {
      // Step 1: Pull company orders
      steps.push({ label: 'Loading order map...' });
      updateMetabaseProgress(steps, 0);
      const t1 = Date.now();

      // Query directly for the specific order numbers instead of pulling all orders
      const orderBatches = batchArray(values, 50);
      let orderRows = [];
      for (const batch of orderBatches) {
        const inList = batch.map(v => "'" + String(v).replace(/'/g, "''") + "'").join(',');
        const batchRows = await metabaseQuery(
          "SELECT ID, NUMBER FROM BASE_VEEQO_APP.ORDERS WHERE COMPANY_ID = " + companyId +
          " AND NUMBER IN (" + inList + ")"
        );
        orderRows = orderRows.concat(batchRows);
      }
      steps[0].time = Math.round((Date.now() - t1) / 1000);

      // Step 2: Client-side match
      steps.push({ label: 'Matching order numbers...' });
      updateMetabaseProgress(steps, 1);

      const orderLookup = new Map();
      orderRows.forEach(r => {
        const num = String(r.NUMBER || '').trim();
        orderLookup.set(num, r.ID);
        // Also index without leading # or whitespace
        if (num.startsWith('#')) orderLookup.set(num.slice(1), r.ID);
      });

      const matched = [];
      const notFound = [];
      values.forEach(orderNum => {
        const cleaned = orderNum.trim();
        let id = orderLookup.get(cleaned);
        // Try without leading # 
        if (id === undefined && cleaned.startsWith('#')) {
          id = orderLookup.get(cleaned.slice(1));
        }
        // Try with leading #
        if (id === undefined) {
          id = orderLookup.get('#' + cleaned);
        }
        if (id !== undefined) {
          matched.push({ id: id, number: cleaned });
          orderNumberMap.set(id, cleaned);
        } else {
          notFound.push(cleaned);
        }
      });

      if (matched.length === 0) {
        // Show sample of what Metabase returned for debugging
        const sampleNums = orderRows.slice(0, 3).map(r => String(r.NUMBER)).join(', ');
        throw new Error('No matching orders found. The order numbers in Metabase look like: ' + sampleNums + '. You entered: ' + values.slice(0, 3).join(', '));
      }

      steps[1].label = 'Matched ' + matched.length + ' of ' + values.length + ' order numbers';
      steps[1].time = 0;

      if (notFound.length > 0) {
        const preview = notFound.slice(0, 5).join(', ');
        showNotification(notFound.length + ' order numbers not found: ' + preview + (notFound.length > 5 ? '...' : ''), 'error');
      }

      orderIds = matched.map(m => m.id);
      updateMetabaseProgress(steps, 1);
    }

    // Step 3: Fetch shipment details
    steps.push({ label: 'Fetching shipment details...' });
    updateMetabaseProgress(steps, steps.length - 1);
    const t3 = Date.now();

    let shipmentRows;
    if (type === 'orders') {
      const batches = batchArray(orderIds, 50);
      shipmentRows = await runBatchedQueries(batches, (batch) =>
        "SELECT ORDER_ID, CONSIGNMENT AS TRACKING_NUMBER, CARRIER_NAME, " +
        "PARCELBRIGHT_SHIPMENT_ID AS SHIPMENT_ID, ALLOCATION_ID, CREATED_AT::DATE AS SHIP_DATE " +
        "FROM INT.ORDER_SHIPMENT_DETAILS WHERE COMPANY_ID = " + companyId +
        " AND LABEL_CONTENT_TYPE IS NOT NULL AND ORDER_ID IN (" + batch.join(',') + ")"
      , 5);
    } else {
      // Tracking number path
      const batches = batchArray(values, 50);
      shipmentRows = await runBatchedQueries(batches, (batch) =>
        "SELECT ORDER_ID, CONSIGNMENT AS TRACKING_NUMBER, CARRIER_NAME, " +
        "PARCELBRIGHT_SHIPMENT_ID AS SHIPMENT_ID, ALLOCATION_ID, CREATED_AT::DATE AS SHIP_DATE " +
        "FROM INT.ORDER_SHIPMENT_DETAILS WHERE COMPANY_ID = " + companyId +
        " AND LABEL_CONTENT_TYPE IS NOT NULL AND CONSIGNMENT IN (" + sqlInList(batch, true) + ")"
      , 5);
    }
    steps[steps.length - 1].time = Math.round((Date.now() - t3) / 1000);

    if (shipmentRows.length === 0) {
      throw new Error('No shipments found. Check the company ID and order/tracking numbers.');
    }

    // Step 4: Fetch weight/dimensions
    steps.push({ label: 'Fetching dimensions...' });
    updateMetabaseProgress(steps, steps.length - 1);
    const t4 = Date.now();

    const allocationIds = [...new Set(shipmentRows.map(r => r.ALLOCATION_ID).filter(Boolean))];
    let dimRows = [];
    if (allocationIds.length > 0) {
      const batches = batchArray(allocationIds, 50);
      dimRows = await runBatchedQueries(batches, (batch) =>
        "SELECT ALLOCATION_ID, WEIGHT, DEPTH AS LENGTH, WIDTH, HEIGHT, DIMENSIONS_UNIT, WEIGHT_UNIT " +
        "FROM BASE_PENSIVE_VEEQO_APP_DB.PENSIVE_VQ_APP_ALLOCATION_PACKAGES WHERE COMPANY_ID = " + companyId +
        " AND ALLOCATION_ID IN (" + batch.join(',') + ")"
      , 5);
    }
    steps[steps.length - 1].time = Math.round((Date.now() - t4) / 1000);

    // Step 5: Fetch carrier/service
    steps.push({ label: 'Fetching carrier/service...' });
    updateMetabaseProgress(steps, steps.length - 1);
    const t5 = Date.now();

    const trackingNumbers = [...new Set(shipmentRows.map(r => r.TRACKING_NUMBER).filter(Boolean))];
    let carrierRows = [];
    if (trackingNumbers.length > 0) {
      const batches = batchArray(trackingNumbers, 50);
      carrierRows = await runBatchedQueries(batches, (batch) =>
        "SELECT TRACKING_NUMBER, SERVICE_CARRIER, SERVICE_NAME, REMOTE_SHIPMENT_ID " +
        "FROM BASE_PENSIVE_VEEQO_APP_DB.PENSIVE_RATE_SHOPPING_SHIPMENTS WHERE COMPANY_ID = '" + companyId + "'" +
        " AND TRACKING_NUMBER IN (" + sqlInList(batch, true) + ")"
      , 5);
    }
    steps[steps.length - 1].time = Math.round((Date.now() - t5) / 1000);

    // Step 6: Fetch base rate
    steps.push({ label: 'Fetching rates...' });
    updateMetabaseProgress(steps, steps.length - 1);
    const t6 = Date.now();

    const shipmentIds = [...new Set(shipmentRows.map(r => r.SHIPMENT_ID).filter(Boolean))];
    let rateRows = [];
    if (shipmentIds.length > 0) {
      const batches = batchArray(shipmentIds, 50);
      rateRows = await runBatchedQueries(batches, (batch) =>
        "SELECT SHIPMENT_ID, BASE_RATE FROM INT.SHIPPING_CREDIT_SHIPMENTS WHERE SHIPMENT_ID IN (" + batch.map(id => "'" + String(id).replace(/'/g, "''") + "'").join(',') + ")"
      , 5).catch(() => []);
      // If quoted version fails, try unquoted (numeric IDs)
      if (rateRows.length === 0 && shipmentIds.length > 0) {
        try {
          rateRows = await runBatchedQueries(batches, (batch) =>
            "SELECT SHIPMENT_ID, BASE_RATE FROM INT.SHIPPING_CREDIT_SHIPMENTS WHERE SHIPMENT_ID IN (" + batch.join(',') + ")"
          , 5);
        } catch (e) {
          // Rate lookup is non-critical — continue without it
          rateRows = [];
        }
      }
    }
    steps[steps.length - 1].time = Math.round((Date.now() - t6) / 1000);

    // Build lookup maps
    const dimMap = new Map();
    dimRows.forEach(r => { dimMap.set(r.ALLOCATION_ID, r); });

    const carrierMap = new Map();
    carrierRows.forEach(r => { carrierMap.set(r.TRACKING_NUMBER, r); });

    const rateMap = new Map();
    rateRows.forEach(r => { rateMap.set(String(r.SHIPMENT_ID), r); });

    // Track multi-ship orders
    const orderShipCount = new Map();
    shipmentRows.forEach(r => {
      orderShipCount.set(r.ORDER_ID, (orderShipCount.get(r.ORDER_ID) || 0) + 1);
    });

    // Combine into Task Engine format
    const taskEngineRows = shipmentRows.map(row => {
      const dim = dimMap.get(row.ALLOCATION_ID) || {};
      const carrier = carrierMap.get(row.TRACKING_NUMBER) || {};
      const rate = rateMap.get(String(row.SHIPMENT_ID)) || {};

      // Weight conversion: grams to lbs
      let weightLbs = 0;
      if (dim.WEIGHT) {
        const unit = (dim.WEIGHT_UNIT || '').toLowerCase();
        if (unit === 'g' || unit === 'grams') {
          weightLbs = Math.round((dim.WEIGHT / 453.592) * 100) / 100;
        } else if (unit === 'kg') {
          weightLbs = Math.round((dim.WEIGHT * 2.20462) * 100) / 100;
        } else if (unit === 'oz') {
          weightLbs = Math.round((dim.WEIGHT / 16) * 100) / 100;
        } else if (unit === 'lb' || unit === 'lbs') {
          weightLbs = dim.WEIGHT;
        } else {
          // Default assume grams
          weightLbs = Math.round((dim.WEIGHT / 453.592) * 100) / 100;
        }
      }

      // Dimension conversion if needed
      let length = dim.LENGTH || 0;
      let width = dim.WIDTH || 0;
      let height = dim.HEIGHT || 0;
      const dimUnit = (dim.DIMENSIONS_UNIT || '').toLowerCase();
      if (dimUnit === 'cm') {
        length = Math.round(length / 2.54 * 100) / 100;
        width = Math.round(width / 2.54 * 100) / 100;
        height = Math.round(height / 2.54 * 100) / 100;
      }

      const orderNum = orderNumberMap.get(row.ORDER_ID) || String(row.ORDER_ID || '');

      return {
        trackingNumber: String(row.TRACKING_NUMBER || ''),
        shipmentId: String(row.SHIPMENT_ID || ''),
        orderId: orderNum,
        sellerWeight: weightLbs,
        sellerLength: length,
        sellerWidth: width,
        sellerHeight: height,
        carrier: (carrier.SERVICE_CARRIER || row.CARRIER_NAME || '').toUpperCase(),
        serviceName: String(carrier.SERVICE_NAME || ''),
        sellerBaseRate: rate.BASE_RATE || 0,
        shipDate: String(row.SHIP_DATE || ''),
        _multiShip: (orderShipCount.get(row.ORDER_ID) || 1) > 1
      };
    });

    // Store in state
    state.taskEngineRows = taskEngineRows;
    updateTrackingToOrderMap(taskEngineRows);

    const totalTime = Math.round((Date.now() - startTime) / 1000);
    const summary = 'Done — ' + (type === 'orders' ? values.length + ' orders, ' : '') + shipmentRows.length + ' shipments found (' + totalTime + 's)';
    updateMetabaseProgress(steps, steps.length, summary);

    filenameEl.textContent = 'Metabase (' + taskEngineRows.length + ' rows)';
    btn.textContent = 'Fetched';

    // Show copy Datanet SQL button with the tracking numbers
    const allTrackingNums = taskEngineRows.map(r => r.trackingNumber).filter(Boolean);
    document.getElementById('copy-datanet-sql-btn').style.display = '';
    // Store tracking numbers for Datanet SQL
    state._metabaseTrackingNumbers = allTrackingNums;

    // Auto-merge if Datanet data is already loaded
    tryAutoMerge();

  } catch (err) {
    const lastStep = steps[steps.length - 1];
    if (lastStep) lastStep.error = true;
    updateMetabaseProgress(steps, steps.length - 1);
    errorEl.textContent = err.message;
    btn.textContent = 'Fetch Seller Data';
  } finally {
    btn.disabled = false;
    if (btn.textContent === 'Working...') btn.textContent = 'Fetch Seller Data';
  }
}

/* ===== Seller Summary Generator (Requirement 30) ===== */

function generateSellerSummary(rows) {
  const companyName = state.seller.companyName || 'Seller';
  const carriers = [...new Set(rows.map(r => r.carrier).filter(c => c && c !== 'N/A'))];
  const dates = rows.map(r => r.shipDate || r.invoiceDate).filter(d => d && d !== 'N/A').sort();
  const dateRange = dates.length > 0 ? dates[0] + ' to ' + dates[dates.length - 1] : 'N/A';

  // Categorise rows — credits first (negative amounts never disputable)
  const credits = rows.filter(r => r.chargebackAmount !== 'N/A' && r.chargebackAmount < 0);
  const disputable = rows.filter(r => (r.disputeStrength === 'Strong' || r.disputeStrength === 'Moderate') && (r.chargebackAmount === 'N/A' || r.chargebackAmount > 0));
  const notDisputable = rows.filter(r => r.disputeStrength === 'Weak' && (r.chargebackAmount === 'N/A' || r.chargebackAmount >= 0));

  const disputableTotal = disputable.reduce((s, r) => s + (r.chargebackAmount !== 'N/A' ? Math.max(0, r.chargebackAmount) : 0), 0);

  // Sub-categorise disputable
  const weightDisc = disputable.filter(r => r.weightMatch === 'No');
  const dimDisc = disputable.filter(r => r.dimsMatch === 'No' && r.weightMatch !== 'No');
  const scanError = disputable.filter(r => r.disputeInsights && r.disputeInsights.some(i => i.includes('scanning error')));

  // Sub-categorise not disputable
  const matches = notDisputable.filter(r => r.status === 'Match');
  const dimWeightRows = notDisputable.filter(r => r.disputeInsights && r.disputeInsights.some(i => i.includes('dimensional weight')));
  const roundingRows = notDisputable.filter(r => r.disputeInsights && r.disputeInsights.some(i => i.includes('rounded up')));
  const sharedSurcharge = notDisputable.filter(r => r.surchargeFlags && r.surchargeFlags.length > 0 && !r.surchargeFlags.some(f => f.carrierOnly));

  const creditTotal = credits.reduce((s, r) => s + Math.abs(r.chargebackAmount), 0);

  let text = 'CHARGEBACK INVESTIGATION SUMMARY\n';
  text += 'Seller: ' + companyName + '\n';
  text += 'Total shipments reviewed: ' + rows.length + '\n';
  text += 'Date range: ' + dateRange + '\n\n';

  text += 'DISPUTABLE (' + disputable.length + ' shipments, $' + disputableTotal.toFixed(2) + ' total):\n';
  text += 'These shipments show a discrepancy between your entered dimensions and what the carrier recorded. We will raise these with ' + carriers.join('/') + ' on your behalf.\n';
  if (weightDisc.length > 0) text += '- ' + weightDisc.length + ' shipments: weight discrepancy\n';
  if (dimDisc.length > 0) text += '- ' + dimDisc.length + ' shipments: dimension discrepancy (carrier measured larger than entered)\n';
  if (scanError.length > 0) text += '- ' + scanError.length + ' shipments: possible scanning error (carrier dimensions significantly different)\n';
  text += '\n';

  text += 'NOT DISPUTABLE (' + notDisputable.length + ' shipments):\n';
  text += 'These shipments were correctly charged based on the package details entered.\n';
  if (matches.length > 0) text += '- ' + matches.length + ' shipments: dimensions and weight match carrier records ($0.00 difference)\n';
  if (dimWeightRows.length > 0) text += '- ' + dimWeightRows.length + ' shipments: dimensional weight applies (standard carrier practice — carriers bill the greater of actual or dimensional weight)\n';
  if (sharedSurcharge.length > 0) text += '- ' + sharedSurcharge.length + ' shipments: surcharges apply regardless (both your entered dimensions and the carrier\'s measurements trigger surcharges)\n';
  if (roundingRows.length > 0) text += '- ' + roundingRows.length + ' shipments: carrier rounded up by 1 inch (within normal rounding rules)\n';
  text += '\n';

  if (credits.length > 0) {
    text += 'CREDITS IN YOUR FAVOUR (' + credits.length + ' shipments, $' + creditTotal.toFixed(2) + ' total):\n';
    text += 'These shipments were actually charged less than your label cost — no action needed.\n\n';
  }

  text += 'NEXT STEPS:\n';
  if (carriers.includes('FEDEX')) {
    text += 'We are submitting a dispute to FedEx for the ' + disputable.length + ' disputable shipments.\n';
  } else {
    text += 'We are raising this with ' + carriers.join('/') + ' for the ' + disputable.length + ' disputable shipments.\n';
  }
  text += 'We will update you once we hear back. Please note the final decision lies with the carrier.\n';

  return text;
}

function generateAIPrompt(rows) {
  const companyName = state.seller.companyName || 'Seller';
  const carriers = [...new Set(rows.map(r => r.carrier).filter(c => c && c !== 'N/A'))];

  // Separate credits first (negative chargeback), then strong (positive chargeback + Strong/Moderate), then weak
  const credits = rows.filter(r => r.chargebackAmount !== 'N/A' && r.chargebackAmount < 0);
  const strong = rows.filter(r => (r.disputeStrength === 'Strong' || r.disputeStrength === 'Moderate') && (r.chargebackAmount === 'N/A' || r.chargebackAmount > 0));
  const weak = rows.filter(r => r.disputeStrength === 'Weak' && (r.chargebackAmount === 'N/A' || r.chargebackAmount >= 0));

  let text = 'Generate a seller reply for a chargeback investigation. Here are the results:\n\n';
  text += 'Seller: ' + companyName + ', Carrier: ' + carriers.join('/') + ', Total: ' + rows.length + ' shipments\n\n';

  // Strong disputes — full detail, no truncation
  text += 'Strong disputes (proceed with dispute): ' + strong.length + ' shipments\n';
  strong.forEach(r => {
    const sDims = r.sellerLength + 'x' + r.sellerWidth + 'x' + r.sellerHeight;
    const cDims = r.carrierAuditedLength + 'x' + r.carrierAuditedWidth + 'x' + r.carrierAuditedHeight;
    const amt = r.chargebackAmount !== 'N/A' ? '$' + Number(r.chargebackAmount).toFixed(2) : 'N/A';
    const reason = r.disputeInsights && r.disputeInsights.length > 0 ? r.disputeInsights.join(' | ') : '';
    text += r.trackingNumber + ', ' + sDims + ', ' + cDims + ', ' + amt + ', ' + reason + '\n';
  });

  // Weak/no dispute — grouped by reason
  text += '\nWeak/no dispute: ' + weak.length + ' shipments\n';
  const weakGroups = new Map();
  weak.forEach(r => {
    const reason = r.status === 'Match' ? 'Dimensions and weight match carrier records'
      : (r.disputeInsights && r.disputeInsights.length > 0 ? r.disputeInsights[0] : 'No dispute basis');
    const amt = r.chargebackAmount !== 'N/A' ? '$' + Number(r.chargebackAmount).toFixed(2) : '$0.00';
    const key = reason + '|' + amt;
    if (!weakGroups.has(key)) {
      weakGroups.set(key, { reason, amt, count: 0, trackings: [] });
    }
    const g = weakGroups.get(key);
    g.count++;
    g.trackings.push(r.trackingNumber);
  });
  weakGroups.forEach(g => {
    if (g.count > 3) {
      text += g.count + ' shipments: ' + g.reason + ', ' + g.amt + '\n';
    } else {
      g.trackings.forEach(tn => {
        text += tn + ', ' + g.reason + ', ' + g.amt + '\n';
      });
    }
  });

  // Credits — no truncation
  if (credits.length > 0) {
    text += '\nCredits (no action): ' + credits.length + ' shipments\n';
    credits.forEach(r => {
      text += r.trackingNumber + ', $' + Math.abs(r.chargebackAmount).toFixed(2) + ' credit\n';
    });
  }

  text += '\nWrite a clear, empathetic reply explaining which shipments we can dispute and why the others are not eligible. Explain dimensional weight simply if it applies.\n';

  return text;
}

function generateSellerReply(rows) {
  const sellerName = state.seller.companyName || 'there';
  const agentName = state.agentName || 'Your Agent';
  const carriers = [...new Set(rows.map(r => r.carrier).filter(c => c && c !== 'N/A'))];
  const carrierStr = carriers.join('/');

  const credits = rows.filter(r => r.chargebackAmount !== 'N/A' && r.chargebackAmount < 0);
  const disputable = rows.filter(r => (r.disputeStrength === 'Strong' || r.disputeStrength === 'Moderate') && (r.chargebackAmount === 'N/A' || r.chargebackAmount > 0));
  const notDisputable = rows.filter(r => r.disputeStrength === 'Weak' && (r.chargebackAmount === 'N/A' || r.chargebackAmount >= 0));

  const disputableTotal = disputable.reduce((s, r) => s + (r.chargebackAmount !== 'N/A' ? Math.max(0, r.chargebackAmount) : 0), 0);
  const creditTotal = credits.reduce((s, r) => s + Math.abs(r.chargebackAmount), 0);

  // Sub-categorise not disputable
  const matchRows = notDisputable.filter(r => r.status === 'Match');
  const dimWeightRows = notDisputable.filter(r => r.disputeInsights && r.disputeInsights.some(i => i.includes('dimensional weight')));
  const roundingRows = notDisputable.filter(r => r.disputeInsights && r.disputeInsights.some(i => i.includes('rounded up')));

  let text = 'Hi ' + sellerName + ',\n\n';
  text += 'Thank you for your patience while we reviewed your shipments.\n\n';
  text += 'We have investigated ' + rows.length + ' shipments and here is a summary of our findings:\n\n';

  if (disputable.length > 0) {
    text += 'DISPUTABLE (' + disputable.length + ' shipments, $' + disputableTotal.toFixed(2) + ' total):\n';
    text += 'We have identified ' + disputable.length + ' shipments where the carrier\'s recorded dimensions or weight do not match what was entered at label purchase. We will be raising these with ' + carrierStr + ' on your behalf. Please note the final decision lies with the carrier.\n\n';
  }

  if (notDisputable.length > 0) {
    text += 'NOT DISPUTABLE (' + notDisputable.length + ' shipments):\n';
    if (matchRows.length > 0) {
      text += matchRows.length + ' shipments were correctly charged — the carrier\'s records match the details entered at label creation.\n';
    }
    if (dimWeightRows.length > 0) {
      text += dimWeightRows.length + ' shipments are affected by dimensional weight — your package dimensions produce a billable weight higher than the actual weight, which is standard carrier practice.\n';
    }
    if (roundingRows.length > 0) {
      text += roundingRows.length + ' shipments had charges within normal carrier rounding (fractions of an inch rounded up).\n';
    }
    var otherWeak = notDisputable.length - matchRows.length - dimWeightRows.length - roundingRows.length;
    if (otherWeak > 0) {
      text += otherWeak + ' shipments were correctly charged based on the package details.\n';
    }
    text += '\n';
  }

  if (credits.length > 0) {
    text += 'CREDITS IN YOUR FAVOUR (' + credits.length + ' shipments, $' + creditTotal.toFixed(2) + '):\n';
    text += credits.length + ' shipments were actually charged less than your original label cost — no action needed on these.\n\n';
  }

  text += 'We have attached a full breakdown of all shipments for your reference.\n\n';

  if (disputable.length > 0) {
    text += 'We will update you once we hear back from ' + carrierStr + ' on the disputable shipments.\n\n';
  }

  text += 'Kind regards,\n' + agentName + '\nVeeqo Support';

  return text;
}

function getRowOutcome(row) {
  const carrier = (row.carrier || 'carrier').toUpperCase();
  if (row.chargebackAmount !== 'N/A' && row.chargebackAmount < 0) return 'Credit in your favour';
  if ((row.disputeStrength === 'Strong' || row.disputeStrength === 'Moderate') && (row.chargebackAmount === 'N/A' || row.chargebackAmount > 0)) {
    return 'Disputing with ' + carrier;
  }
  if (row.status === 'Match') return 'Correctly charged';
  if (row.disputeInsights && row.disputeInsights.some(i => i.includes('dimensional weight'))) return 'Dimensional weight applies';
  if (row.disputeInsights && row.disputeInsights.some(i => i.includes('rounded up'))) return 'Carrier rounding';
  return 'Under review';
}

function exportSellerCSV(rows) {
  const headers = ['Tracking Number', 'Order ID', 'Service', 'Your Dimensions (in)', 'Your Weight (lbs)', 'Carrier Dimensions (in)', 'Carrier Weight (lbs)', 'Chargeback Amount', 'Outcome'];
  const csvRows = [headers.join(',')];

  rows.forEach(r => {
    const sellerDims = (r.sellerLength !== 'N/A' ? r.sellerLength + ' x ' + r.sellerWidth + ' x ' + r.sellerHeight : 'N/A');
    const carrierDims = (r.carrierAuditedLength !== 'N/A' ? r.carrierAuditedLength + ' x ' + r.carrierAuditedWidth + ' x ' + r.carrierAuditedHeight : 'N/A');
    const amt = r.chargebackAmount !== 'N/A' ? Number(r.chargebackAmount).toFixed(2) : '';
    const outcome = getRowOutcome(r);

    const vals = [
      r.trackingNumber,
      r.orderId || '',
      r.serviceName || '',
      sellerDims,
      r.sellerWeight !== 'N/A' ? r.sellerWeight : '',
      carrierDims,
      r.carrierAuditedWeight !== 'N/A' ? r.carrierAuditedWeight : '',
      amt,
      outcome
    ];
    csvRows.push(vals.map(v => {
      const s = String(v);
      return (s.includes(',') || s.includes('"')) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(','));
  });

  downloadCSV(csvRows.join('\n'), 'veeqo-seller-breakdown');
  showNotification('Seller CSV exported (' + rows.length + ' rows). Attach to Intercom message.', 'success');
}

/* ===== Combined Flow UI (Requirement 27) ===== */

function updateFlowProgress(steps, summary) {
  const panel = document.getElementById('flow-progress');
  const stepsEl = document.getElementById('flow-progress-steps');
  const summaryEl = document.getElementById('flow-progress-summary');
  panel.style.display = '';

  stepsEl.innerHTML = steps.map(s => {
    let cls = '';
    let icon = '○';
    if (s.status === 'done') { cls = 'done'; icon = '✓'; }
    else if (s.status === 'active') { cls = 'active'; icon = '⟳'; }
    else if (s.status === 'error') { cls = 'error'; icon = '✗'; }
    else if (s.status === 'skip') { return ''; }
    const time = s.time ? '<span class="fp-time">' + s.time + 's</span>' : '';
    return '<div class="fp-step ' + cls + '">' + icon + ' ' + s.label + time + '</div>';
  }).join('');

  summaryEl.innerHTML = summary || '';
}

async function fetchAllFlow() {
  const btn = document.getElementById('fetch-all-btn');
  const errorEl = document.getElementById('seller-data-error');
  const input = document.getElementById('order-tracking-input');
  const companyIdInput = document.getElementById('metabase-company-id');

  errorEl.textContent = '';

  const raw = (input.value || '').trim();
  if (!raw) { errorEl.textContent = 'Paste order numbers or tracking numbers first.'; return; }

  const companyId = (companyIdInput.value || '').trim();
  if (!companyId) { errorEl.textContent = 'Company ID is required.'; return; }

  if (!_metabaseDatabaseId) {
    await fetchMetabaseDatabaseId();
    if (!_metabaseDatabaseId) { errorEl.textContent = 'Could not connect to Metabase. Check your API key.'; return; }
  }

  const { type, values } = detectInputType(raw);
  btn.disabled = true;
  btn.textContent = 'Working...';

  const steps = [];
  const startTime = Date.now();

  try {
    // === PHASE 1: Metabase (Seller Data) ===
    let orderIds = [];
    let orderNumberMap = new Map();

    if (type === 'orders') {
      steps.push({ label: 'Loading order map...', status: 'active' });
      updateFlowProgress(steps);
      const t1 = Date.now();

      const orderBatches = batchArray(values, 50);
      let orderRows = [];
      for (const batch of orderBatches) {
        const inList = batch.map(v => "'" + String(v).replace(/'/g, "''") + "'").join(',');
        const batchRows = await metabaseQuery(
          "SELECT ID, NUMBER FROM BASE_VEEQO_APP.ORDERS WHERE COMPANY_ID = " + companyId +
          " AND NUMBER IN (" + inList + ")"
        );
        orderRows = orderRows.concat(batchRows);
      }
      steps[0].status = 'done';
      steps[0].time = Math.round((Date.now() - t1) / 1000);

      // Match
      steps.push({ label: 'Matching order numbers...', status: 'active' });
      updateFlowProgress(steps);

      const orderLookup = new Map();
      orderRows.forEach(r => {
        const num = String(r.NUMBER || '').trim();
        orderLookup.set(num, r.ID);
        if (num.startsWith('#')) orderLookup.set(num.slice(1), r.ID);
      });

      const matched = [];
      const notFound = [];
      values.forEach(orderNum => {
        const cleaned = orderNum.trim();
        let id = orderLookup.get(cleaned);
        if (id === undefined && cleaned.startsWith('#')) id = orderLookup.get(cleaned.slice(1));
        if (id === undefined) id = orderLookup.get('#' + cleaned);
        if (id !== undefined) {
          matched.push({ id, number: cleaned });
          orderNumberMap.set(id, cleaned);
        } else {
          notFound.push(cleaned);
        }
      });

      if (matched.length === 0) {
        const sampleNums = orderRows.slice(0, 3).map(r => String(r.NUMBER)).join(', ');
        throw new Error('No matching orders found. Metabase has: ' + sampleNums + '. You entered: ' + values.slice(0, 3).join(', '));
      }

      steps[1].status = 'done';
      steps[1].label = 'Matched ' + matched.length + ' of ' + values.length + ' orders';
      updateFlowProgress(steps);

      if (notFound.length > 0) {
        showNotification(notFound.length + ' order numbers not found: ' + notFound.slice(0, 5).join(', '), 'error');
      }

      orderIds = matched.map(m => m.id);
    }

    // Shipment details
    steps.push({ label: 'Fetching shipment details...', status: 'active' });
    updateFlowProgress(steps);
    const t3 = Date.now();

    let shipmentRows;
    if (type === 'orders') {
      const batches = batchArray(orderIds, 50);
      shipmentRows = await runBatchedQueries(batches, (batch) =>
        "SELECT ORDER_ID, CONSIGNMENT AS TRACKING_NUMBER, CARRIER_NAME, " +
        "PARCELBRIGHT_SHIPMENT_ID AS SHIPMENT_ID, ALLOCATION_ID, CREATED_AT::DATE AS SHIP_DATE " +
        "FROM INT.ORDER_SHIPMENT_DETAILS WHERE COMPANY_ID = " + companyId +
        " AND LABEL_CONTENT_TYPE IS NOT NULL AND ORDER_ID IN (" + batch.join(',') + ")"
      , 5);
    } else {
      const batches = batchArray(values, 50);
      shipmentRows = await runBatchedQueries(batches, (batch) =>
        "SELECT ORDER_ID, CONSIGNMENT AS TRACKING_NUMBER, CARRIER_NAME, " +
        "PARCELBRIGHT_SHIPMENT_ID AS SHIPMENT_ID, ALLOCATION_ID, CREATED_AT::DATE AS SHIP_DATE " +
        "FROM INT.ORDER_SHIPMENT_DETAILS WHERE COMPANY_ID = " + companyId +
        " AND LABEL_CONTENT_TYPE IS NOT NULL AND CONSIGNMENT IN (" + sqlInList(batch, true) + ")"
      , 5);
    }
    steps[steps.length - 1].status = 'done';
    steps[steps.length - 1].time = Math.round((Date.now() - t3) / 1000);
    steps[steps.length - 1].label = 'Fetched ' + shipmentRows.length + ' shipments';

    if (shipmentRows.length === 0) throw new Error('No shipments found for this company/input.');

    // Dimensions
    steps.push({ label: 'Fetching dimensions...', status: 'active' });
    updateFlowProgress(steps);
    const t4 = Date.now();
    const allocationIds = [...new Set(shipmentRows.map(r => r.ALLOCATION_ID).filter(Boolean))];
    let dimRows = [];
    if (allocationIds.length > 0) {
      const batches = batchArray(allocationIds, 50);
      dimRows = await runBatchedQueries(batches, (batch) =>
        "SELECT ALLOCATION_ID, WEIGHT, DEPTH AS LENGTH, WIDTH, HEIGHT, DIMENSIONS_UNIT, WEIGHT_UNIT " +
        "FROM BASE_PENSIVE_VEEQO_APP_DB.PENSIVE_VQ_APP_ALLOCATION_PACKAGES WHERE COMPANY_ID = " + companyId +
        " AND ALLOCATION_ID IN (" + batch.join(',') + ")"
      , 5);
    }
    steps[steps.length - 1].status = 'done';
    steps[steps.length - 1].time = Math.round((Date.now() - t4) / 1000);

    // Carrier/service
    steps.push({ label: 'Fetching carrier/service...', status: 'active' });
    updateFlowProgress(steps);
    const t5 = Date.now();
    const trackingNumbers = [...new Set(shipmentRows.map(r => r.TRACKING_NUMBER).filter(Boolean))];
    let carrierRows = [];
    if (trackingNumbers.length > 0) {
      const batches = batchArray(trackingNumbers, 50);
      carrierRows = await runBatchedQueries(batches, (batch) =>
        "SELECT TRACKING_NUMBER, SERVICE_CARRIER, SERVICE_NAME, REMOTE_SHIPMENT_ID " +
        "FROM BASE_PENSIVE_VEEQO_APP_DB.PENSIVE_RATE_SHOPPING_SHIPMENTS WHERE COMPANY_ID = '" + companyId + "'" +
        " AND TRACKING_NUMBER IN (" + sqlInList(batch, true) + ")"
      , 5);
    }
    steps[steps.length - 1].status = 'done';
    steps[steps.length - 1].time = Math.round((Date.now() - t5) / 1000);

    // Rates (non-blocking)
    steps.push({ label: 'Fetching rates...', status: 'active' });
    updateFlowProgress(steps);
    const t6 = Date.now();
    const shipmentIds = [...new Set(shipmentRows.map(r => r.SHIPMENT_ID).filter(Boolean))];
    let rateRows = [];
    if (shipmentIds.length > 0) {
      try {
        const batches = batchArray(shipmentIds, 50);
        rateRows = await runBatchedQueries(batches, (batch) =>
          "SELECT SHIPMENT_ID, BASE_RATE FROM INT.SHIPPING_CREDIT_SHIPMENTS WHERE SHIPMENT_ID IN (" + batch.join(',') + ")"
        , 5);
      } catch (e) { /* non-blocking */ }
    }
    steps[steps.length - 1].status = 'done';
    steps[steps.length - 1].time = Math.round((Date.now() - t6) / 1000);

    // Build lookup maps
    const dimMap = new Map();
    dimRows.forEach(r => { dimMap.set(r.ALLOCATION_ID, r); });
    const carrierMap = new Map();
    carrierRows.forEach(r => { carrierMap.set(r.TRACKING_NUMBER, r); });
    const rateMap = new Map();
    rateRows.forEach(r => { rateMap.set(String(r.SHIPMENT_ID), r); });

    const orderShipCount = new Map();
    shipmentRows.forEach(r => { orderShipCount.set(r.ORDER_ID, (orderShipCount.get(r.ORDER_ID) || 0) + 1); });

    // Build task engine rows
    const taskEngineRows = shipmentRows.map(row => {
      const dim = dimMap.get(row.ALLOCATION_ID) || {};
      const carrier = carrierMap.get(row.TRACKING_NUMBER) || {};
      const rate = rateMap.get(String(row.SHIPMENT_ID)) || {};
      let weightLbs = 0;
      if (dim.WEIGHT) {
        const unit = (dim.WEIGHT_UNIT || '').toLowerCase();
        if (unit === 'g' || unit === 'grams') weightLbs = Math.round((dim.WEIGHT / 453.592) * 100) / 100;
        else if (unit === 'kg') weightLbs = Math.round((dim.WEIGHT * 2.20462) * 100) / 100;
        else if (unit === 'oz') weightLbs = Math.round((dim.WEIGHT / 16) * 100) / 100;
        else if (unit === 'lb' || unit === 'lbs') weightLbs = dim.WEIGHT;
        else weightLbs = Math.round((dim.WEIGHT / 453.592) * 100) / 100;
      }
      let length = dim.LENGTH || 0, width = dim.WIDTH || 0, height = dim.HEIGHT || 0;
      if ((dim.DIMENSIONS_UNIT || '').toLowerCase() === 'cm') {
        length = Math.round(length / 2.54 * 100) / 100;
        width = Math.round(width / 2.54 * 100) / 100;
        height = Math.round(height / 2.54 * 100) / 100;
      }
      return {
        trackingNumber: String(row.TRACKING_NUMBER || ''),
        shipmentId: String(row.SHIPMENT_ID || ''),
        orderId: orderNumberMap.get(row.ORDER_ID) || String(row.ORDER_ID || ''),
        sellerWeight: weightLbs, sellerLength: length, sellerWidth: width, sellerHeight: height,
        carrier: (carrier.SERVICE_CARRIER || row.CARRIER_NAME || '').toUpperCase(),
        serviceName: String(carrier.SERVICE_NAME || ''),
        sellerBaseRate: rate.BASE_RATE || 0,
        shipDate: String(row.SHIP_DATE || ''),
        _multiShip: (orderShipCount.get(row.ORDER_ID) || 1) > 1
      };
    });

    state.taskEngineRows = taskEngineRows;
    updateTrackingToOrderMap(taskEngineRows);
    state._metabaseTrackingNumbers = trackingNumbers;

    // Show copy SQL button in manual options
    document.getElementById('copy-datanet-sql-btn').style.display = '';

    // === PHASE 2: Carrier Data (Turing — default, Datanet as fallback) ===
    steps.push({ label: 'Fetching carrier data via Turing (' + trackingNumbers.length + ' trackings)...', status: 'active' });
    updateFlowProgress(steps);
    const t7 = Date.now();

    let carrierDataSuccess = false;
    let turingFailed = 0;
    let turingSucceeded = 0;
    const turingResults = [];

    // Try Turing first (fast, per-tracking)
    try {
      const TURING_CONCURRENCY = 5;
      const turingBatches = batchArray(trackingNumbers, TURING_CONCURRENCY);
      for (let bi = 0; bi < turingBatches.length; bi++) {
        const batch = turingBatches[bi];
        const promises = batch.map(tn => turingFetch(tn).then(data => ({ tn, data, ok: true })).catch(() => ({ tn, ok: false })));
        const results = await Promise.all(promises);
        results.forEach(r => {
          if (r.ok && r.data && r.data.shippingContainer) {
            turingResults.push(mapTuringToDatanetRow(r.data));
            turingSucceeded++;
          } else {
            turingFailed++;
          }
        });
        steps[steps.length - 1].label = 'Fetching carrier data via Turing... ' + turingSucceeded + '/' + trackingNumbers.length;
        updateFlowProgress(steps);
      }

      if (turingSucceeded > 0) {
        state.datanetRows = turingResults;
        carrierDataSuccess = true;
      }
    } catch (e) {
      // Turing batch failed entirely — fall back to Datanet
    }

    // Fallback to Datanet if Turing got nothing
    if (!carrierDataSuccess) {
      steps[steps.length - 1].label = 'Turing unavailable — trying Datanet...';
      updateFlowProgress(steps);

      const savedUrl = (document.getElementById('datanet-profile-url').value || '').trim();
      if (savedUrl) {
        try {
          const { profileId } = parseDatanetProfileUrl(savedUrl);
          if (profileId) {
            await datanetFetch('/whoAmI');
            const profileData = await getDatanetProfile(profileId);
            const profile = profileData.jobProfile;
            const jobIds = profileData.jobIds || [];
            if (jobIds.length > 0) {
              const { jobId: urlJobId } = parseDatanetProfileUrl(savedUrl);
              const jobId = urlJobId || String(jobIds[0]);
              const newSQL = generateDatanetSQL(trackingNumbers);
              await updateDatanetProfileSQL(profileId, profile, newSQL);
              const runId = await runDatanetJob(jobId);
              const jobRunUrl = 'https://datacentral.a2z.com/datanet/etl-manager/jobs/' + jobId + '/runs/' + runId;
              steps[steps.length - 1].label = 'Running Datanet job... <a href="' + jobRunUrl + '" target="_blank" style="color:#0066ff;">View job</a>';
              updateFlowProgress(steps);
              await pollJobRun(runId, null, null);
              const tsv = await downloadJobResults(runId);
              const rows = parseTSVToRows(tsv);
              if (rows.length > 0) {
                const mapped = rows.map(mapDatanetRow);
                const seen = new Set();
                const deduped = mapped.filter(r => { if (seen.has(r.trackingNumber)) return false; seen.add(r.trackingNumber); return true; });
                state.datanetRows = deduped;
                carrierDataSuccess = true;
              }
            }
          }
        } catch (e) { /* Datanet also failed */ }
      }
    }

    steps[steps.length - 1].status = carrierDataSuccess ? 'done' : 'error';
    steps[steps.length - 1].time = Math.round((Date.now() - t7) / 1000);
    if (carrierDataSuccess) {
      const source = turingSucceeded > 0 ? 'Turing' : 'Datanet';
      steps[steps.length - 1].label = 'Fetched ' + state.datanetRows.length + ' carrier rows (' + source + ')' + (turingFailed > 0 ? ' — ' + turingFailed + ' not found' : '');
    } else {
      steps[steps.length - 1].label = 'Carrier data unavailable — upload Datanet CSV manually';
    }
    updateFlowProgress(steps);

    // === PHASE 3: Merge ===
    if (carrierDataSuccess || state.datanetRows) {
      steps.push({ label: 'Merging & analysing...', status: 'active' });
      updateFlowProgress(steps);
      performMerge();
      steps[steps.length - 1].status = 'done';
      steps[steps.length - 1].label = '✓ Merged ' + state.mergedRows.length + ' shipments';
    } else {
      steps.push({ label: 'Upload Datanet CSV to complete merge...', status: 'active' });
    }

    const totalTime = Math.round((Date.now() - startTime) / 1000);
    updateFlowProgress(steps, 'Total: ' + totalTime + 's — ' + shipmentRows.length + ' shipments processed');

    btn.textContent = 'Fetch & Analyse';

  } catch (err) {
    const lastStep = steps[steps.length - 1];
    if (lastStep) lastStep.status = 'error';
    updateFlowProgress(steps);
    errorEl.textContent = err.message;
    btn.textContent = 'Fetch & Analyse';
  } finally {
    btn.disabled = false;
    if (btn.textContent === 'Working...') btn.textContent = 'Fetch & Analyse';
  }
}

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
  fetchSellerDetails().then(() => {
    // Auto-fill company ID from seller details
    const companyIdInput = document.getElementById('metabase-company-id');
    if (state.seller.companyId && companyIdInput) {
      companyIdInput.value = state.seller.companyId;
    }
  });

  // Fetch Metabase database ID on load
  fetchMetabaseDatabaseId();

  // Fetch & Analyse button (runs full flow)
  document.getElementById('fetch-all-btn').addEventListener('click', fetchAllFlow);

  // Fetch Datanet Data button
  document.getElementById('fetch-datanet-btn').addEventListener('click', fetchDatanetData);

  // Turing Quick Lookup
  document.getElementById('turing-add-btn').addEventListener('click', turingQuickLookup);
  document.getElementById('turing-tracking-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') turingQuickLookup();
  });

  setupUploadHandlers();
  wireTabHandlers();
  wireActionButtons();
}

document.addEventListener('DOMContentLoaded', init);
