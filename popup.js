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
  }
};

let saveAgentNameTimer = null;

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
  // Always save to localStorage as fallback
  localStorage.setItem('agentName', name);
  if (isChromeAvailable()) {
    try {
      chrome.storage.local.set({ agentName: name });
    } catch (e) {
      // Context invalidated — localStorage fallback already saved
    }
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
      const requiredCol = isTaskEngine ? 'tracking_number' : 'tracking_id';
      if (rows.length > 0 && !(requiredCol in rows[0])) {
        errorEl.textContent = 'File is missing required columns. Please upload a valid export.';
        return;
      }
      filenameEl.textContent = file.name;
      if (isTaskEngine) {
        state.taskEngineRows = rows.map(mapTaskEngineRow);
      } else {
        state.datanetRows = rows.map(mapDatanetRow);
      }
      updateMergeButton();
    })
    .catch((err) => {
      errorEl.textContent = err.message;
    });
}

function updateMergeButton() {
  const btn = document.getElementById('merge-btn');
  btn.disabled = !(state.taskEngineRows && state.datanetRows);
}

function setupUploadHandlers() {
  // Task Engine file input
  const teFile = document.getElementById('task-engine-file');
  teFile.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleFileUpload(e.target.files[0], 'task-engine');
  });

  // Datanet file input
  const dnFile = document.getElementById('datanet-file');
  dnFile.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleFileUpload(e.target.files[0], 'datanet');
  });

  // Drag and drop for Task Engine
  const teArea = document.getElementById('task-engine-upload');
  teArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    teArea.classList.add('dragover');
  });
  teArea.addEventListener('dragleave', () => {
    teArea.classList.remove('dragover');
  });
  teArea.addEventListener('drop', (e) => {
    e.preventDefault();
    teArea.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) handleFileUpload(e.dataTransfer.files[0], 'task-engine');
  });

  // Drag and drop for Datanet
  const dnArea = document.getElementById('datanet-upload');
  dnArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    dnArea.classList.add('dragover');
  });
  dnArea.addEventListener('dragleave', () => {
    dnArea.classList.remove('dragover');
  });
  dnArea.addEventListener('drop', (e) => {
    e.preventDefault();
    dnArea.classList.remove('dragover');
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
  // Chargeback Amount
  if (row.carrierAuditedTotal === 'N/A' || row.sellerBaseRate === 'N/A') {
    row.chargebackAmount = 'N/A';
  } else {
    row.chargebackAmount = Math.round((row.carrierAuditedTotal - row.sellerBaseRate) * 100) / 100;
  }

  // Weight Match
  if (row.carrierAuditedWeight === 'N/A') {
    row.weightMatch = 'N/A';
  } else if (row.sellerWeight === 'N/A') {
    row.weightMatch = 'N/A';
  } else {
    row.weightMatch = Math.abs(row.sellerWeight - row.carrierAuditedWeight) <= 0.5 ? 'Yes' : 'No';
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
    // Update label with count
    tabBtn.textContent = tab + ' (' + count + ')';
    // Hide carrier tabs with 0 rows; always show All and Unmatched
    if (tab === 'All' || tab === 'Unmatched') {
      tabBtn.style.display = '';
    } else {
      tabBtn.style.display = count > 0 ? '' : 'none';
    }
  });
}


/* ===== Table Renderer (Task 10.3) ===== */

const COLUMNS = [
  { key: 'trackingNumber', label: 'Tracking Number', monetary: false },
  { key: 'shipmentId', label: 'Shipment ID', monetary: false },
  { key: 'carrier', label: 'Carrier', monetary: false },
  { key: 'serviceName', label: 'Service Name', monetary: false },
  { key: 'sellerWeight', label: 'Seller Weight', monetary: false },
  { key: 'sellerLength', label: 'Seller Length', monetary: false },
  { key: 'sellerWidth', label: 'Seller Width', monetary: false },
  { key: 'sellerHeight', label: 'Seller Height', monetary: false },
  { key: 'sellerBaseRate', label: 'Seller Base Rate ($)', monetary: true },
  { key: 'carrierAuditedWeight', label: 'Carrier Audited Weight', monetary: false },
  { key: 'carrierAuditedLength', label: 'Carrier Audited Length', monetary: false },
  { key: 'carrierAuditedWidth', label: 'Carrier Audited Width', monetary: false },
  { key: 'carrierAuditedHeight', label: 'Carrier Audited Height', monetary: false },
  { key: 'carrierAuditedTotal', label: 'Carrier Audited Total ($)', monetary: true },
  { key: 'carrierAuditedBaseCharge', label: 'Carrier Audited Base Charge ($)', monetary: true },
  { key: 'deliveryAreaSurcharge', label: 'Delivery Area Surcharge ($)', monetary: true },
  { key: 'fuelSurcharge', label: 'Fuel Surcharge ($)', monetary: true },
  { key: 'oversizeSurcharge', label: 'Oversize Surcharge ($)', monetary: true },
  { key: 'specialHandlingSurcharge', label: 'Special Handling Surcharge ($)', monetary: true },
  { key: 'overmaxSurcharge', label: 'Overmax Surcharge ($)', monetary: true },
  { key: 'otherCharges', label: 'Other Charges ($)', monetary: true },
  { key: 'invoiceDate', label: 'Invoice Date', monetary: false },
  { key: 'chargeBreakdown', label: 'Charge Breakdown', monetary: false },
  { key: 'chargebackAmount', label: 'Chargeback Amount ($)', monetary: true },
  { key: 'weightMatch', label: 'Weight Match', monetary: false },
  { key: 'dimsMatch', label: 'Dims Match', monetary: false },
  { key: 'status', label: 'Status', monetary: false }
];

function formatMonetary(val) {
  if (val === 'N/A') return 'N/A';
  return '$' + Number(val).toFixed(2);
}

function renderTable(rows) {
  const table = document.getElementById('data-table');
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  thead.innerHTML = '';
  tbody.innerHTML = '';

  // Header row
  const headerRow = document.createElement('tr');
  const selectAllTh = document.createElement('th');
  const selectAllCb = document.createElement('input');
  selectAllCb.type = 'checkbox';
  selectAllCb.id = 'select-all-cb';
  selectAllCb.setAttribute('aria-label', 'Select All');
  selectAllTh.appendChild(selectAllCb);
  headerRow.appendChild(selectAllTh);

  COLUMNS.forEach((col) => {
    const th = document.createElement('th');
    th.textContent = col.label;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);

  // Data rows
  rows.forEach((row, idx) => {
    const tr = document.createElement('tr');
    // Checkbox cell
    const cbTd = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.setAttribute('aria-label', 'Select row ' + (idx + 1));
    cb.dataset.rowIndex = idx;
    if (state.selectedRowIndices.has(idx)) cb.checked = true;
    cb.addEventListener('change', () => {
      if (cb.checked) {
        state.selectedRowIndices.add(idx);
      } else {
        state.selectedRowIndices.delete(idx);
      }
      syncSelectAll(rows);
    });
    cbTd.appendChild(cb);
    tr.appendChild(cbTd);

    COLUMNS.forEach((col) => {
      const td = document.createElement('td');
      const val = row[col.key];
      if (col.monetary) {
        td.textContent = formatMonetary(val);
      } else {
        td.textContent = val;
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
  selectAllCb.addEventListener('change', () => {
    const checkboxes = tbody.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach((cb) => {
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
  const fedexCsvBtn = document.getElementById('export-fedex-csv-btn');
  const tcorpBtn = document.getElementById('create-tcorp-btn');
  const splatBtn = document.getElementById('copy-splat-btn');
  const exportBtn = document.getElementById('export-csv-btn');

  const tab = state.activeTab;

  if (tab === 'FedEx') {
    fedexBtn.style.display = '';
    fedexCsvBtn.style.display = '';
    tcorpBtn.style.display = '';
    splatBtn.style.display = '';
    exportBtn.style.display = '';
  } else if (tab === 'Unmatched') {
    fedexBtn.style.display = 'none';
    fedexCsvBtn.style.display = 'none';
    tcorpBtn.style.display = 'none';
    splatBtn.style.display = '';
    exportBtn.style.display = '';
  } else {
    fedexBtn.style.display = 'none';
    fedexCsvBtn.style.display = 'none';
    tcorpBtn.style.display = '';
    splatBtn.style.display = '';
    exportBtn.style.display = '';
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
    text += 'Seller: ' + row.sellerLength + ' x ' + row.sellerWidth + ' x ' + row.sellerHeight + ' in, ' + row.sellerWeight + ' lbs\n';
    text += 'Carrier Audit: ' + row.carrierAuditedLength + ' x ' + row.carrierAuditedWidth + ' x ' + row.carrierAuditedHeight + ' in, ' + row.carrierAuditedWeight + ' lbs\n\n';

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
    text += row.trackingNumber + ' | Seller: ' + row.sellerLength + 'x' + row.sellerWidth + 'x' + row.sellerHeight + ' ' + row.sellerWeight + 'lbs | Carrier: ' + row.carrierAuditedLength + 'x' + row.carrierAuditedWidth + 'x' + row.carrierAuditedHeight + ' ' + row.carrierAuditedWeight + 'lbs | Chargeback: ' + amt + '\n';
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

  // Send FedEx Email (mailto with fallback)
  document.getElementById('send-fedex-email-btn').addEventListener('click', async () => {
    try {
      const selected = getSelectedRows();
      if (selected.length === 0) {
        showNotification('Please select at least one row.', 'error');
        return;
      }
      const agentName = state.agentName.trim();
      if (!agentName) {
        showNotification('Please enter your name before generating the email template.', 'error');
        return;
      }
      const ticket = (document.getElementById('intercom-ticket').value || '').trim();
      const subject = 'Veeqo Chargebacks Dispute' + (ticket ? ' ' + ticket : '');
      const body = generateFedExEmail(selected, agentName);
      const to = 'quickresponse15@fedex.com';

      const fullMailto = 'mailto:' + encodeURIComponent(to)
        + '?subject=' + encodeURIComponent(subject)
        + '&body=' + encodeURIComponent(body);

      if (fullMailto.length <= MAILTO_URL_LIMIT) {
        window.open(fullMailto, '_blank');
      } else {
        // Body too long — copy to clipboard and open mailto with just To + Subject
        await navigator.clipboard.writeText(body);
        const shortMailto = 'mailto:' + encodeURIComponent(to)
          + '?subject=' + encodeURIComponent(subject);
        window.open(shortMailto, '_blank');
        showNotification('Email body copied to clipboard — paste into the email.', 'success');
      }
    } catch (e) {
      showNotification('Could not open email client. Please try again.', 'error');
    }
  });

  // Export FedEx CSV (selected rows only)
  document.getElementById('export-fedex-csv-btn').addEventListener('click', () => {
    try {
      const selected = getSelectedRows();
      if (selected.length === 0) {
        showNotification('Please select at least one row.', 'error');
        return;
      }
      exportCSV(selected, 'FedEx-Selected');
    } catch (e) {
      showNotification('Could not export CSV. Please try again.', 'error');
    }
  });

  // Create T.Corp (opens modal)
  document.getElementById('create-tcorp-btn').addEventListener('click', () => {
    const selected = getSelectedRows();
    if (selected.length === 0) {
      showNotification('Please select at least one row.', 'error');
      return;
    }
    openTCorpModal(selected);
  });

  // T.Corp Modal — Copy All Fields
  document.getElementById('tcorp-copy-btn').addEventListener('click', async () => {
    try {
      const text = getTCorpFormText();
      await navigator.clipboard.writeText(text);
      showNotification('T.Corp fields copied to clipboard!', 'success');
    } catch (e) {
      showNotification('Could not copy to clipboard. Please try again.', 'error');
    }
  });

  // T.Corp Modal — Open T.Corp & Auto-fill
  document.getElementById('tcorp-open-btn').addEventListener('click', async () => {
    try {
      const description = getTCorpFormText();
      const data = {
        mcid: document.getElementById('tcorp-mcid').value,
        companyId: document.getElementById('tcorp-company-id').value,
        ticketId: document.getElementById('tcorp-ticket-id').value,
        sellerName: document.getElementById('tcorp-seller-name').value,
        carrier: document.getElementById('tcorp-carrier').value,
        marketplace: document.getElementById('tcorp-marketplace').value,
        returnOutbound: document.getElementById('tcorp-return-outbound').value,
        shipDate: document.getElementById('tcorp-ship-date').value,
        amount: document.getElementById('tcorp-amount').value,
        issueSummary: document.getElementById('tcorp-issue-summary').value,
        sellerAction: document.getElementById('tcorp-seller-action').value,
        sellerSupport: document.getElementById('tcorp-seller-support').value,
        description: description
      };

      await chrome.storage.local.set({ tcorpAutofill: data });

      const tcorpUrl = 'https://t.corp.amazon.com/create/templates/21a64813-829d-4d9f-801b-b56e22f41c26';
      window.open(tcorpUrl, '_blank');

      showNotification('T.Corp page opened — fields will auto-fill when the page loads.', 'success');
      document.getElementById('tcorp-modal').style.display = 'none';
    } catch (e) {
      showNotification('Could not open T.Corp. Please try again.', 'error');
    }
  });

  // T.Corp Modal — Export Selected as CSV
  document.getElementById('tcorp-export-csv-btn').addEventListener('click', () => {
    try {
      const selected = getSelectedRows();
      if (selected.length === 0) {
        showNotification('No rows selected for export.', 'error');
        return;
      }
      exportCSV(selected, 'TCorp-Selected');
    } catch (e) {
      showNotification('Could not export CSV. Please try again.', 'error');
    }
  });

  // T.Corp Modal — Close
  document.getElementById('tcorp-close-btn').addEventListener('click', () => {
    document.getElementById('tcorp-modal').style.display = 'none';
  });

  // Close modal on overlay click
  document.getElementById('tcorp-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('tcorp-modal')) {
      document.getElementById('tcorp-modal').style.display = 'none';
    }
  });

  // Copy SPLAT T.Corp Fields
  document.getElementById('copy-splat-btn').addEventListener('click', async () => {
    try {
      const selected = getSelectedRows();
      if (selected.length === 0) {
        showNotification('Please select at least one row.', 'error');
        return;
      }
      const text = generateSplatTCorpFields(selected);
      await navigator.clipboard.writeText(text);
      showNotification('Copied to clipboard!', 'success');
    } catch (e) {
      showNotification('Could not copy to clipboard. Please try again.', 'error');
    }
  });

  // Export Tab as CSV
  document.getElementById('export-csv-btn').addEventListener('click', () => {
    try {
      const filtered = filterByTab(state.mergedRows, state.activeTab);
      if (filtered.length === 0) {
        showNotification('No rows to export.', 'error');
        return;
      }
      exportCSV(filtered, state.activeTab);
    } catch (e) {
      showNotification('Could not export CSV. Please try again.', 'error');
    }
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
      const filtered = filterByTab(state.mergedRows, state.activeTab);
      // Select all rows by default on tab switch
      state.selectedRowIndices = new Set(filtered.map((_, i) => i));
      renderTable(filtered);
    });
  });
}

/* ===== Merge Button Wiring ===== */

function wireMergeButton() {
  document.getElementById('merge-btn').addEventListener('click', () => {
    try {
      if (!state.taskEngineRows || !state.datanetRows) return;
      const merged = mergeData(state.taskEngineRows, state.datanetRows);
      merged.forEach(calculateFields);
      state.mergedRows = merged;
      state.activeTab = 'All';

      // Select all rows by default
      const filtered = filterByTab(merged, 'All');
      state.selectedRowIndices = new Set(filtered.map((_, i) => i));

      // Reset active tab UI
      const tabs = document.querySelectorAll('#tab-bar .tab');
      tabs.forEach(t => t.classList.remove('active'));
      tabs.forEach(t => { if (t.dataset.tab === 'All') t.classList.add('active'); });

      // Check if no matches
      const allUnmatched = merged.every(r => r.shipmentId === 'N/A' || r.carrierAuditedTotal === 'N/A');
      if (allUnmatched && merged.length > 0) {
        showNotification('No matching tracking numbers found between the two files.', 'error');
      }

      updateTabCounts(state.mergedRows);
      renderTable(filtered);
    } catch (e) {
      showNotification('An error occurred during merge. Please check your files.', 'error');
    }
  });
}

/* ===== Init (Bootstrap) ===== */

function init() {
  loadAgentName();

  // Agent name input handler (debounced 500ms)
  const agentInput = document.getElementById('agent-name');
  agentInput.addEventListener('input', () => {
    state.agentName = agentInput.value;
    if (saveAgentNameTimer) clearTimeout(saveAgentNameTimer);
    saveAgentNameTimer = setTimeout(() => {
      saveAgentName(agentInput.value);
    }, 500);
  });

  // Auto-fetch seller details on load
  fetchSellerDetails();

  setupUploadHandlers();
  wireTabHandlers();
  wireMergeButton();
  wireActionButtons();
  updateMergeButton();
}

document.addEventListener('DOMContentLoaded', init);
