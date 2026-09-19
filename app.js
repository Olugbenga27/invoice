/* ==========================================================================
   Invoice Studio — single-page invoice generator (vanilla JS, no build step)
   --------------------------------------------------------------------------
   Structure:
     1. constants & helpers
     2. state (blank / sample / normalise)
     3. totals maths
     4. rendering (line-item editor + live A4 preview)
     5. persistence (localStorage autosave)
     6. PDF export (jsPDF + html2canvas) with a print fallback
     7. wiring & init
   ========================================================================== */

(function () {
  'use strict';

  /* ---------------------------- 1. constants ----------------------------- */

  const STORAGE_KEY = 'invoice-studio:v1';

  const CURRENCIES = ['USD', 'EUR', 'GBP', 'NGN', 'ZAR', 'INR', 'JPY', 'AUD', 'CAD', 'BRL', 'CHF', 'AED'];

  // Loaded on demand so the page itself has zero external dependencies.
  const PDF_LIBS = {
    html2canvas: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
    jspdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
  };

  const DAY_MS = 86400000;
  const scriptPromises = new Map();

  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.prototype.slice.call((root || document).querySelectorAll(selector));

  /* ----------------------------- helpers -------------------------------- */

  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

  /** Parse user input into a non-negative number; anything odd becomes 0. */
  const toNumber = (value) => {
    // Strip grouping separators, then read the first number in the string so that
    // odd input ("1.2.3", "1,200", "1e3") is read the way a person would expect.
    const cleaned = String(value == null ? '' : value).replace(/[,\s]/g, '');
    const match = /-?\d*\.?\d+(?:e[+-]?\d+)?/i.exec(cleaned);
    if (!match) return 0;
    const n = parseFloat(match[0]);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  /** Coerce any value to a trimmed string (state fields are always strings). */
  const trimmed = (value) => String(value == null ? '' : value).trim();

  /** Percentage fields are capped so a typo can never produce a negative total. */
  const MAX_RATE = 100;
  const clampPercent = (value) => Math.min(MAX_RATE, toNumber(value));
  const clampPositive = (value) => toNumber(value);
  const clampFor = (mode, value) => (mode === 'percent' ? clampPercent(value) : clampPositive(value));

  /** True when a raw field value is not a usable number for its clamp mode. */
  const isOutOfRange = (mode, raw) => {
    if (raw === '') return false;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return true;
    return mode === 'percent' && n > MAX_RATE;
  };

  /** Keep only values a number input can display, so restored data cannot break the UI. */
  const numericInputValue = (value, fallback) => {
    const raw = trimmed(value);
    if (raw === '' || !Number.isFinite(Number(raw))) return fallback;
    // Re-serialise so forms like "1e3" or "1." become "1000" / "1" in the input.
    return String(Number(raw));
  };

  /** Same idea for date inputs: only "YYYY-MM-DD" (or an empty field) is assignable. */
  const dateInputValue = (value, fallback) => {
    const raw = trimmed(value);
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : fallback;
  };

  const trimNumber = (value) => String(Number(Number(value).toFixed(2)));

  const pad2 = (n) => String(n).padStart(2, '0');
  const isoFromDate = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const todayISO = () => isoFromDate(new Date());
  const plusDaysISO = (days) => isoFromDate(new Date(Date.now() + days * DAY_MS));

  /** "2026-09-18" -> "18 Sep 2026" (parsed as a local date, no timezone drift). */
  const formatDate = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return '\u2014';
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  };

  const formatMoney = (value, currency) => {
    const amount = Number.isFinite(value) ? value : 0;
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency }).format(amount);
    } catch (err) {
      return currency + ' ' + amount.toFixed(2);
    }
  };

  const formatQty = (value) => {
    const n = toNumber(value);
    return Number.isInteger(n) ? String(n) : trimNumber(n);
  };

  const getPath = (obj, path) => path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);

  const setPath = (obj, path, value) => {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((acc, key) => (acc[key] = acc[key] || {}), obj);
    target[last] = value;
  };

  /* ------------------------------ 2. state ------------------------------- */

  const makeItem = (description, quantity, price) => ({
    id: uid(),
    description: description == null ? '' : String(description),
    quantity: quantity == null ? 1 : quantity,
    price: price == null ? 0 : price
  });

  const blankState = () => ({
    from: { name: '', email: '', phone: '', address: '' },
    to: { name: '', email: '', address: '' },
    meta: {
      number: 'INV-0001',
      date: todayISO(),
      due: plusDaysISO(14),
      currency: 'USD',
      discountRate: 0,
      taxRate: 0,
      deliveryFee: 0
    },
    items: [makeItem()],
    notes: 'Thank you for your business!',
    payment: ''
  });

  const sampleState = () => ({
    from: {
      name: 'Northwind Studio',
      email: 'billing@northwind.studio',
      phone: '+1 (415) 555-0134',
      address: '1480 Market Street, Suite 220\nSan Francisco, CA 94103'
    },
    to: {
      name: 'Brightline Retail Ltd.',
      email: 'accounts@brightline.co',
      address: '22 Kingsway\nLondon WC2B 6UN'
    },
    meta: {
      number: 'INV-2026-014',
      date: todayISO(),
      due: plusDaysISO(14),
      currency: 'USD',
      discountRate: 5,
      taxRate: 7.5,
      deliveryFee: 25
    },
    items: [
      makeItem('Brand identity design — logo suite, colour system, usage guide', 1, 2400),
      makeItem('Landing page design and build (5 sections, responsive)', 1, 1800),
      makeItem('Additional revision rounds', 3, 120),
      makeItem('Hosting setup and handover session', 1, 250)
    ],
    notes: 'Payment is due within 14 days. Late payments may incur a 2% monthly fee.',
    payment: 'Bank transfer — Northwind Studio LLC\nAcct 0012 3456 7890 · Routing 110000000\npay.northwind.studio/INV-2026-014'
  });

  /** Coerce anything loaded from storage into a valid state object. */
  function normalize(raw) {
    const base = blankState();
    if (!raw || typeof raw !== 'object') return base;

    const text = (value, fallback) => (typeof value === 'string' ? value : fallback);

    const state = {
      from: {
        name: text((raw.from || {}).name, base.from.name),
        email: text((raw.from || {}).email, base.from.email),
        phone: text((raw.from || {}).phone, base.from.phone),
        address: text((raw.from || {}).address, base.from.address)
      },
      to: {
        name: text((raw.to || {}).name, base.to.name),
        email: text((raw.to || {}).email, base.to.email),
        address: text((raw.to || {}).address, base.to.address)
      },
      meta: {
        number: text((raw.meta || {}).number, base.meta.number),
        date: dateInputValue((raw.meta || {}).date, base.meta.date),
        due: dateInputValue((raw.meta || {}).due, ''),
        currency: CURRENCIES.indexOf((raw.meta || {}).currency) === -1 ? base.meta.currency : raw.meta.currency,
        discountRate: clampPercent((raw.meta || {}).discountRate),
        taxRate: clampPercent((raw.meta || {}).taxRate),
        deliveryFee: clampPositive((raw.meta || {}).deliveryFee)
      },
      notes: text(raw.notes, ''),
      payment: text(raw.payment, ''),
      items: []
    };

    const items = Array.isArray(raw.items) ? raw.items : [];
    items.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      state.items.push({
        id: item.id ? String(item.id) : uid(),
        description: item.description == null ? '' : String(item.description),
        quantity: numericInputValue(item.quantity, 1),
        price: numericInputValue(item.price, 0)
      });
    });

    if (!state.items.length) state.items = [makeItem()];
    return state;
  }

  let state = blankState();

  /* ------------------------------ 3. totals ------------------------------ */

  function computeTotals(s) {
    const subtotal = s.items.reduce((sum, item) => sum + toNumber(item.quantity) * toNumber(item.price), 0);
    const discountRate = clampPercent(s.meta.discountRate);
    const discount = subtotal * (discountRate / 100);
    const taxable = subtotal - discount;
    const taxRate = clampPercent(s.meta.taxRate);
    const tax = taxable * (taxRate / 100);
    const deliveryFee = clampPositive(s.meta.deliveryFee);

    return {
      subtotal: subtotal,
      discount: discount,
      discountRate: discountRate,
      tax: tax,
      taxRate: taxRate,
      deliveryFee: deliveryFee,
      total: taxable + tax + deliveryFee
    };
  }

  const itemAmount = (item) => toNumber(item.quantity) * toNumber(item.price);

  /* --------------------------- 4a. item editor --------------------------- */

  const itemRowAmount = (row) => $('.item-row__amount', row);

  function buildItemRow(item) {
    const row = document.createElement('div');
    row.className = 'item-row';
    row.dataset.id = item.id;

    const desc = document.createElement('input');
    desc.type = 'text';
    desc.className = 'input item-row__desc';
    desc.placeholder = 'What did you sell?';
    desc.value = item.description;
    desc.dataset.field = 'description';
    desc.setAttribute('aria-label', 'Item description');

    const qty = document.createElement('input');
    qty.type = 'number';
    qty.min = '0';
    qty.step = 'any';
    qty.inputMode = 'decimal';
    qty.className = 'input item-row__num item-row__qty';
    qty.value = item.quantity;
    qty.dataset.field = 'quantity';
    qty.dataset.clamp = 'positive';
    qty.setAttribute('aria-label', 'Quantity');

    const price = document.createElement('input');
    price.type = 'number';
    price.min = '0';
    price.step = '0.01';
    price.inputMode = 'decimal';
    price.className = 'input item-row__num item-row__price';
    price.value = item.price;
    price.dataset.field = 'price';
    price.dataset.clamp = 'positive';
    price.setAttribute('aria-label', 'Unit price');

    const amount = document.createElement('output');
    amount.className = 'item-row__amount';
    amount.textContent = formatMoney(itemAmount(item), state.meta.currency);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn item-row__remove';
    remove.dataset.action = 'remove';
    remove.title = 'Remove line item';
    remove.setAttribute('aria-label', 'Remove line item');
    remove.textContent = '\u2715';

    row.appendChild(desc);
    row.appendChild(qty);
    row.appendChild(price);
    row.appendChild(amount);
    row.appendChild(remove);
    return row;
  }

  /** Rebuild the editable list (only on add / remove / load — never per keystroke). */
  function renderItemsEditor() {
    const host = $('#itemsEditor');
    host.innerHTML = '';
    state.items.forEach((item) => host.appendChild(buildItemRow(item)));
  }

  function updateItemAmounts() {
    $$('#itemsEditor .item-row').forEach((row) => {
      const item = state.items.filter((it) => it.id === row.dataset.id)[0];
      if (item) itemRowAmount(row).textContent = formatMoney(itemAmount(item), state.meta.currency);
    });
  }

  function findItem(id) {
    return state.items.filter((item) => item.id === id)[0];
  }

  function addItem() {
    state.items.push(makeItem());
    renderItemsEditor();
    renderPreview();
    scheduleSave();
    const rows = $$('#itemsEditor .item-row');
    const last = rows[rows.length - 1];
    if (last) $('.item-row__desc', last).focus();
  }

  /* ----------------------- 4b. live A4 preview --------------------------- */

  function setText(selector, value) {
    const el = $(selector);
    if (el) el.textContent = value == null ? '' : String(value);
  }

  /** Fill an optional line and collapse it when the value is empty. */
  function setOptional(selector, value) {
    const el = $(selector);
    if (!el) return;
    const text = trimmed(value);
    el.textContent = text;
    el.hidden = text === '';
  }

  function toggle(selector, visible) {
    const el = $(selector);
    if (el) el.hidden = !visible;
  }

  /** Fill an optional footer block, collapsing the whole block when it is empty. */
  function setOptionalBlock(blockSelector, valueSelector, value) {
    const text = trimmed(value);
    setText(valueSelector, text);
    toggle(blockSelector, text !== '');
  }

  function cell(text, className) {
    const td = document.createElement('td');
    if (className) td.className = className;
    td.textContent = text;
    return td;
  }

  function renderPreviewItems() {
    const body = $('#outItems');
    const currency = state.meta.currency;
    body.innerHTML = '';

    const rows = state.items.filter((item) => trimmed(item.description) !== '' || itemAmount(item) > 0);

    if (!rows.length) {
      const tr = document.createElement('tr');
      tr.className = 'items__empty';
      tr.appendChild(cell('No line items yet — add one in the panel on the left.', ''));
      $('td', tr).colSpan = 4;
      body.appendChild(tr);
      return;
    }

    rows.forEach((item) => {
      const tr = document.createElement('tr');
      tr.appendChild(cell(item.description || '\u2014', 'items__desc'));
      tr.appendChild(cell(formatQty(item.quantity), 'num'));
      tr.appendChild(cell(formatMoney(toNumber(item.price), currency), 'num'));
      tr.appendChild(cell(formatMoney(itemAmount(item), currency), 'num items__amount'));
      body.appendChild(tr);
    });
  }

  function renderPreview() {
    const totals = computeTotals(state);
    const currency = state.meta.currency;

    setText('#outNumber', trimmed(state.meta.number) || 'INV-0001');
    setText('#outFromName', trimmed(state.from.name) || 'Your business name');
    const businessName = trimmed(state.from.name) || '';
    const logo = $('#outLogo');
    if (logo) {
      const initials = businessName.split(/\s+/).map((w) => w.charAt(0)).filter(Boolean).slice(0, 2).join('').toUpperCase();
      logo.textContent = initials;
      logo.hidden = !initials;
    }
    setOptional('#outFromAddress', state.from.address);
    setOptional('#outFromEmail', state.from.email);
    setOptional('#outFromPhone', state.from.phone);
    setText('#outToName', trimmed(state.to.name) || 'Client name');
    setOptional('#outToAddress', state.to.address);
    setOptional('#outToEmail', state.to.email);
    setText('#outDate', formatDate(state.meta.date));
    setText('#outDue', state.meta.due ? formatDate(state.meta.due) : '\u2014');

    renderPreviewItems();

    setText('#outSubtotal', formatMoney(totals.subtotal, currency));

    toggle('#rowDiscount', totals.discount > 0);
    setText('#outDiscountLabel', 'Discount (' + trimNumber(totals.discountRate) + '%)');
    setText('#outDiscount', '-' + formatMoney(totals.discount, currency));

    toggle('#rowTax', totals.tax > 0);
    setText('#outTaxLabel', 'Tax / VAT (' + trimNumber(totals.taxRate) + '%)');
    setText('#outTax', formatMoney(totals.tax, currency));

    toggle('#rowDelivery', totals.deliveryFee > 0);
    setText('#outDelivery', formatMoney(totals.deliveryFee, currency));

    setText('#outTotal', formatMoney(totals.total, currency));

    setOptionalBlock('#footNotes', '#outNotes', state.notes);
    setOptionalBlock('#footPayment', '#outPayment', state.payment);

    updateItemAmounts();
  }

  /* --------------------------- 5. persistence ---------------------------- */

  let saveTimer = null;

  function saveNow() {
    saveTimer = null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      // Private browsing or storage disabled — the app still works, just unsaved.
    }
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 250);
  }

  function loadSaved() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? normalize(JSON.parse(raw)) : null;
    } catch (err) {
      return null;
    }
  }

  /* ----------------------------- 6. PDF export --------------------------- */

  let statusTimer = null;

  function setStatus(message, tone) {
    const el = $('#status');
    el.textContent = message || '';
    if (tone) el.dataset.tone = tone;
    else delete el.dataset.tone;
    if (statusTimer) clearTimeout(statusTimer);
    if (message && tone !== 'warn') {
      statusTimer = setTimeout(() => {
        el.textContent = '';
        delete el.dataset.tone;
      }, 6000);
    }
  }

  /** Load a script once; repeated calls share the same promise. */
  function loadScript(src) {
    if (scriptPromises.has(src)) return scriptPromises.get(src);

    const promise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        scriptPromises.delete(src);
        reject(new Error('Could not load ' + src));
      };
      document.head.appendChild(script);
    });

    scriptPromises.set(src, promise);
    return promise;
  }

  function pdfFilename() {
    const slug = (text, fallback) => {
      const clean = String(text || '').trim().replace(/[^a-z0-9\-_ ]/gi, '').replace(/\s+/g, '-');
      return clean || fallback;
    };
    return slug(state.meta.number, 'invoice') + '-' + slug(state.to.name, 'client') + '.pdf';
  }

  /** Slice the rendered canvas into A4 pages and hand it to jsPDF. */
  function canvasToPdf(canvas, JsPDF) {
    const pdf = new JsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait', compress: true });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 18;
    const imageWidth = pageWidth - margin * 2;

    // Tallest slice, in source-canvas pixels, that still fits one A4 page.
    const maxSlice = Math.max(1, Math.floor(canvas.width * (pageHeight - margin * 2) / imageWidth));
    // Split the canvas evenly so a few leftover pixels never become a near-empty page.
    const pageCount = Math.max(1, Math.ceil(canvas.height / maxSlice));
    const sliceHeight = Math.ceil(canvas.height / pageCount);

    for (let index = 0; index < pageCount; index += 1) {
      const offset = index * sliceHeight;
      const height = Math.min(sliceHeight, canvas.height - offset);
      if (height <= 0) break;

      const slice = document.createElement('canvas');
      slice.width = canvas.width;
      slice.height = height;
      const ctx = slice.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, slice.width, slice.height);
      ctx.drawImage(canvas, 0, offset, canvas.width, height, 0, 0, canvas.width, height);

      if (index > 0) pdf.addPage();
      pdf.addImage(slice.toDataURL('image/jpeg', 0.95), 'JPEG', margin, margin, imageWidth, height * imageWidth / canvas.width);
    }

    return pdf;
  }

  /** The scroll container the live invoice currently lives in (preview or ready-to-print stage). */
  function captureHost() {
    const paper = $('#invoice');
    if (!paper) return null;
    return paper.closest('.preview, .print-view__stage') || null;
  }

  async function downloadPdf(trigger) {
    const button = trigger || $('#pdfBtn');
    if (button.disabled) return;

    const paper = $('#invoice');
    const host = captureHost();
    const previousOverflow = host ? host.style.overflow : '';
    const previousScroll = window.scrollY || 0;

    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    setStatus('Building your PDF\u2026');

    try {
      await Promise.all([loadScript(PDF_LIBS.html2canvas), loadScript(PDF_LIBS.jspdf)]);

      const html2canvas = window.html2canvas;
      const JsPDF = window.jspdf && window.jspdf.jsPDF;
      if (typeof html2canvas !== 'function' || typeof JsPDF !== 'function') {
        throw new Error('PDF libraries unavailable');
      }

      // Capture at the top of the page with no scroll containers in the way.
      if (host) host.style.overflow = 'visible';
      window.scrollTo(0, 0);

      const scale = Math.max(2, Math.min(3, window.devicePixelRatio || 2));
      const canvas = await html2canvas(paper, {
        scale: scale,
        backgroundColor: '#ffffff',
        logging: false,
        useCORS: true,
        // Match the real viewport so media queries inside the clone behave as on screen.
        windowWidth: Math.max(paper.scrollWidth, window.innerWidth || 0),
        windowHeight: Math.max(paper.scrollHeight, window.innerHeight || 0)
      });

      canvasToPdf(canvas, JsPDF).save(pdfFilename());
      setStatus('PDF saved to your downloads folder.', 'ok');
    } catch (err) {
      console.error('[invoice] PDF export failed:', err);
      setStatus('PDF library unavailable (offline?) — opening the print dialog instead. Choose "Save as PDF".', 'warn');
      window.print();
    } finally {
      if (host) host.style.overflow = previousOverflow;
      window.scrollTo(0, previousScroll);
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }

  /* ----------------------- 6b. social sharing ---------------------------- */

  let shareMenuOpen = false;
  let toastTimer = null;

  const buildShareUrl = () => {
    const base = location.href.split('#')[0];
    try {
      const payload = btoa(encodeURIComponent(JSON.stringify(state)));
      return base + '#inv=' + payload;
    } catch (err) {
      return base;
    }
  };

  function parseShareHash() {
    const match = /[#&]inv=([^&]+)/.exec(location.hash);
    if (!match) return null;
    try {
      return JSON.parse(decodeURIComponent(atob(match[1])));
    } catch (err) {
      return null;
    }
  }

  const shareTotal = () => formatMoney(computeTotals(state).total, state.meta.currency);
  const shareNumber = () => trimmed(state.meta.number) || 'INV-0001';

  function xMessage() {
    return 'Invoice ' + shareNumber() + ' has been generated. Total: ' + shareTotal();
  }

  function showToast(message) {
    const toast = $('#shareToast');
    toast.textContent = message;
    toast.classList.add('toast--show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('toast--show'), 2600);
  }

  async function copyShareLink() {
    const url = buildShareUrl();
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
      } else {
        const helper = document.createElement('textarea');
        helper.value = url;
        helper.style.position = 'fixed';
        helper.style.opacity = '0';
        document.body.appendChild(helper);
        helper.focus();
        helper.select();
        document.execCommand('copy');
        helper.remove();
      }
      showToast('Link copied');
    } catch (err) {
      showToast('Could not copy — copy the address manually.');
    }
  }

  function openShareMenu() {
    shareMenuOpen = true;
    $('#shareMenu').hidden = false;
    $('#shareSubMenu').hidden = true;
    $('#shareBtn').setAttribute('aria-expanded', 'true');
    $('#nativeShareBtn').hidden = typeof navigator.share !== 'function';
    const first = $('.share-opt', $('#shareMenu'));
    if (first) first.focus();
    // Warm up the image renderer so sharing keeps the user-gesture context.
    loadScript(PDF_LIBS.html2canvas).catch(() => {});
  }

  function closeShareMenu() {
    shareMenuOpen = false;
    $('#shareMenu').hidden = true;
    $('#shareBtn').setAttribute('aria-expanded', 'false');
    if (document.activeElement && $('#shareMenu').contains(document.activeElement)) {
      if (printViewOpen) $('#pvShareBtn').focus();
      else $('#shareBtn').focus();
    }
  }

  /** Render the live invoice to a PNG canvas using html2canvas (same path as the PDF). */
  async function buildShareImage() {
    await loadScript(PDF_LIBS.html2canvas);
    if (typeof window.html2canvas !== 'function') throw new Error('Image library unavailable (offline?)');

    const paper = $('#invoice');
    const host = captureHost();
    const previousOverflow = host ? host.style.overflow : '';
    const previousScroll = window.scrollY || 0;

    // Capture at the top of the page with no scroll containers in the way.
    if (host) host.style.overflow = 'visible';
    window.scrollTo(0, 0);

    try {
      return await window.html2canvas(paper, {
        scale: 2,
        backgroundColor: '#ffffff',
        logging: false,
        useCORS: true,
        windowWidth: Math.max(paper.scrollWidth, window.innerWidth || 0),
        windowHeight: Math.max(paper.scrollHeight, window.innerHeight || 0)
      });
    } finally {
      if (host) host.style.overflow = previousOverflow;
      window.scrollTo(0, previousScroll);
    }
  }

  const canvasBlob = (canvas) =>
    new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image'))), 'image/png');
    });

  function shareImageName(platform) {
    const slug = trimmed(state.meta.number).replace(/[^a-z0-9\-_ ]/gi, '').replace(/\s+/g, '-') || 'invoice';
    return slug + '-' + platform + '.png';
  }

  function downloadCanvas(canvas, filename) {
    const anchor = document.createElement('a');
    anchor.href = canvas.toDataURL('image/png');
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  async function downloadShareImage() {
    setStatus('Preparing a shareable image\u2026');
    try {
      downloadCanvas(await buildShareImage(), shareImageName('invoice'));
      setStatus('Image saved to your downloads.', 'ok');
    } catch (err) {
      console.error('[invoice] image export failed:', err);
      setStatus('Image export unavailable (offline?) \u2014 use the PDF instead.', 'warn');
    }
  }

  /** Generate a share image, native-share it when possible, else download with guidance. */
  async function shareAsImage(platform) {
    const label = platform.charAt(0).toUpperCase() + platform.slice(1);
    const guidance = {
      instagram: 'Image saved \u2014 open Instagram and add it as a Story or post.',
      tiktok: 'Image saved \u2014 open TikTok and upload it.',
      whatsapp: 'Image saved \u2014 open WhatsApp, attach it in a chat, and send.',
      x: 'Image saved \u2014 open X and attach it to your post.'
    }[platform] || 'Image saved to your downloads.';

    setStatus('Preparing your ' + label + ' image\u2026');
    try {
      const canvas = await buildShareImage();
      const canNative = navigator.share && navigator.canShare;
      if (canNative) {
        const file = new File([await canvasBlob(canvas)], shareImageName(platform), { type: 'image/png' });
        if (navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({ files: [file], title: 'Invoice ' + shareNumber(), text: xMessage() });
            setStatus(label + ' image shared.', 'ok');
            return;
          } catch (err) {
            if (err && err.name === 'AbortError') return;
          }
        }
      }
      downloadCanvas(canvas, shareImageName(platform));
      showToast(guidance);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      console.error('[invoice] ' + label + ' image failed:', err);
      setStatus(label + ' image failed \u2014 try downloading the PDF instead.', 'warn');
    }
  }

  async function nativeWebShare() {
    const url = buildShareUrl();
    try {
      await navigator.share({
        title: 'Invoice ' + shareNumber(),
        text: xMessage(),
        url: url
      });
    } catch (err) {
      if (err && err.name !== 'AbortError') showToast('Sharing is not available on this device.');
    }
  }

  /* ------------------------ printable / share view ------------------------ */

  let printViewOpen = false;
  let printViewReturnFocus = null;

  function openPrintView() {
    if (printViewOpen) return;
    const paper = $('#invoice');
    const stage = $('#printViewStage');
    if (!paper || !stage) return;

    // Move the live invoice into the full-screen stage; single source of truth.
    if (paper.parentElement !== stage) stage.appendChild(paper);

    printViewReturnFocus = document.activeElement;
    printViewOpen = true;
    $('#printView').hidden = false;
    document.body.classList.add('print-view-open');
    $('#pvPrintBtn').focus();
  }

  function closePrintView() {
    const paper = $('#invoice');
    const preview = $('.preview');
    if (paper && preview && paper.parentElement !== preview) {
      const label = $('.preview__label');
      if (label && label.nextSibling) preview.insertBefore(paper, label.nextSibling);
      else preview.appendChild(paper);
    }
    $('#printView').hidden = true;
    document.body.classList.remove('print-view-open');
    printViewOpen = false;
    const backTo = printViewReturnFocus;
    printViewReturnFocus = null;
    if (backTo && backTo.focus && document.contains(backTo)) backTo.focus();
    else $('#printShareBtn').focus();
  }

  function handlePrintViewKeydown(event) {
    if (event.key === 'Escape' && printViewOpen && !shareMenuOpen) closePrintView();
  }

  function bindPrintViewEvents() {
    $('#printShareBtn').addEventListener('click', openPrintView);
    $('#pvCloseBtn').addEventListener('click', closePrintView);
    $('#pvPrintBtn').addEventListener('click', () => {
      window.print();
    });
    $('#pvPdfBtn').addEventListener('click', () => {
      downloadPdf($('#pvPdfBtn')).then(() => showToast('PDF saved to your downloads.'));
    });
    $('#pvImageBtn').addEventListener('click', () => {
      downloadShareImage();
    });
    $('#pvShareBtn').addEventListener('click', openShareMenu);
    document.addEventListener('keydown', handlePrintViewKeydown);
  }

  function bindShareEvents() {
    const menu = $('#shareMenu');

    $('#shareBtn').addEventListener('click', () => {
      if (shareMenuOpen) closeShareMenu();
      else openShareMenu();
    });

    $('#nativeShareBtn').addEventListener('click', () => {
      closeShareMenu();
      nativeWebShare();
    });

    menu.addEventListener('click', (event) => {
      if (event.target.closest('[data-share-close]')) {
        closeShareMenu();
        return;
      }
      const option = event.target.closest('[data-share]');
      if (!option) return;
      const action = option.dataset.share;

      if (action === 'download') {
        $('#shareSubMenu').hidden = !$('#shareSubMenu').hidden;
        return;
      }
      if (action === 'copy') {
        copyShareLink();
        return;
      }
      if (action === 'native') {
        closeShareMenu();
        nativeWebShare();
        return;
      }
      if (action === 'pdf') {
        closeShareMenu();
        downloadPdf();
        return;
      }
      if (action === 'image') {
        closeShareMenu();
        downloadShareImage();
        return;
      }
      if (action === 'instagram') {
        closeShareMenu();
        shareAsImage('instagram');
        return;
      }
      if (action === 'tiktok') {
        closeShareMenu();
        shareAsImage('tiktok');
        return;
      }
      if (action === 'whatsapp') {
        closeShareMenu();
        shareAsImage('whatsapp');
        return;
      }
      if (action === 'x') {
        closeShareMenu();
        shareAsImage('x');
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && shareMenuOpen) closeShareMenu();
    });
  }

  /* ---------------------------- 7. wiring -------------------------------- */

  /** Push a field's value into state, wherever the field lives (panel or item row). */
  function applyFieldValue(field) {
    if (field.dataset.bind) {
      setPath(state, field.dataset.bind, field.value);
      return;
    }
    const row = field.closest('.item-row');
    const item = row ? findItem(row.dataset.id) : null;
    if (item) item[field.dataset.field] = field.value;
  }

  /** Percentage / positive-number fields are flagged (never silently blocked) while out of range. */
  function flagRange(field) {
    if (!field.dataset.clamp) return;
    if (isOutOfRange(field.dataset.clamp, trimmed(field.value))) field.setAttribute('aria-invalid', 'true');
    else field.removeAttribute('aria-invalid');
  }

  function buildCurrencyOptions() {
    const select = $('#currencySelect');
    CURRENCIES.forEach((code) => {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = code;
      select.appendChild(option);
    });
  }

  /** Push state into every field carrying a data-bind attribute. */
  function readStateIntoForm() {
    $$('[data-bind]').forEach((el) => {
      const value = getPath(state, el.dataset.bind);
      el.value = value == null ? '' : value;
    });
  }

  function resetAll() {
    if (!window.confirm('Clear this invoice and start over? This cannot be undone.')) return;
    state = blankState();
    readStateIntoForm();
    renderItemsEditor();
    renderPreview();
    saveNow();
    setStatus('Invoice cleared.');
  }

  function loadSample() {
    state = sampleState();
    readStateIntoForm();
    renderItemsEditor();
    renderPreview();
    saveNow();
    setStatus('Sample invoice loaded.', 'ok');
  }

  function bindEvents() {
    const form = $('#invoiceForm');
    const itemsHost = $('#itemsEditor');

    // No page reloads — this is a single-page app.
    form.addEventListener('submit', (event) => event.preventDefault());

    // Every text / number / date / select field in the panel.
    form.addEventListener('input', (event) => {
      const field = event.target.closest('[data-bind]');
      if (!field) return;
      applyFieldValue(field);
      flagRange(field);
      renderPreview();
      scheduleSave();
    });

    // Leaving a percentage / amount field snaps it back into a valid range.
    form.addEventListener('change', (event) => {
      const field = event.target.closest('[data-clamp]');
      if (!field) return;
      const clamped = clampFor(field.dataset.clamp, field.value);
      if (trimmed(field.value) !== String(clamped)) {
        field.value = clamped;
        applyFieldValue(field);
        renderPreview();
        scheduleSave();
      }
      field.removeAttribute('aria-invalid');
    });

    // Line-item edits (delegated, so rows added later are covered too).
    itemsHost.addEventListener('input', (event) => {
      const field = event.target.closest('[data-field]');
      if (!field) return;
      applyFieldValue(field);
      flagRange(field);
      renderPreview();
      scheduleSave();
    });

    // Same snap-to-range behaviour for item quantities and prices.
    itemsHost.addEventListener('change', (event) => {
      const field = event.target.closest('[data-clamp]');
      if (!field) return;
      const clamped = clampFor(field.dataset.clamp, field.value);
      if (trimmed(field.value) !== String(clamped)) {
        field.value = clamped;
        applyFieldValue(field);
        renderPreview();
        scheduleSave();
      }
      field.removeAttribute('aria-invalid');
    });

    itemsHost.addEventListener('click', (event) => {
      const button = event.target.closest('[data-action="remove"]');
      if (!button) return;
      const row = button.closest('.item-row');
      state.items = state.items.filter((item) => item.id !== row.dataset.id);
      if (!state.items.length) state.items.push(makeItem());
      renderItemsEditor();
      renderPreview();
      scheduleSave();
    });

    // Enter on a description adds the next line item.
    itemsHost.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || !event.target.closest('.item-row__desc')) return;
      event.preventDefault();
      addItem();
    });

    $('#addItemBtn').addEventListener('click', addItem);
    $('#pdfBtn').addEventListener('click', () => downloadPdf($('#pdfBtn')));
    $('#printBtn').addEventListener('click', () => window.print());
    $('#resetBtn').addEventListener('click', resetAll);
    $('#sampleBtn').addEventListener('click', loadSample);

    // Persist anything still in flight before the tab goes away. beforeunload is
    // unreliable on mobile, so pagehide / visibilitychange are covered as well.
    window.addEventListener('beforeunload', saveNow);
    window.addEventListener('pagehide', saveNow);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveNow();
    });
  }

  function init() {
    buildCurrencyOptions();
    const shared = parseShareHash();
    state = shared ? normalize(shared) : (loadSaved() || blankState());
    readStateIntoForm();
    renderItemsEditor();
    renderPreview();
    bindEvents();
    bindShareEvents();
    bindPrintViewEvents();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
