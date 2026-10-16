/* GB Diary — app.js  v4.0 (web app)
   Month / Week / Day views + light/dark theme
   Proxies requests via Cloudflare Worker (CORS bypass) */

const BASE  = 'https://gbelectricals.co.uk';
const PROXY = 'https://gb-proxy.gbmandeep.workers.dev';
const TRPC  = `${PROXY}/trpc`;

// localStorage polyfill matching chrome.storage.local shape
const store = {
  async get(keys) {
    const result = {};
    const arr = Array.isArray(keys) ? keys : [keys];
    arr.forEach(k => { const v = localStorage.getItem(k); if (v !== null) try { result[k] = JSON.parse(v); } catch { result[k] = v; } });
    return result;
  },
  async set(obj) {
    Object.entries(obj).forEach(([k, v]) => localStorage.setItem(k, JSON.stringify(v)));
  },
};

// ── tRPC ──────────────────────────────────────────────────────────────────────

function extractData(payload) {
  const r = Array.isArray(payload) ? payload[0] : payload;
  if (r?.error) throw new Error(r.error?.json?.message || r.error?.message || 'API error');
  const data = r?.result?.data;
  return data?.json !== undefined ? data.json : data;
}
async function trpcQuery(proc, input = {}) {
  const url = `${TRPC}/${proc}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return extractData(await resp.json());
}
async function trpcMutate(proc, input = {}) {
  const resp = await fetch(`${TRPC}/${proc}`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ json: input })
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return extractData(await resp.json());
}

// ── API ───────────────────────────────────────────────────────────────────────

const api = {
  login:    (email, pass)        => trpcMutate('auth.officeLogin', { email, password: pass }),
  me:       ()                   => trpcQuery('auth.officeMe'),
  logout:   ()                   => trpcMutate('auth.officeLogout'),
  week:     (weekOf)             => trpcQuery('diary.week', { weekOf }),
  reschedule:(jobId, date, engId)=> trpcMutate('diary.reschedule', { jobId, date, ...(engId != null ? { engineerId: engId } : {}) }),
  createJob: async (data) => {
    const attempts = [
      () => trpcMutate('jobs.create',    data),
      () => trpcMutate('diary.createJob',data),
      () => trpcMutate('diary.addJob',   data),
      () => trpcMutate('jobs.add',       data),
    ];
    for (const fn of attempts) {
      try { return await fn(); } catch(e) {
        if (/404|not found|No procedure/i.test(e.message)) continue;
        throw e;
      }
    }
    throw new Error('No create-job endpoint found on portal');
  },
  // Try the most likely endpoint names for confirm; falls through to first success
  setConfirmed: async (jobId, confirmed) => {
    const attempts = [
      () => trpcMutate('jobs.setConfirmed',   { jobId, confirmed }),
      () => trpcMutate('jobs.confirm',         { jobId, confirmed }),
      () => trpcMutate('jobs.update',          { id: jobId, confirmed }),
      () => trpcMutate('diary.setConfirmed',   { jobId, confirmed }),
    ];
    for (const fn of attempts) {
      try { return await fn(); } catch(e) { if (e.message?.includes('404') || e.message?.includes('not found') || e.message?.includes('No procedure')) continue; throw e; }
    }
    throw new Error('No confirm endpoint found — please check F12 console');
  },
  updateAmount: async (jobId, amount) => {
    return trpcMutate('jobs.update', { id: jobId, price: amount });
  },
  updateNotes: async (jobId, job, value) => {
    return trpcMutate('jobs.update', { id: jobId, description: value });
  },
  getJob: (jobId) => trpcQuery('jobs.get', { id: jobId }),
  setStatus: (jobId, statusKey, extra = {}) => {
    const STATUS_API = {
      pending: 'Pending', in_progress: 'In Progress', engineer_completed: 'Engineer Completed',
      completed: 'Completed', invoiced: 'Invoiced', closed: 'Closed',
      failed: 'Failed', cannot_access: 'Cannot Access', cancelled: 'Cancelled',
    };
    const apiStatus = STATUS_API[statusKey] || statusKey;
    return trpcMutate('jobs.setStatus', { id: jobId, status: apiStatus, ...extra });
  },
};

// ── State ─────────────────────────────────────────────────────────────────────

let user        = null;
let view        = 'week';       // 'month' | 'week' | 'day'
let curDate     = todayISO();   // active date (day view anchor)
let curWeek     = null;         // Monday ISO
let curMonth    = null;         // { year, month }
let cache       = {};           // { mondayISO: lanes[] }
let engColors   = {};
let colorIdx    = 0;
let isDark      = true;
let dragJob     = null, dragDate2 = null, dragEng = null;

// ── Auto-refresh ─────────────────────────────────────────────────────────────
let _refreshTimer    = null;
let _refreshInterval = 20;   // seconds between auto-refreshes
let _refreshNext     = 0;    // epoch ms when next refresh fires
let _refreshTick     = null; // countdown ticker

function startAutoRefresh() {
  stopAutoRefresh();
  _schedule();
  _refreshTick = setInterval(_tickLive, 1000);
  _setLiveDot(true);
}

function stopAutoRefresh() {
  if (_refreshTimer) { clearTimeout(_refreshTimer);   _refreshTimer = null; }
  if (_refreshTick)  { clearInterval(_refreshTick);   _refreshTick  = null; }
  _setLiveDot(false);
}

function _schedule() {
  _refreshNext = Date.now() + _refreshInterval * 1000;
  _refreshTimer = setTimeout(async () => {
    await silentRefresh();
    _schedule();                     // reschedule after each refresh
  }, _refreshInterval * 1000);
}

function _tickLive() {
  const secs = Math.max(0, Math.round((_refreshNext - Date.now()) / 1000));
  ['w','d','m'].forEach(s => {
    const el = document.getElementById(`live-cd-${s}`);
    if (el) el.textContent = secs > 0 ? `${secs}s` : '…';
  });
}

function _isUserTyping() {
  const a = document.activeElement;
  if (!a) return false;
  const tag = a.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable;
}

function _setLiveDot(on) {
  document.querySelectorAll('.live-dot').forEach(d => {
    d.style.display = on ? 'inline-block' : 'none';
  });
}

async function silentRefresh() {
  // Never interrupt active typing / form use
  if (_isUserTyping()) {
    // Retry in 5 s without resetting the main schedule
    setTimeout(silentRefresh, 5000);
    return;
  }
  clearCache();
  try {
    if (view === 'day') {
      const lanes = await getWeek(mondayOf(curDate), true);
      // Don't rebuild filter bar — preserves search text & engineer selection
      renderDay(lanes, null);
    } else if (view === 'week')  { await loadWeek(true); }
    else if (view === 'month') { await loadMonth(true); }
    setStatus(`Loaded · ${now()}`);
    ['w','d','m'].forEach(s => {
      const el = document.getElementById(`sdot-${s}`);
      if (el) { el.style.background='#22C55E'; setTimeout(()=>{ el.style.background=''; },800); }
    });
  } catch(e) { /* silent */ }
}

const PALETTE = ['#3B82F6','#22C55E','#8B5CF6','#F59E0B','#14B8A6','#EC4899','#6366F1','#F97316','#06B6D4','#84CC16'];
const STATUS_COLORS = {
  pending:'#F59E0B', in_progress:'#3B82F6', engineer_completed:'#8B5CF6',
  completed:'#22C55E', invoiced:'#14B8A6', paid:'#16A34A', closed:'#16A34A',
  cannot_access:'#F97316', cancelled:'#6B7280', failed:'#EF4444',
  quotation:'#6366F1', project:'#8B5CF6', waiting_certificate:'#14B8A6',
  in_review:'#8B5CF6',
};
const STATUS_LABEL = {
  pending:'Pending', in_progress:'In Progress', engineer_completed:'In Review',
  completed:'Awaiting Invoice', invoiced:'Invoiced', closed:'Complete', paid:'Paid',
  failed:'Failed', cannot_access:'Cannot Access', cancelled:'Cancelled',
  quotation:'Quotation', project:'Project', waiting_certificate:'Waiting Certificate',
  in_review:'In Review',
};

// All status tabs shown in the day view (matches portal jobs page tabs)
const DAY_STATUS_TABS = [
  { key: '',                      label: 'All'                },
  { key: 'project',               label: 'Project'            },
  { key: 'quotation',             label: 'Quotation'          },
  { key: 'waiting_certificate',   label: 'Waiting Certificate'},
  { key: 'pending',               label: 'Pending'            },
  { key: 'in_progress',           label: 'In Progress'        },
  { key: 'engineer_completed',    label: 'In Review'          },
  { key: 'in_review',             label: 'In Review'          },
  { key: 'completed',             label: 'Awaiting Invoice'   },
  { key: 'invoiced',              label: 'Invoiced'           },
  { key: 'paid',                  label: 'Paid'               },
  { key: 'closed',                label: 'Complete'           },
  { key: 'failed',                label: 'Failed'             },
  { key: 'cannot_access',         label: 'Cannot Access'      },
  { key: 'cancelled',             label: 'Cancelled'          },
];

// ── Date utils ────────────────────────────────────────────────────────────────

function isoOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function todayISO() { return isoOf(new Date()); }
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return isoOf(d);
}
function mondayOf(iso) {
  const d = new Date(iso + 'T00:00:00');
  const dow = d.getDay();
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  return isoOf(d);
}
function weekDays(mon) { return Array.from({length:7}, (_,i) => addDays(mon, i)); }

function fmtWeek(mon) {
  const a = new Date(mon + 'T00:00:00');
  const b = new Date(mon + 'T00:00:00'); b.setDate(b.getDate()+6);
  const f = d => d.toLocaleDateString('en-GB', {day:'numeric', month:'short'});
  return `${f(a)} – ${f(b)} ${b.getFullYear()}`;
}
function fmtDay(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', {weekday:'long', day:'numeric', month:'long', year:'numeric'});
}
function fmtMonth(y, m) {
  return new Date(y, m-1, 1).toLocaleDateString('en-GB', {month:'long', year:'numeric'});
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function engColor(id) {
  if (id == null) return '#888';
  if (!engColors[id]) engColors[id] = PALETTE[colorIdx++ % PALETTE.length];
  return engColors[id];
}
function jobStatus(job) { return (job.status||'pending').toLowerCase().replace(/ /g,'_'); }

// ── Status bar ────────────────────────────────────────────────────────────────

function setStatus(msg, ok=true) {
  ['stxt-w','stxt-d','stxt-m'].forEach(id => { const e=document.getElementById(id); if(e) e.textContent=msg; });
  ['sdot-w','sdot-d','sdot-m'].forEach(id => { const e=document.getElementById(id); if(e) e.classList.toggle('err',!ok); });
}
function setUser(name) {
  ['uname-w','uname-d','uname-m'].forEach(id => { const e=document.getElementById(id); if(e) e.textContent=name; });
}

// ── Theme ─────────────────────────────────────────────────────────────────────

function applyTheme() {
  document.body.setAttribute('data-theme', isDark ? 'dark' : 'light');
  const ic = isDark ? '🌙' : '☀️';
  ['week-theme','day-theme','month-theme','inv-theme-btn','stmt-theme-btn'].forEach(id => { const e=document.getElementById(id); if(e) e.textContent=ic; });
  try { localStorage.setItem('gb-theme', isDark ? 'dark' : 'light'); } catch {}
}
function toggleTheme() { isDark = !isDark; applyTheme(); }

// ── View switcher ─────────────────────────────────────────────────────────────

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-add').style.display = 'none';
  const el = document.getElementById(`view-${name}`);
  if (el) el.classList.add('active');
  view = name;
  document.querySelectorAll('.vbtn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
}

async function switchView(name) {
  if (name === 'week') {
    if (!curWeek) curWeek = mondayOf(curDate);
    showView('week');
    await loadWeek();
  } else if (name === 'day') {
    showView('day');
    await loadDay();
  } else if (name === 'month') {
    if (!curMonth) { const d = new Date(curDate+'T00:00:00'); curMonth = {year:d.getFullYear(), month:d.getMonth()+1}; }
    showView('month');
    await loadMonth();
  } else if (name === 'invoices') {
    await openInvoices();
  } else if (name === 'statements') {
    await openStatements();
  }
}

// ── Cache ─────────────────────────────────────────────────────────────────────

async function getWeek(mon, force=false) {
  if (!force && cache[mon]) return cache[mon];
  const data = await api.week(mon);
  cache[mon] = normaliseLanes(data, mon);
  return cache[mon];
}
function clearCache() { cache = {}; }

function normaliseLanes(data, mon) {
  const days = weekDays(mon);
  if (data?.lanes) return data.lanes;
  if (data?.engineers && data?.dayJobs) {
    return data.engineers.map(eng => ({
      engineer: eng,
      days: days.map(d => ({ date:d, jobs: data.dayJobs[d]?.[eng?.id||'unassigned']||[] }))
    }));
  }
  const jobs = Array.isArray(data) ? data : (data?.jobs||[]);
  return buildLanes(jobs, days);
}

function buildLanes(jobs, days) {
  const map = new Map();
  jobs.forEach(j => {
    const eng = j.engineer||j.assignedEngineer||null;
    const id  = eng?.id||'unassigned';
    if (!map.has(id)) map.set(id, {engineer: id==='unassigned'?null:eng, days:days.map(d=>({date:d,jobs:[]}))});
  });
  if (!map.has('unassigned')) map.set('unassigned', {engineer:null, days:days.map(d=>({date:d,jobs:[]}))});
  jobs.forEach(j => {
    const d   = (j.date||j.scheduledDate||j.visitPlan?.date||'').slice(0,10);
    const id  = (j.engineer||j.assignedEngineer||null)?.id||'unassigned';
    const lane = map.get(id);
    if (!lane) return;
    const di  = days.indexOf(d);
    if (di >= 0) lane.days[di].jobs.push(j);
  });
  const assigned = [...map.values()].filter(l=>l.engineer);
  const unassigned = map.get('unassigned');
  if (unassigned) assigned.push(unassigned);
  return assigned;
}

// ── WEEK VIEW ─────────────────────────────────────────────────────────────────

async function loadWeek(force=false) {
  const body = document.getElementById('week-body');
  body.innerHTML = '<div class="loading-row"><div class="spinner"></div>Loading…</div>';
  document.getElementById('week-label').textContent = fmtWeek(curWeek);
  setStatus('Loading…');
  try {
    const lanes = await getWeek(curWeek, force);
    renderWeek(lanes);
    setStatus(`Loaded · ${now()}`);
  } catch(e) {
    body.innerHTML = err(e.message);
    setStatus(e.message, false);
  }
}

function renderWeek(lanes) {
  const days  = weekDays(curWeek);
  const today = todayISO();
  const total = lanes.reduce((s,l)=>s+l.days.reduce((ss,d)=>ss+d.jobs.length,0),0);

  const grid = document.createElement('div');
  grid.className = 'diary-grid';
  grid.style.gridTemplateColumns = `130px repeat(7, 1fr)`;

  // Corner
  const corner = document.createElement('div');
  corner.className = 'eng-corner';
  corner.innerHTML = `<span>Engineer</span><span>${total} jobs this week</span>`;
  grid.appendChild(corner);

  // Day headers
  days.forEach(iso => {
    const d = new Date(iso+'T00:00:00');
    const isT = iso === today;
    const hdr = document.createElement('div');
    hdr.className = 'day-hdr' + (isT?' today-hdr':'');
    hdr.innerHTML = `<div class="dh-name">${d.toLocaleDateString('en-GB',{weekday:'short'})}</div><div class="dh-num">${d.getDate()}</div><div class="dh-mon">${d.toLocaleDateString('en-GB',{month:'short'})}</div>`;
    hdr.addEventListener('click', () => { curDate = iso; switchView('day'); });
    grid.appendChild(hdr);
  });

  // Rows
  lanes.forEach(lane => {
    const eng   = lane.engineer;
    const engId = eng?.id || null;
    const color = engColor(engId);

    const eh = document.createElement('div');
    eh.className = 'eng-hdr' + (!engId?' unassigned':'');
    eh.innerHTML = `<span class="eng-dot" style="background:${color}"></span><span title="${esc(eng?.name||'Unassigned')}">${esc(eng?.name||'Unassigned')}</span>`;
    grid.appendChild(eh);

    days.forEach((iso, di) => {
      const dayData = lane.days[di] || {jobs:[]};
      const cell = document.createElement('div');
      cell.className = 'grid-cell' + (iso===today?' today-col':'');
      cell.dataset.date  = iso;
      cell.dataset.engId = engId || '';

      dayData.jobs.forEach(job => cell.appendChild(weekCard(job, iso, engId)));

      cell.addEventListener('dragover', e => { e.preventDefault(); cell.classList.add('drag-over'); });
      cell.addEventListener('dragleave', () => cell.classList.remove('drag-over'));
      cell.addEventListener('drop', async e => {
        e.preventDefault(); cell.classList.remove('drag-over');
        const toDate = cell.dataset.date;
        const toEng  = cell.dataset.engId || null;
        if (!dragJob || (dragDate2===toDate && dragEng===toEng)) return;
        setStatus('Moving…');
        try { await api.reschedule(dragJob, toDate, toEng); clearCache(); await loadWeek(true); setStatus('Moved ✓'); }
        catch(ex) { setStatus('Move failed: '+ex.message, false); }
      });
      grid.appendChild(cell);
    });
  });

  const body = document.getElementById('week-body');
  body.innerHTML = '';
  body.appendChild(grid);
}

// ── Job field helpers ─────────────────────────────────────────────────────────

function jobTitle(job) {
  return job.title || job.description || job.jobType || job.type || '';
}
function jobAddr(job) {
  const pa = job.property;
  if (pa) {
    const a  = typeof pa.address === 'string' ? pa.address.trim() : '';
    const pc = (pa.postcode || '').trim();
    if (a) return (pc && !a.includes(pc)) ? `${a}, ${pc}` : a;
    const flat = pa.fullAddress || pa.formattedAddress || pa.addressString ||
                 pa.address1   || pa.addressLine1      || pa.street        || pa.Address;
    if (flat && typeof flat === 'string') return flat.trim();
  }
  return job.address || job.location || job.propertyAddress || job.siteAddress || '';
}
function jobCustomer(job) {
  return job.contact?.name || job.contact_snapshot?.name ||
         job.customer?.name || job.customerName || job.clientName ||
         job.client?.name || job.property?.tenantName || job.property?.ownerName ||
         job.property?.landlordName || job.landlord?.name || '';
}
function jobPhone(job) {
  return job.contact?.phone || job.contact?.mobile ||
         job.contact_snapshot?.phone || job.contact_snapshot?.mobile ||
         job.customer?.phone || job.customer?.mobile || job.customer?.telephone ||
         job.contactPhone || job.contactMobile ||
         job.property?.phone || job.property?.mobile || job.property?.telephone ||
         job.property?.contact?.phone ||
         job.client?.phone || job.client?.mobile || '';
}
function jobAccess(job) {
  return job.property?.access_notes || job.access_notes || job.access_detail ||
         job.property?.access || job.property?.keyInfo || job.property?.accessInfo ||
         job.access || job.accessInfo || job.keyInfo || job.accessNotes || job.property?.accessNotes || '';
}
function jobTime(job) {
  return job.timeslot ||
         job.visitPlan?.time || job.visitPlan?.slot || job.visitPlan?.window ||
         job.visitTime || job.scheduledTime || job.plannedTime ||
         job.slot || job.timeSlot || job.time || '';
}
function jobNotes(job) {
  return job.notes || job.details || job.internalNotes || '';
}
function jobConfirmed(job) {
  // Returns true / false / null (unknown)
  if (job.confirmed === true  || job.isConfirmed === true)  return true;
  if (job.confirmed === false || job.isConfirmed === false) return false;
  if (job.confirmedAt) return true;
  const s = job.confirmation || job.confirmationStatus || '';
  if (s === 'confirmed') return true;
  if (s === 'unconfirmed') return false;
  return null;
}
function jobInvoice(job) {
  // Direct portal API fields
  if (job.invoice_no) return { ref: job.invoice_no, paid: !!job.invoice_paid };
  if (job.has_live_invoice) return { ref: '', paid: !!job.invoice_paid };
  // Nested object
  const inv = job.invoice;
  if (inv && typeof inv === 'object') {
    const ref  = inv.reference || inv.number || inv.id || inv.invoiceNumber || '';
    const paid = inv.paid === true || inv.paymentStatus === 'paid' || inv.status === 'paid' || inv.isPaid === true;
    return ref ? { ref, paid } : null;
  }
  if (typeof inv === 'string' && inv) return { ref: inv, paid: job.paid === true || job.isPaid === true };
  const ref = job.invoiceNumber || job.invoiceRef || job.invoiceReference || job.invoiceId || '';
  if (ref) {
    const paid = job.paid === true || job.isPaid === true || job.paymentStatus === 'paid';
    return { ref, paid };
  }
  const st = jobStatus(job);
  if (st === 'paid') return { ref: '', paid: true };
  return null;
}
function jobAgencyRef(job) {
  return job.agentRef || job.agencyRef || job.externalRef || job.landlordRef ||
         job.clientRef || job.agentReference || job.externalReference || '';
}
function jobStamps(job) {
  // Returns array of {text, cls, toggle?, confirmed?} stamp objects
  const stamps = [];
  const conf = jobConfirmed(job);
  if (conf === true)  stamps.push({ text: '✓ Confirmed',   cls: 'stamp-ok',   toggle: true, confirmed: true  });
  if (conf === false) stamps.push({ text: '⚠ Unconfirmed', cls: 'stamp-warn', toggle: true, confirmed: false });
  const inv = jobInvoice(job);
  if (inv) {
    if (inv.ref) stamps.push({ text: inv.ref,                                cls: 'stamp-inv'   });
    stamps.push({ text: inv.paid ? 'Paid' : 'Unpaid', cls: inv.paid ? 'stamp-ok' : 'stamp-unpaid' });
  } else {
    const st = jobStatus(job);
    if (!['invoiced','paid','closed'].includes(st)) stamps.push({ text: 'Not invoiced', cls: 'stamp-muted' });
  }
  const agRef = jobAgencyRef(job);
  if (agRef) stamps.push({ text: agRef, cls: 'stamp-ref' });
  // Tagged reviewer — read directly from portal data
  const reviewer = jobReviewer(job);
  if (reviewer) stamps.push({ text: `→ ${reviewer}`, cls: 'stamp-tagged' });
  return stamps;
}

function weekCard(job, iso, engId) {
  const st    = jobStatus(job);
  const color = STATUS_COLORS[st] || '#888';
  const label = STATUS_LABEL[st] || st;
  const title = jobTitle(job);
  const addr  = jobAddr(job);
  const disp  = title || addr || 'Job';
  const sub   = title && addr ? addr : '';
  const time  = jobTime(job);
  const ref   = job.job_no || job.reference || '';

  const div = document.createElement('div');
  div.className = `job-card status-${st}`;
  div.style.borderLeftColor = color;
  div.draggable = true;
  div.title = [disp, sub, label].filter(Boolean).join('\n');

  const t = disp.length>30 ? disp.slice(0,30)+'…' : disp;
  const a = sub.length>30  ? sub.slice(0,30)+'…'  : sub;

  div.innerHTML = `
    <div class="jc-title">${esc(t)}</div>
    ${a ? `<div class="jc-addr">${esc(a)}</div>` : ''}
    <div class="jc-meta">
      <span class="jbadge badge-${st}">${esc(label)}</span>
      ${time ? `<span class="jtime">${esc(time)}</span>` : ''}
      ${ref  ? `<span class="jref">${esc(String(ref).replace('JOB-','#'))}</span>` : ''}
    </div>`;

  let _dragged = false;
  div.addEventListener('dragstart', e => {
    _dragged = true;
    dragJob=job.id; dragDate2=iso; dragEng=engId||null;
    div.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', job.id);
  });
  div.addEventListener('dragend', () => { div.classList.remove('dragging'); setTimeout(()=>{ _dragged=false; }, 100); });
  div.addEventListener('click', () => { if (_dragged) return; window.open(`${BASE}/office/jobs/${job.id}`, '_blank'); });
  return div;
}

// ── DAY VIEW ──────────────────────────────────────────────────────────────────

let daySearch       = '';
let dayEngFilter    = '';
let dayFrom         = '';
let dayTo           = '';
let dayStatusFilter = '';
let _dayRowMeta     = []; // {tr, gtr, engId, searchText, status}
let _updateDayEngCells = null; // set by renderDay, called by applyDayFilter
let _dbgLogged      = false;
let _dragPoolJob    = null;  // job being dragged from unassigned panel
let _poolOpen       = true;  // panel visible
let _dayCompact     = (() => { try { return localStorage.getItem('gbDayCompact') === '1'; } catch(e) { return false; } })();

const DEFAULT_COLOR_TEMPLATES = [
  { id:'ct1', name:'Red',    bg:'#ffd5d5', text:'#7a0000' },
  { id:'ct2', name:'Orange', bg:'#ffe4c0', text:'#7a3a00' },
  { id:'ct3', name:'Yellow', bg:'#fff9c0', text:'#6b5a00' },
  { id:'ct4', name:'Green',  bg:'#d5f5e3', text:'#0a5c2e' },
  { id:'ct5', name:'Blue',   bg:'#d5eaf5', text:'#0a3d5c' },
  { id:'ct6', name:'Purple', bg:'#ead5f5', text:'#4a0a7a' },
];
function getColorTemplates() {
  try { const s = localStorage.getItem('gbColorTemplates'); return s ? JSON.parse(s) : DEFAULT_COLOR_TEMPLATES; }
  catch(e) { return DEFAULT_COLOR_TEMPLATES; }
}
function saveColorTemplates(t) { try { localStorage.setItem('gbColorTemplates', JSON.stringify(t)); } catch(e) {} }
function getRowColors() { try { return JSON.parse(localStorage.getItem('gbRowColors')||'{}'); } catch(e) { return {}; } }
function getRowColorEntry(jobId) {
  const v = getRowColors()[String(jobId)];
  if (!v) return null;
  return typeof v === 'string' ? { bg: v, text: '' } : v; // back-compat
}
function setRowColor(jobId, bg, text) {
  const c = getRowColors();
  if (bg || text) c[String(jobId)] = { bg: bg||'', text: text||'' }; else delete c[String(jobId)];
  try { localStorage.setItem('gbRowColors', JSON.stringify(c)); } catch(e) {}
}
function applyRowColor(tr, anchor, jobId, bg, text) {
  tr.querySelectorAll('td').forEach(td => {
    td.style.background = bg || '';
    td.style.color      = text || '';
  });
  tr.style.background = bg || '';
  tr.style.color      = text || '';
  anchor.style.background = bg || '';
  anchor.textContent  = bg ? '' : '🎨';
  setRowColor(jobId, bg, text);
}

function showRowColorPicker(anchor, jobId, tr) {
  document.getElementById('_rcp')?.remove();
  const saved = getRowColorEntry(jobId);
  const curBg   = saved?.bg   || '#ffffff';
  const curText = saved?.text || '#111111';
  const tpls = getColorTemplates();

  const p = document.createElement('div');
  p.id = '_rcp';
  p.style.cssText = 'position:fixed;z-index:9999;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:10px;min-width:190px;box-shadow:0 4px 20px rgba(0,0,0,.22)';
  const rect = anchor.getBoundingClientRect();
  p.style.left = Math.min(rect.left, window.innerWidth - 210) + 'px';
  p.style.top  = Math.min(rect.bottom + 4, window.innerHeight - 260) + 'px';

  p.innerHTML = `
    <div style="font-size:10px;font-weight:700;color:var(--text2);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">Row colour</div>
    <div id="_rcp_tpls" style="display:flex;flex-direction:column;gap:3px;margin-bottom:8px"></div>
    <div style="border-top:1px solid var(--border);padding-top:8px">
      <div style="font-size:10px;font-weight:700;color:var(--text2);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">Custom</div>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:5px">
        <span style="font-size:10px;width:30px;color:var(--text2)">BG</span>
        <input type="color" id="_rcp_bg" value="${curBg}" style="width:32px;height:22px;padding:1px;border-radius:3px;border:1px solid var(--border);cursor:pointer">
        <input id="_rcp_bg_hex" value="${curBg}" maxlength="7" style="width:68px;padding:2px 5px;border-radius:3px;border:1px solid var(--border);background:var(--bg1);color:var(--text);font-size:11px;font-family:monospace">
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
        <span style="font-size:10px;width:30px;color:var(--text2)">Text</span>
        <input type="color" id="_rcp_tc" value="${curText}" style="width:32px;height:22px;padding:1px;border-radius:3px;border:1px solid var(--border);cursor:pointer">
        <input id="_rcp_tc_hex" value="${curText}" maxlength="7" style="width:68px;padding:2px 5px;border-radius:3px;border:1px solid var(--border);background:var(--bg1);color:var(--text);font-size:11px;font-family:monospace">
      </div>
      <div style="display:flex;gap:5px">
        <button id="_rcp_apply" style="flex:1;padding:4px;border-radius:4px;border:none;background:var(--accent,#3b82f6);color:#fff;font-size:11px;cursor:pointer;font-weight:600">Apply</button>
        <button id="_rcp_clear" style="padding:4px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg3);font-size:11px;cursor:pointer">Clear</button>
      </div>
    </div>
  `;

  const tplsDiv = p.querySelector('#_rcp_tpls');
  tpls.forEach(t => {
    const chip = document.createElement('button');
    chip.style.cssText = `display:block;width:100%;text-align:left;padding:3px 8px;border-radius:5px;border:1px solid rgba(0,0,0,.1);cursor:pointer;background:${t.bg};color:${t.text};font-size:11px;font-weight:500`;
    chip.textContent = t.name;
    chip.addEventListener('click', e => { e.stopPropagation(); applyRowColor(tr, anchor, jobId, t.bg, t.text); p.remove(); });
    tplsDiv.appendChild(chip);
  });

  const rcpBg = p.querySelector('#_rcp_bg'), rcpBgHex = p.querySelector('#_rcp_bg_hex');
  const rcpTc = p.querySelector('#_rcp_tc'), rcpTcHex = p.querySelector('#_rcp_tc_hex');
  rcpBg.oninput = () => rcpBgHex.value = rcpBg.value;
  rcpBgHex.oninput = () => { if (/^#[0-9a-f]{6}$/i.test(rcpBgHex.value)) rcpBg.value = rcpBgHex.value; };
  rcpTc.oninput = () => rcpTcHex.value = rcpTc.value;
  rcpTcHex.oninput = () => { if (/^#[0-9a-f]{6}$/i.test(rcpTcHex.value)) rcpTc.value = rcpTcHex.value; };
  p.querySelector('#_rcp_apply').addEventListener('click', e => { e.stopPropagation(); applyRowColor(tr, anchor, jobId, rcpBg.value, rcpTc.value); p.remove(); });
  p.querySelector('#_rcp_clear').addEventListener('click', e => { e.stopPropagation(); applyRowColor(tr, anchor, jobId, '', ''); p.remove(); });

  document.body.appendChild(p);
  setTimeout(() => document.addEventListener('click', () => p.remove(), {once:true}), 0);
}

function showDescEditor(anchor, job, currentDesc) {
  document.getElementById('_desc_pop')?.remove();
  const pop = document.createElement('div');
  pop.id = '_desc_pop';
  pop.style.cssText = 'position:fixed;z-index:9999;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:12px;width:320px;box-shadow:0 4px 20px rgba(0,0,0,.22)';
  const rect = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 336)) + 'px';
  const topBelow = rect.bottom + 6;
  pop.style.top  = (topBelow + 230 > window.innerHeight ? rect.top - 236 : topBelow) + 'px';

  const lbl = document.createElement('div');
  lbl.style.cssText = 'font-size:11px;font-weight:700;color:var(--text2);margin-bottom:6px';
  lbl.textContent = 'Edit description · ' + (job.job_no || job.reference || job.id || '');

  const ta = document.createElement('textarea');
  ta.value = currentDesc;
  ta.style.cssText = 'width:100%;height:110px;padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg1);color:var(--text);font-size:12px;resize:vertical;box-sizing:border-box;font-family:inherit;display:block';

  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:10px;color:var(--text2);margin:4px 0 8px';
  hint.textContent = 'Ctrl+Enter to save · Esc to cancel';

  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:6px;justify-content:flex-end';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'padding:4px 12px;border-radius:5px;border:1px solid var(--border);background:var(--bg3);cursor:pointer;font-size:12px';
  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save';
  saveBtn.style.cssText = 'padding:4px 12px;border-radius:5px;border:none;background:var(--accent,#3b82f6);color:#fff;cursor:pointer;font-size:12px;font-weight:600';
  btns.append(cancelBtn, saveBtn);
  pop.append(lbl, ta, hint, btns);
  document.body.appendChild(pop);
  ta.focus();

  let _saving = false;
  const close = () => pop.remove();

  const save = async () => {
    if (_saving) return;
    const newVal = ta.value.trim();
    _saving = true;
    saveBtn.textContent = '…'; saveBtn.disabled = true;
    try {
      await api.updateNotes(job.id, job, newVal);
      const newDisp = newVal.length > 65 ? newVal.slice(0,65)+'…' : (newVal || '—');
      // Update cell text in-place (preserve copy button)
      const copyBtn = anchor.querySelector('.copy-btn');
      Array.from(anchor.childNodes).forEach(n => { if (n !== copyBtn) n.remove(); });
      anchor.insertBefore(document.createTextNode(newDisp), copyBtn || null);
      anchor.title = newVal + ' (click to edit)';
      clearCache();
      setStatus('Description updated · ' + now());
      pop.remove();
    } catch(ex) {
      _saving = false;
      saveBtn.textContent = 'Save'; saveBtn.disabled = false;
      setStatus('Failed: ' + (ex.message||'unknown'), false);
    }
  };

  cancelBtn.addEventListener('mousedown', e => { e.preventDefault(); close(); });
  saveBtn.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); save(); });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); save(); }
  });

  setTimeout(() => {
    document.addEventListener('mousedown', function onOut(e) {
      if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('mousedown', onOut); }
    });
  }, 0);
}

function openSettingsModal() {
  document.getElementById('_settings_modal')?.remove();
  const overlay = document.createElement('div');
  overlay.id = '_settings_modal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center';
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  const modal = document.createElement('div');
  modal.style.cssText = 'background:var(--bg1);border:1px solid var(--border);border-radius:12px;width:500px;max-width:96vw;max-height:88vh;overflow-y:auto;box-shadow:0 8px 40px rgba(0,0,0,.3)';

  function renderModal() {
    const tpls = getColorTemplates();
    modal.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--bg1);z-index:1">
        <span style="font-size:15px;font-weight:700">⚙ Settings</span>
        <button id="_sm_x" style="background:none;border:none;font-size:18px;cursor:pointer;color:var(--text);line-height:1">✕</button>
      </div>
      <div style="padding:20px">
        <div style="font-size:13px;font-weight:700;margin-bottom:4px">Row Colour Templates</div>
        <div style="font-size:11px;color:var(--text2);margin-bottom:14px">Named presets for the 🎨 row paint button. Set background and text colour for each.</div>
        <div id="_sm_list" style="display:flex;flex-direction:column;gap:6px"></div>
        <div id="_sm_form"></div>
        <button id="_sm_add" style="margin-top:12px;width:100%;padding:8px;border-radius:6px;border:1px dashed var(--border);background:none;cursor:pointer;font-size:12px;color:var(--text2)">+ Add template</button>
      </div>
    `;
    modal.querySelector('#_sm_x').onclick = () => overlay.remove();

    const list = modal.querySelector('#_sm_list');
    tpls.forEach((t, i) => {
      const row = document.createElement('div');
      row.style.cssText = `display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:7px;background:${t.bg};color:${t.text};border:1px solid rgba(0,0,0,.1)`;
      row.innerHTML = `
        <span style="flex:1;font-size:12px;font-weight:600">${esc(t.name)}</span>
        <span style="font-size:10px;opacity:.65;font-family:monospace">${t.bg} / ${t.text}</span>
        <button class="_sm_edit_btn" data-i="${i}" style="font-size:11px;padding:2px 8px;border-radius:4px;border:1px solid rgba(0,0,0,.2);background:rgba(255,255,255,.35);cursor:pointer">Edit</button>
        <button class="_sm_del_btn" data-i="${i}" style="font-size:11px;padding:2px 6px;border-radius:4px;border:1px solid rgba(0,0,0,.2);background:rgba(255,255,255,.35);cursor:pointer">✕</button>
      `;
      list.appendChild(row);
    });

    list.querySelectorAll('._sm_del_btn').forEach(b => b.onclick = () => {
      const t2 = getColorTemplates(); t2.splice(+b.dataset.i, 1); saveColorTemplates(t2); renderModal();
    });
    list.querySelectorAll('._sm_edit_btn').forEach(b => b.onclick = () => showForm(+b.dataset.i));
    modal.querySelector('#_sm_add').onclick = () => showForm(-1);
  }

  function showForm(idx) {
    const tpls = getColorTemplates();
    const t = idx >= 0 ? { ...tpls[idx] } : { id: Date.now()+'', name:'', bg:'#ffffff', text:'#111111' };
    const form = modal.querySelector('#_sm_form');
    form.innerHTML = `
      <div style="margin-top:14px;padding:14px;background:var(--bg2);border-radius:8px;border:1px solid var(--border)">
        <div style="font-size:12px;font-weight:700;margin-bottom:10px">${idx>=0?'Edit template':'New template'}</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;align-items:center;gap:8px">
            <label style="font-size:11px;width:70px;color:var(--text2)">Name</label>
            <input id="_ef_name" value="${esc(t.name)}" placeholder="e.g. Important" style="flex:1;padding:5px 8px;border-radius:5px;border:1px solid var(--border);background:var(--bg1);color:var(--text);font-size:12px">
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <label style="font-size:11px;width:70px;color:var(--text2)">Background</label>
            <input type="color" id="_ef_bg" value="${t.bg}" style="width:38px;height:28px;padding:1px;border-radius:4px;border:1px solid var(--border);cursor:pointer">
            <input id="_ef_bg_h" value="${t.bg}" maxlength="7" style="width:76px;padding:5px 8px;border-radius:5px;border:1px solid var(--border);background:var(--bg1);color:var(--text);font-size:12px;font-family:monospace">
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <label style="font-size:11px;width:70px;color:var(--text2)">Text colour</label>
            <input type="color" id="_ef_tc" value="${t.text}" style="width:38px;height:28px;padding:1px;border-radius:4px;border:1px solid var(--border);cursor:pointer">
            <input id="_ef_tc_h" value="${t.text}" maxlength="7" style="width:76px;padding:5px 8px;border-radius:5px;border:1px solid var(--border);background:var(--bg1);color:var(--text);font-size:12px;font-family:monospace">
          </div>
          <div id="_ef_prev" style="padding:7px 12px;border-radius:6px;font-size:13px;font-weight:600;background:${t.bg};color:${t.text}">Preview text</div>
        </div>
        <div style="display:flex;gap:6px;margin-top:12px;justify-content:flex-end">
          <button id="_ef_cancel" style="padding:5px 14px;border-radius:5px;border:1px solid var(--border);background:var(--bg3);cursor:pointer;font-size:12px">Cancel</button>
          <button id="_ef_save" style="padding:5px 14px;border-radius:5px;border:none;background:var(--accent,#3b82f6);color:#fff;cursor:pointer;font-size:12px;font-weight:600">Save</button>
        </div>
      </div>
    `;
    const efBg=form.querySelector('#_ef_bg'), efBgH=form.querySelector('#_ef_bg_h');
    const efTc=form.querySelector('#_ef_tc'), efTcH=form.querySelector('#_ef_tc_h');
    const efName=form.querySelector('#_ef_name'), prev=form.querySelector('#_ef_prev');
    const sync = () => { prev.style.background=efBg.value; prev.style.color=efTc.value; prev.textContent='Preview: '+(efName.value||'Name'); };
    efBg.oninput = () => { efBgH.value=efBg.value; sync(); };
    efBgH.oninput = () => { if(/^#[0-9a-f]{6}$/i.test(efBgH.value)){efBg.value=efBgH.value; sync();} };
    efTc.oninput = () => { efTcH.value=efTc.value; sync(); };
    efTcH.oninput = () => { if(/^#[0-9a-f]{6}$/i.test(efTcH.value)){efTc.value=efTcH.value; sync();} };
    efName.oninput = sync;
    form.querySelector('#_ef_cancel').onclick = () => { form.innerHTML=''; };
    form.querySelector('#_ef_save').onclick = () => {
      const t2 = getColorTemplates();
      const saved = { id:t.id, name:efName.value.trim()||'Unnamed', bg:efBg.value, text:efTc.value };
      if (idx>=0) t2[idx]=saved; else t2.push(saved);
      saveColorTemplates(t2); renderModal();
    };
  }

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  renderModal();
}

// ── Reviewer helper — reads from portal's "Tag someone" feature ───────────────
function jobReviewer(job) {
  return job.comments_check?.user_name || '';
}

async function loadDay(force=false) {
  _dbgLogged = false;
  document.getElementById('day-label').textContent = fmtDay(curDate);
  document.getElementById('day-body').innerHTML = '<div class="loading-row"><div class="spinner"></div>Loading…</div>';
  setStatus('Loading…');
  try {
    const mon   = mondayOf(curDate);
    const lanes = await getWeek(mon, force);
    buildDayFilterBar(lanes);
    renderDay(lanes, null);
    setStatus(`Loaded · ${now()}`);
  } catch(e) {
    document.getElementById('day-body').innerHTML = err(e.message);
    setStatus(e.message, false);
  }
}

async function loadDayRange(force=false) {
  document.getElementById('day-body').innerHTML = '<div class="loading-row"><div class="spinner"></div>Loading range…</div>';
  setStatus('Loading range…');
  try {
    // Collect all Mondays that overlap [dayFrom, dayTo]
    const mondays = new Set();
    let d = dayFrom;
    while (d <= dayTo) { mondays.add(mondayOf(d)); d = addDays(d, 1); }
    const allLanes = await Promise.all([...mondays].map(m => getWeek(m, force)));
    // Merge lanes by engineer id
    const merged = {};
    allLanes.forEach((lanes, wi) => {
      const mons = [...mondays][wi];
      const days = weekDays(mons);
      lanes.forEach(lane => {
        const key = lane.engineer?.id || 'unassigned';
        if (!merged[key]) merged[key] = { engineer: lane.engineer, jobs: [] };
        lane.days.forEach((dayData, di) => {
          const iso = days[di];
          if (iso >= dayFrom && iso <= dayTo) {
            (dayData.jobs||[]).forEach(job => merged[key].jobs.push({ job, date: iso }));
          }
        });
      });
    });
    renderDayRange(merged);
    setStatus(`Loaded ${dayFrom} → ${dayTo} · ${now()}`);
  } catch(e) {
    document.getElementById('day-body').innerHTML = err(e.message);
    setStatus(e.message, false);
  }
}

function buildDayFilterBar(lanes) {
  const bar = document.getElementById('day-filter-bar');
  // Collect engineers
  const engs = [{ id: '', name: 'All Engineers' }, { id: '__none__', name: 'Unassigned' }];
  lanes.forEach(lane => { if (lane.engineer) engs.push({ id: lane.engineer.id||'', name: lane.engineer.name||'?' }); });

  bar.innerHTML = `
    <div class="dfb-search">
      <input type="text" id="dfb-q" class="dfb-inp" placeholder="Search address, client, ref, description, phone…" value="${esc(daySearch)}">
    </div>
    <select id="dfb-eng" class="dfb-sel" title="Filter by engineer">
      ${engs.map(e=>`<option value="${esc(e.id)}"${dayEngFilter===e.id?' selected':''}>${esc(e.name)}</option>`).join('')}
    </select>
    <div class="dfb-dates">
      <input type="date" id="dfb-from" class="dfb-date" value="${dayFrom}" title="From date">
      <span class="dfb-sep">→</span>
      <input type="date" id="dfb-to"   class="dfb-date" value="${dayTo}"   title="To date">
      <button id="dfb-apply" class="dfb-btn dfb-btn-apply">Apply</button>
      <button id="dfb-clear" class="dfb-btn dfb-btn-clear">Clear</button>
    </div>
    <span class="dfb-count" id="dfb-count"></span>`;

  document.getElementById('dfb-q').addEventListener('input', e => { daySearch = e.target.value; applyDayFilter(); });
  document.getElementById('dfb-eng').addEventListener('change', e => { dayEngFilter = e.target.value; applyDayFilter(); });
  document.getElementById('dfb-apply').addEventListener('click', () => {
    dayFrom = document.getElementById('dfb-from').value;
    dayTo   = document.getElementById('dfb-to').value;
    if (dayFrom && dayTo && dayFrom !== dayTo) {
      loadDayRange();
    } else if (dayFrom) {
      curDate = dayFrom; dayFrom=''; dayTo=''; loadDay();
    }
  });
  document.getElementById('dfb-clear').addEventListener('click', () => {
    daySearch=''; dayEngFilter=''; dayFrom=''; dayTo=''; dayStatusFilter='';
    loadDay();
  });
  renderStatusTabs();
}

function renderStatusTabs() {
  const bar = document.getElementById('day-status-tabs');
  if (!bar) return;
  bar.innerHTML = DAY_STATUS_TABS.map(tab => {
    const id = `dst-${tab.key || 'all'}`;
    const active = dayStatusFilter === tab.key;
    const color = tab.key ? (STATUS_COLORS[tab.key] || '#6B7280') : null;
    const dot = color ? `<i style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${color};margin-right:4px;flex-shrink:0"></i>` : '';
    return `<button id="${id}" class="dst${active?' dst-active':''}" data-key="${tab.key}">
      ${dot}${esc(tab.label)}<span class="dst-badge"></span>
    </button>`;
  }).join('');
  bar.querySelectorAll('.dst').forEach(btn => {
    btn.addEventListener('click', () => {
      dayStatusFilter = btn.dataset.key;
      bar.querySelectorAll('.dst').forEach(b => b.classList.toggle('dst-active', b === btn));
      applyDayFilter();
    });
  });

  // Right-side controls
  const cBtn = document.createElement('button');
  cBtn.style.cssText = `margin-left:auto;font-size:11px;padding:3px 9px;border-radius:4px;border:1px solid var(--border);cursor:pointer;flex-shrink:0;background:${_dayCompact?'var(--red)':'var(--bg3)'};color:${_dayCompact?'#fff':'var(--text)'}`;
  cBtn.textContent = _dayCompact ? '⊞ Normal rows' : '⊟ Compact rows';
  cBtn.onclick = () => {
    _dayCompact = !_dayCompact;
    try { localStorage.setItem('gbDayCompact', _dayCompact ? '1' : '0'); } catch(e) {}
    applyDayViewStyles();
    cBtn.textContent = _dayCompact ? '⊞ Normal rows' : '⊟ Compact rows';
    cBtn.style.background = _dayCompact ? 'var(--red)' : 'var(--bg3)';
    cBtn.style.color = _dayCompact ? '#fff' : 'var(--text)';
  };
  bar.appendChild(cBtn);

  const gBtn = document.createElement('button');
  gBtn.title = 'Settings';
  gBtn.style.cssText = 'font-size:14px;padding:3px 7px;border-radius:4px;border:1px solid var(--border);cursor:pointer;flex-shrink:0;background:var(--bg3);color:var(--text)';
  gBtn.textContent = '⚙';
  gBtn.onclick = openSettingsModal;
  bar.appendChild(gBtn);
}

function applyDayFilter() {
  const q = daySearch.toLowerCase().trim();
  let visible = 0;
  // Count per-status for tab badges (ignoring the status filter itself)
  const statusCount = {};
  const gtrVisible = new Map();
  _dayRowMeta.forEach(({ tr, gtr, engId, searchText, status }) => {
    let show = true;
    if (q && !searchText.includes(q)) show = false;
    if (dayEngFilter === '__none__' && engId) show = false;
    if (dayEngFilter && dayEngFilter !== '__none__' && engId !== dayEngFilter) show = false;
    // Count for tab badges before applying status filter
    if (show) statusCount[status] = (statusCount[status] || 0) + 1;
    if (dayStatusFilter && status !== dayStatusFilter) show = false;
    tr.style.visibility = show ? '' : 'collapse';
    if (show) { visible++; if (gtr) gtrVisible.set(gtr, true); }
    else if (gtr && !gtrVisible.has(gtr)) gtrVisible.set(gtr, false);
  });
  // Show/hide group headers
  _dayRowMeta.forEach(({ gtr }) => {
    if (gtr) gtr.style.display = gtrVisible.get(gtr) ? '' : 'none';
  });
  const el = document.getElementById('dfb-count');
  if (el) el.textContent = q || dayEngFilter || dayStatusFilter ? `${visible} result${visible!==1?'s':''}` : '';
  // Update tab badge counts
  const total = Object.values(statusCount).reduce((a, b) => a + b, 0);
  DAY_STATUS_TABS.forEach(tab => {
    const btn = document.getElementById(`dst-${tab.key || 'all'}`);
    if (!btn) return;
    const cnt = tab.key === '' ? total : (statusCount[tab.key] || 0);
    const badge = btn.querySelector('.dst-badge');
    if (badge) badge.textContent = cnt > 0 ? cnt : '';
    btn.style.display = (tab.key !== '' && cnt === 0) ? 'none' : '';
  });
  if (_updateDayEngCells) _updateDayEngCells();
}

function applyDayViewStyles() {
  let s = document.getElementById('_day_compact_css');
  if (!s) { s = document.createElement('style'); s.id = '_day_compact_css'; document.head.appendChild(s); }
  s.textContent = (_dayCompact
    ? `table.day-table tbody td{height:auto!important;padding:1px 6px!important;font-size:11px!important}
       table.day-table tbody td:first-child{min-height:auto!important;padding:1px 8px!important}
       table.day-table .djob-title{display:none!important}
       table.day-table .row-stamps{margin-top:0!important}
       table.day-table .eng-dot{width:6px!important;height:6px!important}`
    : '') +
    `\ntable.day-table tbody tr.day-row-dragging{opacity:.35;outline:2px dashed var(--red);}
     table.day-table tbody tr[draggable]{cursor:grab;}
     table.day-table tbody tr[draggable]:active{cursor:grabbing;}
     table.day-table tbody tr.row-cancelled{opacity:.55;font-style:italic;}
     table.day-table tbody tr.row-cancelled td{text-decoration:line-through;text-decoration-color:rgba(107,114,128,.7);text-decoration-thickness:1.5px;}
     table.day-table tbody tr.row-cancelled td:last-child,
     table.day-table tbody tr.row-cancelled td:nth-last-child(2){text-decoration:none;}
     table.day-table tbody tr.drow-insert-before td{box-shadow:0 -3px 0 var(--red);}
     table.day-table tbody tr.drow-insert-after td{box-shadow:0 3px 0 var(--red);}
     table.day-table tbody tr.row-in-review td{background:rgba(139,92,246,.09);}
     table.day-table tbody tr.row-in-review td:first-child{border-left:3px solid #8B5CF6;}`;
}

function renderDay(lanes, dateLabel) {
  _dayRowMeta = [];
  _updateDayEngCells = null;
  const body = document.getElementById('day-body');
  body.innerHTML = '';
  const di = dateLabel ? -1 : weekDays(mondayOf(curDate)).indexOf(curDate);

  const showDate = !!dateLabel;
  const jobCols = showDate ? 12 : 11;
  let total = 0;
  const unassignedJobs = [];

  const wrap = document.createElement('div');
  wrap.className = 'day-table-wrap';
  const table = document.createElement('table');
  table.className = 'day-table';
  table.style.width = '100%';
  table.style.minWidth = '1330px';

  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>
    <th style="width:130px"></th>
    <th style="width:120px">Job / Type</th>
    ${showDate ? '<th style="width:90px">Date</th>' : ''}
    <th style="width:220px">Address</th>
    <th>Description</th>
    <th style="width:80px">Access</th>
    <th style="width:100px">Time</th>
    <th style="width:74px;text-align:right">Amount</th>
    <th style="width:110px">Client</th>
    <th style="width:130px">Phone</th>
    <th style="width:110px">Status</th>
    <th style="width:96px"></th>
  </tr>`;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  lanes.forEach(lane => {
    const dayData = di >= 0 ? (lane.days[di]||{jobs:[]}) : {jobs:[]};
    if (!dayData.jobs.length) return;
    const eng = lane.engineer;
    const engId = eng?.id || '';

    if (!eng || !engId) {
      dayData.jobs.forEach(job => unassignedJobs.push(job));
      return;
    }

    const ecolor = engColor(eng.id);

    // Group header — engineer name cell spans this row + all N job rows via rowspan
    const gtr = document.createElement('tr');
    gtr.className = 'dgroup';

    const nameTd = document.createElement('td');
    nameTd.rowSpan = dayData.jobs.length + 1;
    nameTd.style.cssText = `width:130px;padding:0;vertical-align:top;background:var(--bg2);border-left:3px solid ${ecolor}`;
    nameTd.innerHTML = `<div style="display:flex;align-items:center;gap:6px;padding:6px 10px;white-space:nowrap"><span class="eng-dot" style="background:${ecolor};flex-shrink:0"></span><span style="font-size:12px;font-weight:700;overflow:hidden;text-overflow:ellipsis">${esc(eng.name||'?')}</span></div>`;
    gtr.appendChild(nameTd);

    const sepTd = document.createElement('td');
    sepTd.colSpan = jobCols - 1;
    sepTd.style.cssText = 'height:3px;padding:0;background:var(--border)';
    gtr.appendChild(sepTd);

    nameTd.addEventListener('dragover', e => {
      if (_dragPoolJob || (dragJob && dragEng !== eng.id)) { e.preventDefault(); nameTd.style.outline = `2px dashed ${ecolor}`; }
    });
    nameTd.addEventListener('dragleave', () => nameTd.style.outline = '');
    nameTd.addEventListener('drop', async e => {
      e.preventDefault(); nameTd.style.outline = '';
      if (_dragPoolJob) {
        const job2 = _dragPoolJob; _dragPoolJob = null;
        try { setStatus('Assigning…'); await api.reschedule(job2.id, job2._date || curDate, eng.id); setStatus(`Assigned to ${eng.name} · ${now()}`); clearCache(); await loadDay(true); }
        catch(er) { setStatus(`Failed: ${er.message}`, false); }
      } else if (dragJob && dragEng !== eng.id) {
        const jid = dragJob; const fromDate = dragDate2 || curDate;
        dragJob = null; dragDate2 = null; dragEng = null;
        try { setStatus('Reassigning…'); await api.reschedule(jid, fromDate, eng.id); setStatus(`Moved to ${eng.name} ✓`); clearCache(); await loadDay(true); }
        catch(er) { setStatus(`Failed: ${er.message}`, false); }
      }
    });
    tbody.appendChild(gtr);

    dayData.jobs.forEach(job => {
      const tr = dayRow(job, eng, showDate ? (job._date || curDate) : null);
      // No first cell — nameTd rowspan covers column 1 for all job rows
      const searchText = buildSearchText(job, eng);
      _dayRowMeta.push({ tr, gtr, engId, searchText, status: jobStatus(job) });
      tbody.appendChild(tr);
      total++;
    });
  });

  table.appendChild(tbody);

  const tableArea = document.createElement('div');
  tableArea.className = 'day-table-area';
  tableArea.style.overflowX = 'auto';

  if (!total && !unassignedJobs.length) {
    tableArea.innerHTML = '<div class="loading-row"><div style="font-size:36px">📅</div>No jobs scheduled for this day</div>';
  } else if (!total) {
    tableArea.innerHTML = '<div class="loading-row" style="flex-direction:column;gap:8px"><div style="font-size:36px">📋</div><div>No assigned jobs — drag from the pool →</div></div>';
  } else {
    wrap.appendChild(table);
    tableArea.appendChild(wrap);
    applyDayViewStyles();
  }

  body.innerHTML = '';
  body.appendChild(tableArea);
  body.appendChild(buildUnassignedPanel(unassignedJobs, curDate));

  applyDayFilter();
}

function renderDayRange(merged) {
  _dayRowMeta = [];
  const body = document.getElementById('day-body');
  body.innerHTML = '';

  const fakeWrap = document.createElement('div');
  fakeWrap.className = 'day-table-wrap';
  const table = document.createElement('table');
  table.className = 'day-table';
  table.style.minWidth = '1270px';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>
    <th style="width:120px">Job / Type</th>
    <th style="width:90px">Date</th>
    <th style="width:220px">Address</th>
    <th>Description</th>
    <th style="width:80px">Access</th>
    <th style="width:100px">Time</th>
    <th style="width:74px;text-align:right">Amount</th>
    <th style="width:100px">Client</th>
    <th style="width:120px">Phone</th>
    <th style="width:110px">Status</th>
    <th style="width:96px"></th>
  </tr>`;
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  let total = 0;

  const unassignedJobs = [];

  Object.values(merged).forEach(({ engineer, jobs }) => {
    if (!jobs.length) return;
    const engId = engineer?.id || '';

    if (!engineer || !engId) {
      jobs.forEach(({ job, date }) => { job._date = date; unassignedJobs.push(job); });
      return;
    }

    const ecolor = engColor(engineer.id);

    const gtr = document.createElement('tr');
    gtr.className = 'dgroup';
    gtr.innerHTML = `<td colspan="11">
      <span style="display:inline-flex;align-items:center;gap:6px">
        <i class="deng-dot" style="background:${ecolor}"></i>
        ${esc(engineer.name||'?')}
        <span style="font-weight:400;font-size:10px;opacity:0.7">(${jobs.length} job${jobs.length!==1?'s':''})</span>
      </span>
      <span class="dgroup-drop-hint">Drop here to assign</span>
    </td>`;

    gtr.addEventListener('dragover', e => {
      if (_dragPoolJob || (dragJob && dragEng !== engineer.id)) { e.preventDefault(); gtr.classList.add('dgroup-droptarget'); }
    });
    gtr.addEventListener('dragleave', () => gtr.classList.remove('dgroup-droptarget'));
    gtr.addEventListener('drop', async e => {
      e.preventDefault();
      gtr.classList.remove('dgroup-droptarget');
      if (_dragPoolJob) {
        const job = _dragPoolJob; _dragPoolJob = null;
        try {
          setStatus('Assigning…');
          await api.reschedule(job.id, job._date || curDate, engineer.id);
          setStatus(`Assigned to ${engineer.name} · ${now()}`);
          clearCache();
          await loadDayRange(true);
        } catch(er) { setStatus(`Failed: ${er.message}`, false); }
      } else if (dragJob && dragEng !== engineer.id) {
        const jid = dragJob; const fromDate = dragDate2 || curDate;
        dragJob = null; dragDate2 = null; dragEng = null;
        try {
          setStatus('Reassigning…');
          await api.reschedule(jid, fromDate, engineer.id);
          setStatus(`Moved to ${engineer.name} ✓`);
          clearCache();
          await loadDayRange(true);
        } catch(er) { setStatus(`Failed: ${er.message}`, false); }
      }
    });

    tbody.appendChild(gtr);

    jobs.forEach(({ job, date }) => {
      job._date = date;
      const tr = dayRow(job, engineer, date);
      _dayRowMeta.push({ tr, gtr, engId, searchText: buildSearchText(job, engineer), status: jobStatus(job) });
      tbody.appendChild(tr);
      total++;
    });
  });

  const tableArea = document.createElement('div');
  tableArea.className = 'day-table-area';
  tableArea.style.overflowX = 'auto';

  if (!total && !unassignedJobs.length) {
    tableArea.innerHTML = '<div class="loading-row"><div style="font-size:36px">📅</div>No jobs in this date range</div>';
  } else if (!total) {
    tableArea.innerHTML = '<div class="loading-row" style="flex-direction:column;gap:8px"><div style="font-size:36px">📋</div><div>No assigned jobs — drag from the pool →</div></div>';
  } else {
    table.appendChild(tbody);
    fakeWrap.appendChild(table);
    tableArea.appendChild(fakeWrap);
    applyDayViewStyles();
  }

  body.innerHTML = '';
  body.appendChild(tableArea);
  body.appendChild(buildUnassignedPanel(unassignedJobs, curDate));
  applyDayFilter();
}

function buildUnassignedPanel(jobs, targetDate) {
  const panel = document.createElement('div');
  panel.className = 'day-upool' + (_poolOpen ? '' : ' day-upool-closed');
  panel.id = 'day-upool';

  const hdr = document.createElement('div');
  hdr.className = 'day-upool-hdr';
  hdr.innerHTML = `
    <span class="day-upool-title-txt">Unassigned</span>
    <span class="day-upool-cnt" id="day-upool-cnt">${jobs.length}</span>
    <button class="day-upool-toggle" id="day-upool-toggle" title="Toggle panel">${_poolOpen ? '›' : '‹'}</button>`;
  hdr.querySelector('#day-upool-toggle').addEventListener('click', () => {
    _poolOpen = !_poolOpen;
    panel.classList.toggle('day-upool-closed', !_poolOpen);
    hdr.querySelector('#day-upool-toggle').textContent = _poolOpen ? '›' : '‹';
  });
  panel.appendChild(hdr);

  const list = document.createElement('div');
  list.className = 'day-upool-list';

  if (!jobs.length) {
    const empty = document.createElement('div');
    empty.className = 'day-upool-empty';
    empty.textContent = 'All jobs assigned ✓';
    list.appendChild(empty);
  } else {
    jobs.forEach(job => {
      const card = document.createElement('div');
      card.className = 'day-upool-card';
      card.draggable = true;
      const addr    = jobAddr(job)     || '';
      const title   = jobTitle(job)    || '—';
      const cust    = jobCustomer(job) || '';
      const phone   = jobPhone(job)    || '';
      const st      = jobStatus(job);
      const stColor = STATUS_COLORS[st] || '#888';
      const stLabel = STATUS_LABEL[st]  || st;
      card.innerHTML = `
        <div class="day-upool-card-title">${esc(title)}</div>
        ${addr  ? `<div class="day-upool-card-addr">📍 ${esc(addr)}</div>` : ''}
        ${cust  ? `<div class="day-upool-card-meta">${esc(cust)}</div>` : ''}
        ${phone ? `<a class="day-upool-card-meta day-tel-link" href="tel:${esc(phone.replace(/\s/g,''))}">${esc(phone)}</a>` : ''}
        <span class="day-upool-card-status" style="color:${stColor}">${esc(stLabel)}</span>
        <div class="day-upool-card-drag">⣿ drag to assign</div>`;

      card.addEventListener('dragstart', e => {
        job._date = targetDate;
        _dragPoolJob = job;
        e.dataTransfer.setData('text/plain', job.id);
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('day-upool-card-dragging');
      });
      card.addEventListener('dragend', () => {
        _dragPoolJob = null;
        card.classList.remove('day-upool-card-dragging');
      });
      list.appendChild(card);
    });
  }

  panel.appendChild(list);
  return panel;
}

function buildSearchText(job, engineer) {
  const inv = jobInvoice(job);
  return [
    job.id, job.reference,
    jobTitle(job), jobAddr(job), jobNotes(job),
    jobCustomer(job), jobPhone(job), jobAccess(job), jobTime(job),
    job.jobType, job.type, job.category,
    engineer?.name,
    job.property?.postcode, job.property?.address?.postcode,
    job.email, job.customer?.email, job.property?.email,
    job.amount, job.price,
    jobStatus(job),
    inv?.ref,
    inv?.paid ? 'paid' : 'unpaid',
    jobConfirmed(job) === true ? 'confirmed' : jobConfirmed(job) === false ? 'unconfirmed' : '',
    jobAgencyRef(job),
  ].filter(Boolean).join(' ').toLowerCase();
}

function makeCopyCell(td, fullText) {
  td.classList.add('copy-cell');
  const btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.title = 'Copy';
  btn.textContent = '⎘';
  btn.addEventListener('click', e => {
    e.stopPropagation();
    navigator.clipboard.writeText(fullText).catch(()=>{}).then(()=>{
      btn.textContent = '✓'; btn.classList.add('copied');
      setTimeout(()=>{ btn.textContent='⎘'; btn.classList.remove('copied'); }, 1500);
    });
  });
  td.appendChild(btn);
}

// colspan count for group headers (changes when date column present)
function _dayColspan(hasDate) { return hasDate ? 13 : 12; }

function dayRow(job, engineer, dateISO) {
  if (!_dbgLogged) { _dbgLogged = true; console.log('GB Diary — raw job:', JSON.parse(JSON.stringify(job))); }

  const st    = jobStatus(job);
  const color = STATUS_COLORS[st] || '#888';
  const label = STATUS_LABEL[st] || st;

  const title  = jobTitle(job);
  const addr   = jobAddr(job);
  const cust   = jobCustomer(job);
  const phone  = jobPhone(job);
  const notes  = jobNotes(job);
  const time   = jobTime(job);
  const access = jobAccess(job);
  const stamps = jobStamps(job);
  const ref    = job.job_no || job.reference || '';
  const jtype  = job.jobType || job.job_type || job.type || job.category || job.jobCategory || '';
  const rawAmount = job.price ?? job.amount ?? job.value ?? job.total ?? null;
  const amount = rawAmount != null ? `£${Number(rawAmount).toFixed(2)}` : '—';
  const engName = engineer?.name || 'Unassigned';
  const eColor  = engColor(engineer?.id || null);
  const desc    = title || notes || '—';

  const typeMap = { Certificate:'dtype-cert', Repair:'dtype-repair', Urgent:'dtype-urgent', Emergency:'dtype-emerg' };
  const rowMap  = { Certificate:'drow-cert',  Repair:'drow-repair',  Urgent:'drow-urgent',  Emergency:'drow-emergency' };
  const tClass  = typeMap[jtype] || 'dtype-norm';
  const rClass  = rowMap[jtype]  || '';
  const refShort = String(ref).replace('JOB-','#') || '—';
  const descDisp = desc.length > 65 ? desc.slice(0,65)+'…' : desc;
  const addrDisp = addr.length > 32 ? addr.slice(0,32)+'…' : addr;

  // Invoice stamps inline (always visible, including compact mode)
  const invStampsHtml = stamps
    .filter(s => !s.toggle)
    .map(s => `<span class="row-stamp ${s.cls}">${esc(s.text)}</span>`)
    .join('');
  // Toggle stamps (Confirmed/Unconfirmed) go below — hidden in compact
  const toggleStampsHtml = stamps
    .filter(s => s.toggle)
    .map(s => `<span class="row-stamp ${s.cls} stamp-toggle" data-confirmed="${s.confirmed}" title="Click to ${s.confirmed?'unconfirm':'confirm'}">${esc(s.text)}</span>`)
    .join('');

  const tr = document.createElement('tr');
  const _isReview = st === 'engineer_completed' || st === 'in_review';
  tr.className = [rClass, st === 'cancelled' ? 'row-cancelled' : '', _isReview ? 'row-in-review' : ''].filter(Boolean).join(' ');

  const cells = [];

  // Job / Type + inline invoice stamps + title
  const titleDisp = title.length > 24 ? title.slice(0,24)+'…' : title;
  cells.push(`<td>
    <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap">
      <span class="djob-ref">${esc(refShort)}</span>
      ${jtype?`<span class="dtype-pill ${tClass}">${esc(jtype.slice(0,4).toUpperCase())}</span>`:''}
      ${invStampsHtml}
    </div>
    ${titleDisp ? `<div class="djob-title">${esc(titleDisp)}</div>` : ''}
    ${toggleStampsHtml ? `<div class="row-stamps">${toggleStampsHtml}</div>` : ''}
  </td>`);

  // Date (range mode)
  if (dateISO) cells.push(`<td style="font-size:11px;color:var(--text2);white-space:nowrap">${esc(dateISO)}</td>`);

  // Address
  cells.push(`<td class="addr-td" title="${esc(addr)}">${esc(addrDisp||'—')}</td>`);

  // Description — click to edit
  cells.push(`<td class="desc-td" title="${esc(desc)} (click to edit)" style="cursor:pointer">${esc(descDisp)}<span class="desc-edit-icon" style="opacity:0;margin-left:4px;font-size:10px;transition:opacity .15s">✎</span></td>`);

  // Access
  cells.push(`<td title="${esc(access)}">${esc((access||'—').length>14?(access||'—').slice(0,14)+'…':(access||'—'))}</td>`);

  // Time
  cells.push(`<td style="font-weight:600">${esc(time||'—')}</td>`);

  // Amount — click to edit inline
  cells.push(`<td class="amt-td" data-raw="${rawAmount ?? ''}" title="Click to edit amount" style="text-align:right;font-variant-numeric:tabular-nums;font-weight:600;cursor:pointer;position:relative">
    <span class="amt-val">${esc(amount)}</span><span class="amt-edit-icon">✎</span>
  </td>`);

  // Client
  cells.push(`<td class="cust-td" title="${esc(cust)}">${esc(cust.length>18?cust.slice(0,18)+'…':cust||'—')}</td>`);

  // Phone
  cells.push(`<td>${phone?`<a href="tel:${esc(phone)}" class="day-tel-link" onclick="event.stopPropagation()">📞 ${esc(phone)}</a>`:'—'}</td>`);

  // Status + invoice ref
  const inv = jobInvoice(job);
  const invLine = inv ? `<div style="font-size:9px;color:var(--text3);margin-top:2px">${inv.ref ? esc(inv.ref) : '📄 Invoice'}</div>` : '';
  cells.push(`<td><span class="jbadge badge-${st}" style="border-left:3px solid ${color}">${esc(label)}</span>${invLine}</td>`);

  // Action — portal + WhatsApp quick-dial + row colour picker
  const _waRaw = (phone||'').replace(/\D/g,'').replace(/^0/,'44');
  const _waCell = _waRaw
    ? `<button class="day-wa-btn" data-wa="https://wa.me/${_waRaw}" title="WhatsApp ${esc(phone)}">💬</button>`
    : '';
  const _rowEntry = getRowColorEntry(String(job.id));
  const _rowBg = _rowEntry?.bg || '';
  cells.push(`<td><div class="day-act-wrap"><button class="day-act-btn" title="Open in portal">↗</button>${_waCell}<button class="day-paint-btn" title="Highlight row colour" style="background:${_rowBg||''};border:1px solid var(--border);width:18px;height:18px;border-radius:3px;cursor:pointer;font-size:10px;padding:0;flex-shrink:0">${_rowBg?'':'🎨'}</button></div></td>`);

  tr.innerHTML = cells.join('');
  if (_rowBg) { tr.style.background = _rowBg; tr.querySelectorAll('td').forEach(td => { td.style.background = _rowBg; if (_rowEntry?.text) td.style.color = _rowEntry.text; }); }
  if (_rowEntry?.text) tr.style.color = _rowEntry.text;

  // Paint button listener
  const paintBtn = tr.querySelector('.day-paint-btn');
  if (paintBtn) paintBtn.addEventListener('click', e => { e.stopPropagation(); showRowColorPicker(paintBtn, job.id, tr); });

  makeCopyCell(tr.querySelector('.addr-td'), addr || '—');
  makeCopyCell(tr.querySelector('.cust-td'), cust || '—');

  // Description — click to open floating editor
  const descTd = tr.querySelector('.desc-td');
  if (descTd) {
    descTd.addEventListener('mouseenter', () => { const ic = descTd.querySelector('.desc-edit-icon'); if(ic) ic.style.opacity='0.5'; });
    descTd.addEventListener('mouseleave', () => { const ic = descTd.querySelector('.desc-edit-icon'); if(ic) ic.style.opacity='0'; });
    descTd.addEventListener('click', e => {
      if (e.target.classList.contains('copy-btn')) return;
      e.stopPropagation();
      showDescEditor(descTd, job, desc === '—' ? '' : desc);
    });
  }

  // Inline amount editor
  const amtTd = tr.querySelector('.amt-td');
  if (amtTd) {
    amtTd.addEventListener('click', e => {
      e.stopPropagation();
      if (amtTd.querySelector('.amt-inp')) return; // already editing

      const current = amtTd.dataset.raw !== '' ? Number(amtTd.dataset.raw) : '';
      // Keep scroll position — replacing innerHTML of a focused element scrolls the page
      const scrollEl = document.querySelector('.day-table-area');
      const scrollY  = scrollEl?.scrollTop ?? 0;

      amtTd.innerHTML = `
        <div class="amt-edit-wrap">
          <span class="amt-prefix">£</span>
          <input type="number" class="amt-inp" value="${current}" min="0" step="0.01" placeholder="0.00">
          <button class="amt-save-btn" title="Save (Enter)">✓</button>
          <button class="amt-cancel-btn" title="Cancel (Esc)">✕</button>
        </div>`;

      if (scrollEl) scrollEl.scrollTop = scrollY;

      const inp     = amtTd.querySelector('.amt-inp');
      let   _saving = false;

      inp.focus(); inp.select();

      const restore = () => {
        const sc = document.querySelector('.day-table-area');
        const sy = sc?.scrollTop ?? 0;
        amtTd.innerHTML = `<span class="amt-val">${esc(amount)}</span><span class="amt-edit-icon">✎</span>`;
        if (sc) sc.scrollTop = sy;
      };

      const save = async () => {
        if (_saving) return;
        const val = parseFloat(inp.value);
        if (isNaN(val) || val < 0) { restore(); return; }
        _saving = true;
        const savBtn = amtTd.querySelector('.amt-save-btn');
        if (savBtn) { savBtn.textContent = '…'; savBtn.disabled = true; }
        try {
          await api.updateAmount(job.id, val);
          const newDisp = `£${val.toFixed(2)}`;
          amtTd.dataset.raw = String(val);
          const sc2 = document.querySelector('.day-table-area');
          const sy2 = sc2?.scrollTop ?? 0;
          amtTd.innerHTML = `<span class="amt-val">${newDisp}</span><span class="amt-edit-icon">✎</span>`;
          if (sc2) sc2.scrollTop = sy2;
          clearCache();
          setStatus(`Amount updated to ${newDisp} · ${now()}`);
        } catch(ex) {
          _saving = false;
          restore();
          setStatus('Failed: ' + (ex.message || 'unknown'), false);
        }
      };

      inp.addEventListener('keydown', e2 => {
        e2.stopPropagation();
        if (e2.key === 'Enter')  { e2.preventDefault(); save(); }
        if (e2.key === 'Escape') { e2.preventDefault(); restore(); }
      });

      // mousedown + preventDefault keeps input focused so blur never fires when clicking buttons
      amtTd.querySelector('.amt-save-btn').addEventListener('mousedown', e2 => {
        e2.preventDefault(); e2.stopPropagation(); save();
      });
      amtTd.querySelector('.amt-cancel-btn').addEventListener('mousedown', e2 => {
        e2.preventDefault(); e2.stopPropagation(); restore();
      });

      // Blur: cancel only if focus truly left the cell and we're not mid-save
      inp.addEventListener('blur', () => {
        setTimeout(() => { if (!_saving && !amtTd.contains(document.activeElement)) restore(); }, 150);
      });
    });
  }

  // Confirm / Unconfirm toggle
  tr.querySelectorAll('.stamp-toggle').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation();
      const curConf  = el.dataset.confirmed === 'true';
      const nextConf = !curConf;
      const prev = el.textContent;
      el.textContent = '…'; el.style.opacity = '0.55'; el.style.pointerEvents = 'none';
      try {
        await api.setConfirmed(job.id, nextConf);
        el.textContent = nextConf ? '✓ Confirmed' : '⚠ Unconfirmed';
        el.className   = `row-stamp ${nextConf ? 'stamp-ok' : 'stamp-warn'} stamp-toggle`;
        el.dataset.confirmed = String(nextConf);
        el.title = `Click to ${nextConf ? 'unconfirm' : 'confirm'}`;
        clearCache();
        setStatus(nextConf ? 'Confirmed ✓' : 'Unconfirmed');
      } catch(ex) {
        el.textContent = prev;
        el.style.opacity = '1';
        setStatus('Failed: ' + (ex.message||'unknown'), false);
      }
      el.style.opacity = '1'; el.style.pointerEvents = '';
    });
  });

  tr.querySelector('.day-act-btn').addEventListener('click', e => {
    e.stopPropagation();
    window.open(`${BASE}/office/jobs/${job.id}`, '_blank');
  });
  const _dayWaBtn = tr.querySelector('.day-wa-btn');
  if (_dayWaBtn) {
    _dayWaBtn.addEventListener('click', e => {
      e.stopPropagation();
      window.open(_dayWaBtn.dataset.wa, '_blank');
    });
  }
  tr.dataset.jobId = String(job.id);
  tr.dataset.engId = String(engineer?.id || '');

  let _trDragged = false;
  tr.draggable = true;
  tr.addEventListener('dragstart', e => {
    _trDragged = true;
    dragJob   = job.id;
    dragDate2 = dateISO || curDate;
    dragEng   = engineer?.id || null;
    tr.classList.add('day-row-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(job.id));
  });
  tr.addEventListener('dragend', () => {
    tr.classList.remove('day-row-dragging');
    // clean up any lingering drop indicators
    tr.closest('tbody')?.querySelectorAll('.drow-insert-before,.drow-insert-after').forEach(r => {
      r.classList.remove('drow-insert-before','drow-insert-after');
    });
    dragJob = null; dragDate2 = null; dragEng = null;
    setTimeout(() => { _trDragged = false; }, 100);
  });

  // Row drag-and-drop: within-engineer reorder, cross-engineer reassign, pool assign
  tr.addEventListener('dragover', e => {
    const sameEng  = dragJob && String(dragEng) === String(engineer?.id || '') && dragJob !== String(job.id);
    const crossEng = dragJob && String(dragEng) !== String(engineer?.id || '');
    const fromPool = !!_dragPoolJob;
    if (!sameEng && !crossEng && !fromPool) return;
    e.preventDefault(); e.stopPropagation();
    const rect = tr.getBoundingClientRect();
    const insertBefore = e.clientY < rect.top + rect.height / 2;
    tr.classList.toggle('drow-insert-before', insertBefore);
    tr.classList.toggle('drow-insert-after',  !insertBefore);
  });
  tr.addEventListener('dragleave', () => {
    tr.classList.remove('drow-insert-before', 'drow-insert-after');
  });
  tr.addEventListener('drop', async e => {
    const sameEng  = dragJob && String(dragEng) === String(engineer?.id || '') && dragJob !== String(job.id);
    const crossEng = dragJob && String(dragEng) !== String(engineer?.id || '');
    const fromPool = !!_dragPoolJob;
    if (!sameEng && !crossEng && !fromPool) return;
    e.preventDefault(); e.stopPropagation();
    const insertBefore = tr.classList.contains('drow-insert-before');
    tr.classList.remove('drow-insert-before', 'drow-insert-after');

    if (sameEng) {
      // Within-engineer reorder
      const tbody = tr.closest('tbody');
      const draggedRow = tbody?.querySelector(`tr[data-job-id="${CSS.escape(String(dragJob))}"]`);
      if (draggedRow && draggedRow !== tr) {
        if (insertBefore) tbody.insertBefore(draggedRow, tr);
        else              tr.after(draggedRow);
      }
      const engId = String(engineer?.id || '');
      const orderedRows = [...tbody.querySelectorAll(`tr[data-eng-id="${CSS.escape(engId)}"]`)];
      orderedRows.forEach((r, i) => {
        trpcMutate('jobs.update', { id: r.dataset.jobId, sortOrder: i }).catch(() => {});
      });
      setStatus('Order saved ✓');
    } else if (crossEng) {
      // Cross-engineer reassign
      const jid = dragJob; const fromDate = dragDate2 || curDate;
      dragJob = null; dragDate2 = null; dragEng = null;
      try {
        setStatus('Reassigning…');
        await api.reschedule(jid, fromDate, engineer?.id);
        setStatus(`Moved to ${engineer?.name || 'engineer'} ✓`);
        clearCache();
        if (dayFrom && dayTo && dayFrom !== dayTo) await loadDayRange(true); else await loadDay(true);
      } catch(er) { setStatus(`Failed: ${er.message}`, false); }
    } else if (fromPool) {
      // Pool (unassigned) → engineer row
      const poolJob = _dragPoolJob; _dragPoolJob = null;
      try {
        setStatus('Assigning…');
        await api.reschedule(poolJob.id, poolJob._date || curDate, engineer?.id);
        setStatus(`Assigned to ${engineer?.name || 'engineer'} ✓`);
        clearCache();
        if (dayFrom && dayTo && dayFrom !== dayTo) await loadDayRange(true); else await loadDay(true);
      } catch(er) { setStatus(`Failed: ${er.message}`, false); }
    }
  });

  tr.addEventListener('click', () => { if (_trDragged) return; openJobDetail(job.id); });
  return tr;
}

// ── JOB DETAIL MODAL ─────────────────────────────────────────────────────────

function openJobDetail(jobId) {
  const overlay = document.getElementById('jd-overlay');
  const modal   = document.getElementById('jd-modal');
  overlay.classList.add('jd-open');
  modal.innerHTML = '<div class="jd-spinner"><div class="spinner"></div>Loading job…</div>';
  overlay.onclick = e => { if (e.target === overlay) closeJobDetail(); };
  document.addEventListener('keydown', _jdEscClose);
  api.getJob(jobId).then(data => {
    modal.innerHTML = '';
    modal.appendChild(buildJobDetail(data, jobId));
  }).catch(e => {
    modal.innerHTML = `<div class="jd-spinner">⚠ ${esc(e.message)}</div>`;
  });
}

function closeJobDetail() {
  document.getElementById('jd-overlay').classList.remove('jd-open');
  document.removeEventListener('keydown', _jdEscClose);
}

function _jdEscClose(e) { if (e.key === 'Escape') closeJobDetail(); }

async function _jdSetStatus(jobId, statusKey, label, extra = {}) {
  const modal = document.getElementById('jd-modal');
  modal.innerHTML = '<div class="jd-spinner"><div class="spinner"></div>Updating…</div>';
  try {
    await api.setStatus(jobId, statusKey, extra);
    clearCache();
    setStatus(`Status → ${label} · ${now()}`);
    const data = await api.getJob(jobId);
    modal.innerHTML = '';
    modal.appendChild(buildJobDetail(data, jobId));
  } catch(e) {
    setStatus('Failed: ' + e.message, false);
    const data = await api.getJob(jobId).catch(()=>null);
    if (data) { modal.innerHTML = ''; modal.appendChild(buildJobDetail(data, jobId)); }
    else modal.innerHTML = `<div class="jd-spinner">⚠ ${esc(e.message)}</div>`;
  }
}

async function _addJobNote(jobId, message) {
  const attempts = [
    () => trpcMutate('jobs.addNote',    { jobId, message }),
    () => trpcMutate('jobs.addEvent',   { jobId, message, event_type: 'note' }),
    () => trpcMutate('jobs.createNote', { jobId, message }),
    () => trpcMutate('events.create',   { jobId, message, type: 'note' }),
  ];
  for (const fn of attempts) {
    try { return await fn(); } catch(e) {
      if (e.message?.includes('404') || e.message?.includes('No procedure') || e.message?.includes('not found')) continue;
      throw e;
    }
  }
  throw new Error('Note endpoint not found — open portal F12 to discover exact endpoint name');
}

function _jdBuildActions(actDiv, job, jobId) {
  actDiv.innerHTML = '';
  const st = jobStatus(job);
  const STATUS_BTNS = [
    { key: 'in_progress',        label: '▶ In Progress',       cls: 'jd-btn-primary', show: ['pending','quotation','waiting_certificate'] },
    { key: 'cannot_access',      label: '🚫 Cannot Access',     cls: 'jd-btn-danger',  show: ['pending','in_progress'], reason: true },
    { key: 'failed',             label: '✗ Failed',             cls: 'jd-btn-danger',  show: ['pending','in_progress','engineer_completed'], reason: true },
    { key: 'engineer_completed', label: '👁 Send for Review',   cls: 'jd-btn-primary', show: ['in_progress'] },
    { key: 'completed',          label: '✓ Review & Complete',  cls: 'jd-btn-success', show: ['engineer_completed'], extra: { reviewDone: true } },
    { key: 'invoiced',           label: '🧾 Mark as Invoiced',  cls: 'jd-btn-success', show: ['completed'] },
    { key: 'pending',            label: '↩ Reopen',             cls: '',               show: ['failed','cancelled','cannot_access'] },
  ];
  STATUS_BTNS.forEach(b => {
    if (!b.show.includes(st)) return;
    const btn = document.createElement('button');
    btn.className = `jd-btn ${b.cls}`;
    btn.textContent = b.label;
    if (b.reason) {
      btn.addEventListener('click', () => _jdShowReason(actDiv, job, jobId, b));
    } else {
      btn.addEventListener('click', () => {
        btn.disabled = true; btn.textContent = '…';
        _jdSetStatus(jobId, b.key, b.label, b.extra || {});
      });
    }
    actDiv.appendChild(btn);
  });
  // Quotation job toggle
  const qToggle = document.createElement('button');
  qToggle.className = 'jd-btn';
  qToggle.title = job.quotation ? 'Remove quotation flag from this job' : 'Mark this job as a quotation job';
  qToggle.textContent = job.quotation ? '💼 Unmark Quotation' : '💼 Mark Quotation Job';
  qToggle.addEventListener('click', async () => {
    qToggle.disabled = true; qToggle.textContent = '…';
    try {
      await trpcMutate('jobs.update', { id: jobId, quotation: !job.quotation });
      clearCache();
      const modal = document.getElementById('jd-modal');
      modal.innerHTML = '<div class="jd-spinner"><div class="spinner"></div>Refreshing…</div>';
      const nd = await api.getJob(jobId);
      modal.innerHTML = ''; modal.appendChild(buildJobDetail(nd, jobId));
    } catch(e) { qToggle.disabled=false; qToggle.textContent=job.quotation?'💼 Unmark Quotation':'💼 Mark Quotation Job'; setStatus('Failed: '+e.message,false); }
  });
  actDiv.appendChild(qToggle);
  // Open 3-panel quotation builder
  const qbBtn = document.createElement('button');
  qbBtn.className = 'jd-btn jd-btn-primary';
  qbBtn.textContent = '📋 Build Quotation';
  qbBtn.addEventListener('click', () => { closeJobDetail(); openQuotationBuilder(jobId); });
  actDiv.appendChild(qbBtn);
}

function _jdShowReason(actDiv, job, jobId, btnDef) {
  actDiv.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;width:100%;max-width:520px';
  const lbl = document.createElement('div');
  lbl.style.cssText = 'font-size:12px;color:var(--text2);font-weight:600';
  lbl.textContent = 'Reason (required — goes on the job timeline):';
  const ta = document.createElement('textarea');
  ta.style.cssText = 'width:100%;min-height:64px;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg3);color:var(--text);font-size:12px;resize:vertical;font-family:inherit';
  ta.placeholder = 'e.g. No one was home when engineer attended';
  const err = document.createElement('div');
  err.style.cssText = 'color:#ef4444;font-size:11px;min-height:14px';
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px';
  const confirmBtn = document.createElement('button');
  confirmBtn.className = `jd-btn ${btnDef.cls}`;
  confirmBtn.textContent = btnDef.label;
  confirmBtn.addEventListener('click', () => {
    const reason = ta.value.trim();
    if (!reason) { err.textContent = 'A reason is required.'; return; }
    confirmBtn.disabled = true; confirmBtn.textContent = '…';
    _jdSetStatus(jobId, btnDef.key, btnDef.label, { reason });
  });
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'jd-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => _jdBuildActions(actDiv, job, jobId));
  row.appendChild(confirmBtn); row.appendChild(cancelBtn);
  wrap.appendChild(lbl); wrap.appendChild(ta); wrap.appendChild(err); wrap.appendChild(row);
  actDiv.appendChild(wrap);
  ta.focus();
}

function buildJobDetail(data, jobId) {
  const job      = data.job   || {};
  const events   = (data.events || []).slice().reverse();
  const photos   = (data.attachments || []).filter(a => a.kind?.startsWith('photo') || a.kind === 'signature');
  const billing  = data.billing || {};
  const cc       = data.comments_check;
  const st       = jobStatus(job);
  const stColor  = STATUS_COLORS[st] || '#888';
  const stLabel  = STATUS_LABEL[st] || st;

  const frag = document.createDocumentFragment();

  // ── Header ──────────────────────────────────────────────────────────────────
  const hdr = document.createElement('div');
  hdr.className = 'jd-hdr';
  hdr.innerHTML = `
    <div class="jd-hdr-left">
      <span class="jd-ref">${esc(job.job_no || '')}</span>
      <h2>${esc(job.title || job.description || 'Job')}</h2>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px">
        <span class="jbadge badge-${st}" style="border-left:3px solid ${stColor}">${esc(stLabel)}</span>
        ${cc?.user_name ? `<span class="row-stamp stamp-tagged">→ ${esc(cc.user_name)} (review)</span>` : ''}
        ${job.confirmed ? `<span class="row-stamp stamp-ok">✓ Confirmed</span>` : `<span class="row-stamp stamp-warn">⚠ Unconfirmed</span>`}
        ${job.quotation ? `<span class="row-stamp stamp-inv">💼 Quotation</span>` : ''}
      </div>
    </div>
    <div class="jd-hdr-btns">
      <a href="${BASE}/office/jobs/${esc(jobId)}" target="_blank" class="jd-btn" style="text-decoration:none">↗ Portal</a>
      <button id="jd-close" title="Close (Esc)">✕</button>
    </div>`;
  hdr.querySelector('#jd-close').addEventListener('click', closeJobDetail);
  frag.appendChild(hdr);

  // ── Body ────────────────────────────────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'jd-body';

  // Info grid
  const addr   = jobAddr(job);
  const cust   = jobCustomer(job);
  const phone  = jobPhone(job);
  const time   = jobTime(job);
  const access = jobAccess(job);
  const engList = (job.engineers||[]).length
    ? [...new Map((job.engineers||[]).map(e=>[e.id,e.name])).values()]
    : [job.engineer?.name].filter(Boolean);
  const eng = engList.join(', ') || 'Unassigned';
  const price  = job.price ? `£${Number(job.price).toFixed(2)}` : '—';
  const scheduled = job.scheduled_date ? `${job.scheduled_date}${time ? ' · '+time : ''}` : (time || '—');

  const grid = document.createElement('div');
  grid.className = 'jd-info-grid';
  const infoRows = [
    { l: 'Address',   v: addr  || '—' },
    { l: 'Client',    v: cust  || '—' },
    { l: 'Phone',     v: phone || '—',  href: phone ? `tel:${phone.replace(/\s/g,'')}` : null },
    { l: 'Date/Time', v: scheduled },
    { l: 'Engineer',  v: eng },
    { l: 'Amount',    v: price },
    access   ? { l: 'Access',   v: access }  : null,
    job.notes? { l: 'Notes',    v: job.notes }: null,
    billing.quoted   != null ? { l: 'Quoted',    v: `£${Number(billing.quoted  ).toFixed(2)}` } : null,
    billing.invoiced != null ? { l: 'Invoiced',  v: `£${Number(billing.invoiced).toFixed(2)}` } : null,
    billing.remaining!= null && billing.remaining!==billing.quoted
      ? { l: 'Remaining', v: `£${Number(billing.remaining).toFixed(2)}` } : null,
  ].filter(Boolean);
  grid.innerHTML = infoRows.map(i => `
    <div class="jd-info-item">
      <span class="jd-info-label">${esc(i.l)}</span>
      ${i.href
        ? `<a href="${esc(i.href)}" class="jd-info-val day-tel-link">${esc(i.v)}</a>`
        : `<span class="jd-info-val">${esc(i.v)}</span>`}
    </div>`).join('');
  body.appendChild(grid);

  // Action buttons
  const actDiv = document.createElement('div');
  actDiv.className = 'jd-actions';
  _jdBuildActions(actDiv, job, jobId);
  body.appendChild(actDiv);

  // Photos
  if (photos.length) {
    const sec = document.createElement('div');
    sec.innerHTML = `<div class="jd-section-title">Photos & Files (${photos.length})</div>`;
    const pg = document.createElement('div');
    pg.className = 'jd-photos-grid';
    photos.forEach(a => {
      const item = document.createElement('div');
      item.className = 'jd-photo';
      const kindLabel = { photo_before:'Before', photo_after:'After', signature:'Signature' }[a.kind] || a.kind || '';
      const fullUrl = BASE + a.url;
      if (a.meta?.mime?.startsWith('image/') || a.kind === 'signature') {
        item.innerHTML = `<img src="${esc(fullUrl)}" alt="${esc(kindLabel)}" loading="lazy">
          <div class="jd-photo-label">${esc(kindLabel)}${a.uploaded_by_name?' · '+esc(a.uploaded_by_name):''}</div>`;
        item.querySelector('img').addEventListener('click', () => window.open(fullUrl, '_blank'));
      } else {
        item.innerHTML = `<div style="padding:14px;font-size:11px;color:var(--text2)">${esc(a.meta?.filename||kindLabel||'File')}</div>
          <div class="jd-photo-label">${esc(kindLabel)}</div>`;
        item.addEventListener('click', () => window.open(fullUrl, '_blank'));
      }
      pg.appendChild(item);
    });
    sec.appendChild(pg);
    body.appendChild(sec);
  }

  // Activity log
  if (events.length) {
    const sec = document.createElement('div');
    sec.innerHTML = `<div class="jd-section-title">Activity (${events.length})</div>`;
    const list = document.createElement('div');
    list.className = 'jd-events-list';
    const evIcon = t => ({
      status_changed:'🔄', note:'💬', photos_added:'📷', signature_added:'✍️',
      reassigned:'👤', comments_check_tagged:'🏷️', checkin:'📍', checkout:'🏁',
      'portal_link.auto_send':'🔗', 'portal_link':'🔗',
    }[t] || (t?.startsWith('portal_link') ? '🔗' : '📋'));
    events.forEach(ev => {
      const div = document.createElement('div');
      div.className = 'jd-event';
      const ts = ev.created_at
        ? new Date(ev.created_at).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})
        : '';
      div.innerHTML = `
        <span class="jd-event-icon">${evIcon(ev.event_type)}</span>
        <div class="jd-event-body">
          <span class="jd-event-actor">${esc(ev.actor_name||'System')}</span>
          ${ev.message ? `<div class="jd-event-msg">${esc(ev.message)}</div>` : ''}
        </div>
        <span class="jd-event-time">${esc(ts)}</span>`;
      list.appendChild(div);
    });
    sec.appendChild(list);
    body.appendChild(sec);
  }

  // Add Note section
  const noteSection = document.createElement('div');
  noteSection.style.cssText = 'padding:10px 0 4px;border-top:1px solid var(--border);margin-top:8px';
  const jdNoteLbl = document.createElement('div');
  jdNoteLbl.className = 'jd-section-title';
  jdNoteLbl.textContent = 'Add Note';
  const jdNoteTa = document.createElement('textarea');
  jdNoteTa.style.cssText = 'width:100%;min-height:56px;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg3);color:var(--text);font-size:12px;resize:vertical;font-family:inherit;margin:6px 0';
  jdNoteTa.placeholder = 'Add internal note to the job timeline…';
  const jdNoteAddBtn = document.createElement('button');
  jdNoteAddBtn.className = 'jd-btn jd-btn-primary';
  jdNoteAddBtn.textContent = '+ Add Note';
  jdNoteAddBtn.addEventListener('click', async () => {
    const msg = jdNoteTa.value.trim();
    if (!msg) return;
    jdNoteAddBtn.disabled = true; jdNoteAddBtn.textContent = 'Adding…';
    try {
      await _addJobNote(jobId, msg);
      jdNoteTa.value = '';
      setStatus('Note added ✓');
      const modal = document.getElementById('jd-modal');
      modal.innerHTML = '<div class="jd-spinner"><div class="spinner"></div>Refreshing…</div>';
      const nd = await api.getJob(jobId);
      modal.innerHTML = ''; modal.appendChild(buildJobDetail(nd, jobId));
    } catch(e) {
      setStatus('Note failed: ' + e.message, false);
      jdNoteAddBtn.disabled = false; jdNoteAddBtn.textContent = '+ Add Note';
    }
  });
  noteSection.appendChild(jdNoteLbl);
  noteSection.appendChild(jdNoteTa);
  noteSection.appendChild(jdNoteAddBtn);
  body.appendChild(noteSection);

  frag.appendChild(body);
  return frag;
}

// ── QUOTATION BUILDER ─────────────────────────────────────────────────────────

let _qbPhotosSelected = new Set();
let _qbLines          = [];
let _qbJobData        = null;
let _qbQuotation      = null;
let _qbJobId          = null;
let _qbPhotoRefs      = new Map();  // photoId → 'Pic N'
let _qbPhotoRefSeq    = 0;
let _qbActiveDesc     = null;       // textarea currently focused for photo tagging
let _qbAllQuotations  = [];         // all quotations from quotations.listForJob
let _qbQuotationIdx   = 0;          // index of quote currently in editor

function openQuotationBuilder(jobId) {
  _qbJobId          = jobId;
  _qbPhotosSelected = new Set();
  _qbPhotoRefs      = new Map();
  _qbPhotoRefSeq    = 0;
  _qbActiveDesc     = null;
  _qbAllQuotations  = [];
  _qbQuotationIdx   = 0;
  const overlay = document.getElementById('qb-overlay');
  overlay.classList.add('qb-open');
  document.getElementById('qb-content').innerHTML =
    '<div class="qb-loading"><div class="spinner"></div>Loading job &amp; quotations…</div>';
  document.addEventListener('keydown', _qbEscClose);

  Promise.all([
    api.getJob(jobId),
    trpcQuery('quotations.listForJob', { jobId }).catch(() => []),
  ]).then(([jobData, quotations]) => {
    _qbJobData        = jobData;
    _qbAllQuotations  = quotations || [];
    _qbQuotationIdx   = Math.max(0, _qbAllQuotations.findIndex(q => q.can_edit !== false));
    _qbQuotation      = _qbAllQuotations[_qbQuotationIdx] ?? null;
    _qbLines     = _qbQuotation
      ? _qbQuotation.lines.map(l => ({ ...l }))
      : [{ position: 1, description: '', qty: 1, unit_price: 0 }];
    _renderQB();
  }).catch(e => {
    document.getElementById('qb-content').innerHTML =
      `<div class="qb-loading">⚠ ${esc(e.message)}</div>`;
  });
}

function closeQuotationBuilder() {
  document.getElementById('qb-overlay').classList.remove('qb-open');
  document.removeEventListener('keydown', _qbEscClose);
}
function _qbEscClose(e) { if (e.key === 'Escape') closeQuotationBuilder(); }

function _qbSetActiveDesc(ta) {
  if (_qbActiveDesc && _qbActiveDesc !== ta) _qbActiveDesc.classList.remove('qb-tag-target');
  _qbActiveDesc = ta;
  const hint = document.getElementById('qb-tag-hint');
  if (ta) {
    ta.classList.add('qb-tag-target');
    if (hint) hint.classList.add('visible');
  } else {
    if (hint) hint.classList.remove('visible');
  }
}

function _qbTagPhoto(photoId) {
  if (!_qbActiveDesc) {
    setStatus('Click inside a description field first, then click a photo to tag it', false);
    return;
  }
  if (!_qbPhotoRefs.has(photoId)) {
    _qbPhotoRefSeq++;
    _qbPhotoRefs.set(photoId, 'Pic ' + _qbPhotoRefSeq);
    _qbPhotosSelected.add(photoId);
    const cnt = _qbPhotosSelected.size;
    const el = document.getElementById('qb-sel-count');
    if (el) el.textContent = `${cnt} photo${cnt !== 1 ? 's' : ''} selected for PDF`;
  }
  const label = _qbPhotoRefs.get(photoId);
  const ref   = `[${label}]`;
  const ta    = _qbActiveDesc;
  const start = ta.selectionStart ?? ta.value.length;
  const end   = ta.selectionEnd   ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + ref + ta.value.slice(end);
  ta.selectionStart = ta.selectionEnd = start + ref.length;
  ta.dispatchEvent(new Event('input'));
  ta.focus();
  _qbRefreshPhotoBadges();
  setStatus(`Tagged as [${label}] — appears in PDF appendix`);
}

function _qbRefreshPhotoBadges() {
  document.querySelectorAll('#qb-content [data-photoid]').forEach(el => {
    const id    = el.dataset.photoid;
    const badge = el.querySelector('.qb-photo-ref-badge');
    if (!badge) return;
    if (_qbPhotoRefs.has(id)) {
      badge.textContent = _qbPhotoRefs.get(id);
      badge.style.display = 'block';
      el.classList.add('qb-photo-tagged', 'qb-photo-selected');
    } else {
      badge.style.display = 'none';
      el.classList.remove('qb-photo-tagged');
    }
  });
}

function _renderQB() {
  const content = document.getElementById('qb-content');
  content.innerHTML = '';
  const job = _qbJobData?.job || {};
  const _titleEl = document.getElementById('qb-title');
  if (_titleEl) {
    const qNo = _qbQuotation?.quote_no || '';
    const qSt = _qbQuotation?.status   || '';
    const stColors = { pending:'#F59E0B', approved:'#16a34a', declined:'#ef4444' };
    _titleEl.innerHTML = `Build Quotation${qNo ? ' · ' + esc(qNo) : ''}`
      + (qSt ? ` <span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:3px;background:${stColors[qSt]||'#6B7280'}22;color:${stColors[qSt]||'#6B7280'};border:1px solid ${stColors[qSt]||'#6B7280'}44">${esc(qSt.charAt(0).toUpperCase()+qSt.slice(1))}</span>` : '')
      + ` <span style="font-weight:400;color:var(--text2)">— ${esc(job.job_no || '')}</span>`;
  }
  content.appendChild(_qbBuildActivityPanel());
  content.appendChild(_qbBuildPhotosPanel());
  content.appendChild(_qbBuildEditorPanel());
}

function _qbBuildActivityPanel() {
  const panel = document.createElement('div');
  panel.className = 'qb-panel';
  panel.innerHTML = '<div class="qb-panel-title">📋 Notes &amp; Activity</div>';

  const job    = _qbJobData?.job || {};
  const events = [...(_qbJobData?.events || [])].reverse();

  const addr   = jobAddr(job);
  const cust   = jobCustomer(job);
  const notes  = job.notes || '';
  const access = jobAccess(job);

  const info = document.createElement('div');
  info.className = 'qb-info-block';
  info.innerHTML = [
    cust   && `<div class="qb-info-row"><b>Client:</b> ${esc(cust)}</div>`,
    addr   && `<div class="qb-info-row"><b>Address:</b> ${esc(addr)}</div>`,
    notes  && `<div class="qb-info-row"><b>Notes:</b> ${esc(notes)}</div>`,
    access && `<div class="qb-info-row"><b>Access:</b> ${esc(access)}</div>`,
  ].filter(Boolean).join('');
  panel.appendChild(info);

  if (events.length) {
    const sub = document.createElement('div');
    sub.className = 'qb-sub-title';
    sub.textContent = 'Activity';
    panel.appendChild(sub);

    const ICONS = {
      status_changed:'🔄', note:'💬', photos_added:'📷',
      signature_added:'✍️', reassigned:'👤', comments_check_tagged:'🏷️',
    };
    events.forEach(ev => {
      const div = document.createElement('div');
      div.className = 'qb-event';
      const icon = ICONS[ev.event_type] || '📋';
      const ts   = ev.created_at
        ? new Date(ev.created_at).toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })
        : '';
      div.innerHTML = `
        <span class="qb-ev-icon">${icon}</span>
        <div class="qb-ev-body">
          <div class="qb-ev-actor">${esc(ev.actor_name || 'System')}</div>
          ${ev.message ? `<div class="qb-ev-msg">${esc(ev.message)}</div>` : ''}
          <div class="qb-ev-time">${esc(ts)}</div>
        </div>`;
      if (ev.message && ev.event_type === 'note') {
        div.style.cursor = 'pointer';
        div.title = 'Click to copy note text';
        div.addEventListener('click', () => {
          navigator.clipboard.writeText(ev.message).catch(() => {});
          div.style.outline = '2px solid #22c55e';
          setTimeout(() => { div.style.outline = ''; }, 1200);
        });
      }
      panel.appendChild(div);
    });
  }

  // Add Note form
  const noteSep = document.createElement('div');
  noteSep.style.cssText = 'border-top:1px solid var(--border);margin-top:12px;padding-top:10px';
  const noteSubHdr = document.createElement('div');
  noteSubHdr.className = 'qb-sub-title';
  noteSubHdr.textContent = 'Add Note';
  const noteArea = document.createElement('textarea');
  noteArea.className = 'qb-textarea';
  noteArea.rows = 2;
  noteArea.placeholder = 'Internal note — appears on the job timeline…';
  noteArea.style.marginTop = '5px';
  const noteAddBtn = document.createElement('button');
  noteAddBtn.className = 'jd-btn jd-btn-primary';
  noteAddBtn.style.cssText = 'margin-top:6px;font-size:11px;width:100%';
  noteAddBtn.textContent = '+ Add Note';
  noteAddBtn.addEventListener('click', async () => {
    const msg = noteArea.value.trim();
    if (!msg) return;
    noteAddBtn.disabled = true; noteAddBtn.textContent = 'Adding…';
    try {
      await _addJobNote(_qbJobId, msg);
      noteArea.value = '';
      setStatus('Note added ✓');
      const fresh = await api.getJob(_qbJobId);
      _qbJobData = fresh;
      const content = document.getElementById('qb-content');
      if (content?.firstChild) content.replaceChild(_qbBuildActivityPanel(), content.firstChild);
    } catch(e) { setStatus('Note failed: ' + e.message, false); }
    noteAddBtn.disabled = false; noteAddBtn.textContent = '+ Add Note';
  });
  noteSep.appendChild(noteSubHdr);
  noteSep.appendChild(noteArea);
  noteSep.appendChild(noteAddBtn);
  panel.appendChild(noteSep);

  return panel;
}

function _qbBuildPhotosPanel() {
  const panel = document.createElement('div');
  panel.className = 'qb-panel';
  panel.innerHTML = '<div class="qb-panel-title">📷 Photos</div>';

  const photos = (_qbJobData?.attachments || []).filter(a => a.kind?.startsWith('photo') || a.kind === 'signature');

  if (!photos.length) {
    const empty = document.createElement('div');
    empty.className = 'qb-empty';
    empty.textContent = 'No photos on this job';
    panel.appendChild(empty);
    return panel;
  }

  // Tagging hint — shown when a description textarea is focused
  const hint = document.createElement('div');
  hint.className = 'qb-photo-tag-hint';
  hint.id = 'qb-tag-hint';
  hint.textContent = '📎 Click a photo to insert its reference into the description';
  panel.appendChild(hint);

  const countEl = document.createElement('div');
  countEl.className = 'qb-photo-sel-count';
  countEl.id = 'qb-sel-count';
  countEl.textContent = '0 selected for PDF';
  panel.appendChild(countEl);

  const grid = document.createElement('div');
  grid.className = 'qb-photo-grid';

  photos.forEach(a => {
    const wrap = document.createElement('div');
    wrap.className = 'qb-photo-item';
    wrap.dataset.photoid = a.id;
    const kindLabel = { photo_before:'Before', photo_after:'After', signature:'Signature' }[a.kind] || a.kind || '';
    const fullUrl = BASE + a.url;

    if (a.meta?.mime?.startsWith('image/') || a.kind === 'signature') {
      wrap.innerHTML = `
        <div class="qb-photo-sel-tick">✓</div>
        <div class="qb-photo-ref-badge" style="display:none"></div>
        <img src="${esc(fullUrl)}" alt="${esc(kindLabel)}" loading="lazy">
        <div class="qb-photo-lbl">${esc(kindLabel)}</div>`;
      wrap.querySelector('img').addEventListener('click', e => { e.stopPropagation(); window.open(fullUrl, '_blank'); });
    } else {
      wrap.innerHTML = `
        <div class="qb-photo-sel-tick">✓</div>
        <div class="qb-photo-ref-badge" style="display:none"></div>
        <div class="qb-photo-doc">📄 ${esc(a.meta?.filename || kindLabel)}</div>
        <div class="qb-photo-lbl">${esc(kindLabel)}</div>`;
    }
    wrap._photoUrl  = fullUrl;
    wrap._photoKind = kindLabel;
    wrap._photoObj  = a;

    // mousedown: prevent focus-steal from textarea when tagging
    wrap.addEventListener('mousedown', e => {
      if (_qbActiveDesc) e.preventDefault();
    });

    wrap.addEventListener('click', () => {
      // If a description is focused → tag this photo and insert reference
      if (_qbActiveDesc) {
        _qbTagPhoto(a.id);
        if (!wrap.classList.contains('qb-photo-selected')) {
          wrap.classList.add('qb-photo-selected');
        }
        return;
      }
      // Otherwise toggle PDF selection
      if (_qbPhotosSelected.has(a.id)) {
        _qbPhotosSelected.delete(a.id);
        wrap.classList.remove('qb-photo-selected');
      } else {
        _qbPhotosSelected.add(a.id);
        wrap.classList.add('qb-photo-selected');
      }
      const cnt = _qbPhotosSelected.size;
      const el = document.getElementById('qb-sel-count');
      if (el) el.textContent = `${cnt} photo${cnt !== 1 ? 's' : ''} selected for PDF`;
    });
    grid.appendChild(wrap);
  });
  panel.appendChild(grid);

  const selRow = document.createElement('div');
  selRow.style.cssText = 'display:flex;gap:6px;margin-top:8px;flex-shrink:0';
  const mkBtn = (label, fn) => {
    const b = document.createElement('button');
    b.className = 'jd-btn'; b.style.fontSize = '11px'; b.textContent = label;
    b.addEventListener('click', fn); return b;
  };
  selRow.appendChild(mkBtn('Select All', () => {
    photos.forEach(a => {
      _qbPhotosSelected.add(a.id);
      grid.querySelector(`[data-photoid="${a.id}"]`)?.classList.add('qb-photo-selected');
    });
    const cnt = _qbPhotosSelected.size;
    const el = document.getElementById('qb-sel-count');
    if (el) el.textContent = `${cnt} photo${cnt !== 1 ? 's' : ''} selected for PDF`;
  }));
  selRow.appendChild(mkBtn('None', () => {
    _qbPhotosSelected.clear();
    grid.querySelectorAll('.qb-photo-item').forEach(el => el.classList.remove('qb-photo-selected', 'qb-photo-tagged'));
    _qbPhotoRefs.clear();
    _qbPhotoRefSeq = 0;
    const el = document.getElementById('qb-sel-count');
    if (el) el.textContent = '0 selected for PDF';
    _qbRefreshPhotoBadges();
  }));
  panel.appendChild(selRow);
  return panel;
}

function _qbBuildEditorPanel() {
  const panel = document.createElement('div');
  panel.className = 'qb-panel qb-editor';

  const job     = _qbJobData?.job || {};
  const quot    = _qbQuotation;
  const vatRate = quot?.vat_rate ?? 20;
  const quoteNo = quot?.quote_no || '(new)';
  const addr    = jobAddr(job);
  const cust    = jobCustomer(job);
  const phone   = jobPhone(job);
  const today   = new Date().toLocaleDateString('en-GB', { day:'2-digit', month:'long', year:'numeric' });

  // Quote switcher tabs (shown when job has multiple quotations)
  if (_qbAllQuotations.length > 1) {
    const tabBar = document.createElement('div');
    tabBar.className = 'qb-quote-tabs';
    _qbAllQuotations.forEach((q, i) => {
      const tab = document.createElement('button');
      tab.className = 'qb-quote-tab' + (i === _qbQuotationIdx ? ' active' : '');
      tab.textContent = q.quote_no || `Quote ${i+1}`;
      const stColor = { pending:'#F59E0B', approved:'#16a34a', declined:'#ef4444' }[q.status] || 'var(--text3)';
      tab.style.borderBottomColor = stColor;
      tab.addEventListener('click', () => {
        if (i === _qbQuotationIdx) return;
        _qbQuotationIdx = i;
        _qbQuotation    = _qbAllQuotations[i];
        _qbLines        = _qbAllQuotations[i]?.lines?.map(l => ({ ...l })) || [{ position: 1, description: '', qty: 1, unit_price: 0 }];
        _renderQB();
      });
      tabBar.appendChild(tab);
    });
    panel.appendChild(tabBar);
  }

  const _approvalSt   = quot?.status || '';
  const _approvalPill = _approvalSt
    ? ` <span class="qb-status-pill qb-status-${_approvalSt}">${esc(_approvalSt.charAt(0).toUpperCase()+_approvalSt.slice(1))}</span>`
    : '';

  panel.insertAdjacentHTML('beforeend', `
    <div class="qb-panel-title">
      ✏️ Quotation ${esc(quoteNo)} ${_approvalPill}
      <span style="float:right;font-size:10px;font-weight:400;color:var(--text3)">${esc(today)}</span>
    </div>
    <div class="qb-quote-meta">
      ${cust  ? `<div><b>To:</b> ${esc(cust)}</div>`  : ''}
      ${addr  ? `<div><b>Property:</b> ${esc(addr)}</div>` : ''}
      ${phone ? `<div><b>Phone:</b> ${esc(phone)}</div>` : ''}
      <div><b>Job:</b> ${esc(job.job_no || '—')}</div>
    </div>`);

  // Cover message
  const msgLabel = document.createElement('div');
  msgLabel.className = 'qb-field-label';
  msgLabel.textContent = 'Cover message (optional)';
  const msgArea = document.createElement('textarea');
  msgArea.id = 'qb-message';
  msgArea.className = 'qb-textarea';
  msgArea.rows = 3;
  msgArea.placeholder = 'Thank you for the opportunity to quote for this work…';
  msgArea.value = quot?.message || '';
  msgArea.addEventListener('focus', () => _qbSetActiveDesc(msgArea));
  panel.appendChild(msgLabel);
  panel.appendChild(msgArea);

  // Lines label
  const linesLbl = document.createElement('div');
  linesLbl.className = 'qb-field-label';
  linesLbl.style.marginTop = '12px';
  linesLbl.textContent = 'Line items';
  panel.appendChild(linesLbl);

  const linesDiv = document.createElement('div');
  linesDiv.id = 'qb-lines';
  panel.appendChild(linesDiv);

  function renderLines() {
    linesDiv.innerHTML = '';
    _qbLines.forEach((line, i) => {
      const row = document.createElement('div');
      row.className = 'qb-line-row';
      row.innerHTML = `
        <div class="qb-line-desc-wrap">
          <textarea class="qb-line-desc" rows="2" placeholder="Description of work…">${esc(line.description || '')}</textarea>
          <button class="qb-ai-btn" data-idx="${i}" title="Rewrite with Gemini AI">✨ AI</button>
          <button class="qb-tag-ref-btn" data-idx="${i}" title="Focus here then click a photo to insert [Pic N]">📷</button>
        </div>
        <div class="qb-line-nums">
          <input type="number" class="qb-line-qty" value="${line.qty || 1}" min="1" step="1" placeholder="Qty">
          <span class="qb-line-x">×</span>
          <span class="qb-line-sym">£</span>
          <input type="number" class="qb-line-price" value="${line.unit_price || ''}" min="0" step="0.01" placeholder="0.00">
          <span class="qb-line-total">£${((line.qty || 1) * (line.unit_price || 0)).toFixed(2)}</span>
          <button class="qb-line-del" data-idx="${i}" title="Remove line">✕</button>
        </div>`;

      const desc  = row.querySelector('.qb-line-desc');
      const qty   = row.querySelector('.qb-line-qty');
      const price = row.querySelector('.qb-line-price');
      const total = row.querySelector('.qb-line-total');

      desc.addEventListener('focus', () => _qbSetActiveDesc(desc));

      row.querySelector('.qb-tag-ref-btn').addEventListener('click', () => {
        _qbSetActiveDesc(desc);
        desc.focus();
        setStatus('Now click a photo in the Photos panel to insert its reference here');
      });

      const sync = () => {
        _qbLines[i] = { ..._qbLines[i], description: desc.value, qty: Number(qty.value) || 1, unit_price: Number(price.value) || 0 };
        total.textContent = `£${(_qbLines[i].qty * _qbLines[i].unit_price).toFixed(2)}`;
        _qbUpdateTotals();
      };
      desc.addEventListener('input', sync);
      qty.addEventListener('input', sync);
      price.addEventListener('input', sync);

      row.querySelector('.qb-line-del').addEventListener('click', () => {
        _qbLines.splice(i, 1); renderLines(); _qbUpdateTotals();
      });
      row.querySelector('.qb-ai-btn').addEventListener('click', async () => {
        const aiBtn = row.querySelector('.qb-ai-btn');
        const text  = desc.value.trim();
        if (!text) { setStatus('Type a description first', false); return; }
        const key = await _qbGetGeminiKey();
        if (!key) return;
        aiBtn.textContent = '…'; aiBtn.disabled = true;
        try {
          const rewritten = await _qbGeminiRewrite(text, key);
          if (rewritten) { desc.value = rewritten; sync(); }
          setStatus('AI rewrite done ✓');
        } catch(e) { setStatus('Gemini error: ' + e.message, false); }
        aiBtn.textContent = '✨ AI'; aiBtn.disabled = false;
      });
      linesDiv.appendChild(row);
    });
  }
  renderLines();

  // Add line button
  const addLineBtn = document.createElement('button');
  addLineBtn.className = 'jd-btn jd-btn-primary';
  addLineBtn.style.cssText = 'margin-top:8px;font-size:11px;width:100%';
  addLineBtn.textContent = '+ Add Line Item';
  addLineBtn.addEventListener('click', () => {
    _qbLines.push({ position: _qbLines.length + 1, description: '', qty: 1, unit_price: 0 });
    renderLines(); _qbUpdateTotals();
  });
  panel.appendChild(addLineBtn);

  // Generate full quote from job notes with Gemini
  const genBtn = document.createElement('button');
  genBtn.className = 'jd-btn';
  genBtn.style.cssText = 'margin-top:6px;font-size:11px;width:100%;background:rgba(124,58,237,.08);color:#7c3aed;border-color:rgba(124,58,237,.3)';
  genBtn.textContent = '✨ Generate full quote from job notes';
  genBtn.addEventListener('click', async () => {
    const key = await _qbGetGeminiKey();
    if (!key) return;
    genBtn.disabled = true; genBtn.textContent = '✨ Generating…';
    try {
      const j      = _qbJobData?.job || {};
      const evts   = (_qbJobData?.events || []).slice(-10).reverse();
      const ctx = [
        j.title       ? `Job type: ${j.title}` : '',
        j.description ? `Description: ${j.description}` : '',
        j.notes       ? `Notes: ${j.notes}` : '',
        jobAddr(j)    ? `Address: ${jobAddr(j)}` : '',
        evts.length   ? 'Activity:\n' + evts.map(ev => `- ${ev.actor_name||'System'}: ${ev.message||ev.event_type||''}`).join('\n') : '',
      ].filter(Boolean).join('\n\n');
      if (!ctx.trim()) {
        setStatus('No job context found — add notes to the job first', false);
      } else {
        const newLines = await _qbGeminiGenerateQuote(ctx, key);
        if (newLines?.length) {
          _qbLines = newLines;
          renderLines(); _qbUpdateTotals();
          setStatus(`✨ Generated ${newLines.length} line item${newLines.length !== 1 ? 's' : ''} — review and adjust before saving`);
        } else {
          setStatus('Gemini returned no lines — add more detail to the job notes', false);
        }
      }
    } catch(e) { setStatus('Gemini error: ' + e.message, false); }
    genBtn.disabled = false; genBtn.textContent = '✨ Generate full quote from job notes';
  });
  panel.appendChild(genBtn);

  // VAT selector
  const vatRow = document.createElement('div');
  vatRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:12px;font-size:12px';
  vatRow.innerHTML = `<label style="color:var(--text2)">VAT rate:</label>
    <select id="qb-vat" class="dfb-sel" style="width:80px">
      <option value="0"  ${vatRate === 0  ? 'selected' : ''}>0%</option>
      <option value="5"  ${vatRate === 5  ? 'selected' : ''}>5%</option>
      <option value="20" ${vatRate === 20 ? 'selected' : ''}>20%</option>
    </select>`;
  vatRow.querySelector('#qb-vat').addEventListener('change', _qbUpdateTotals);
  panel.appendChild(vatRow);

  // Totals
  const totalsDiv = document.createElement('div');
  totalsDiv.id = 'qb-totals';
  totalsDiv.className = 'qb-totals';
  panel.appendChild(totalsDiv);

  // Action buttons
  const btnRow = document.createElement('div');
  btnRow.className = 'qb-btn-row';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'jd-btn jd-btn-success';
  saveBtn.textContent = '💾 Save to Portal';
  saveBtn.addEventListener('click', async () => {
    const lines = _qbLines.filter(l => l.description?.trim() || l.unit_price > 0);
    if (!lines.length) { setStatus('Add at least one line item', false); return; }
    saveBtn.disabled = true; saveBtn.textContent = '…';
    try {
      const vatR    = Number(document.getElementById('qb-vat')?.value ?? 0);
      const msg     = document.getElementById('qb-message')?.value?.trim() || null;
      const payload = lines.map((l, i) => ({
        position: i + 1, description: l.description,
        qty: Number(l.qty) || 1, unit_price: Number(l.unit_price) || 0,
      }));
      let result;
      if (_qbQuotation) {
        result = await trpcMutate('quotations.update', {
          id: _qbQuotation.id, lines: payload, vatRate: vatR,
          ...(msg != null ? { message: msg } : {}),
        });
      } else {
        result = await trpcMutate('quotations.create', {
          jobId: _qbJobId,
          ...(job.contact_id  ? { contactId:  job.contact_id  } : {}),
          ...(job.property_id ? { propertyId: job.property_id } : {}),
          lines: payload, vatRate: vatR,
          ...(msg != null ? { message: msg } : {}),
        });
        _qbQuotation     = result;
        _qbAllQuotations = [result];
        _qbQuotationIdx  = 0;
        const _nt = document.getElementById('qb-title');
        if (_nt) _nt.innerHTML = `Build Quotation${result?.quote_no ? ' · ' + esc(result.quote_no) : ''} <span style="font-weight:400;color:var(--text2)">— ${esc(job.job_no || '')}</span>`;
      }
      setStatus(`Quotation ${result?.quote_no || ''} saved · ${now()}`);
      saveBtn.textContent = '✓ Saved!';
      setTimeout(() => { saveBtn.disabled = false; saveBtn.textContent = '💾 Save to Portal'; }, 2000);
    } catch(e) {
      saveBtn.disabled = false; saveBtn.textContent = '💾 Save to Portal';
      setStatus('Save failed: ' + e.message, false);
    }
  });

  const pdfBtn = document.createElement('button');
  pdfBtn.className = 'jd-btn jd-btn-primary';
  pdfBtn.textContent = '📄 Download PDF';
  pdfBtn.addEventListener('click', async () => {
    pdfBtn.disabled = true; pdfBtn.textContent = 'Building PDF…';
    try {
      const lines = _qbLines.filter(l => l.description?.trim() || l.unit_price > 0);
      const vatR  = Number(document.getElementById('qb-vat')?.value ?? 0);
      const msg   = document.getElementById('qb-message')?.value?.trim() || '';
      const allPhotos = (_qbJobData?.attachments || []).filter(a => a.kind?.startsWith('photo') || a.kind === 'signature');
      const selPhotos = allPhotos.filter(a => _qbPhotosSelected.has(a.id));
      const _q = _qbQuotation;
      const _contactName = _q?.contact?.name || cust || '';
      const _contactAddr = [_q?.contact?.address, _q?.contact?.postcode].filter(Boolean).join(', ') || addr || '';
      const _propAddr    = [_q?.property?.address, _q?.property?.postcode].filter(Boolean).join(', ') || addr || '';
      await _qbDownloadPdf({
        quoteNo: _q?.quote_no || 'QUO-DRAFT',
        jobNo: job.job_no || '',
        customer: _contactName, contactAddr: _contactAddr, propertyAddr: _propAddr,
        lines, vatRate: vatR, message: msg, date: today,
      }, selPhotos);
    } catch(e) { setStatus('PDF error: ' + e.message, false); }
    pdfBtn.disabled = false; pdfBtn.textContent = '📄 Download PDF';
  });

  const waQbBtn = document.createElement('button');
  waQbBtn.className = 'jd-btn jd-btn-wa';
  waQbBtn.textContent = '💬 Send via WhatsApp';
  waQbBtn.addEventListener('click', async () => {
    waQbBtn.disabled = true; waQbBtn.textContent = 'Downloading…';
    try {
      const lines = _qbLines.filter(l => l.description?.trim() || l.unit_price > 0);
      if (!lines.length) { setStatus('Add at least one line item first', false); waQbBtn.disabled=false; waQbBtn.textContent='💬 Send via WhatsApp'; return; }
      const vatR  = Number(document.getElementById('qb-vat')?.value ?? 0);
      const msg   = document.getElementById('qb-message')?.value?.trim() || '';
      const allPhotos = (_qbJobData?.attachments || []).filter(a => a.kind?.startsWith('photo') || a.kind === 'signature');
      const selPhotos = allPhotos.filter(a => _qbPhotosSelected.has(a.id));
      const _q = _qbQuotation;
      const _contactName = _q?.contact?.name || cust || '';
      const _contactAddr = [_q?.contact?.address, _q?.contact?.postcode].filter(Boolean).join(', ') || addr || '';
      const _propAddr    = [_q?.property?.address, _q?.property?.postcode].filter(Boolean).join(', ') || addr || '';
      const qNo = _q?.quote_no || 'QUO-DRAFT';

      // Step 1: auto-download the quotation HTML to Downloads (no print dialog)
      setStatus('Saving quotation to Downloads…');
      await _qbDownloadPdf({
        quoteNo: qNo, jobNo: job.job_no || '',
        customer: _contactName, contactAddr: _contactAddr, propertyAddr: _propAddr,
        lines, vatRate: vatR, message: msg, date: today,
      }, selPhotos, { download: true });

      // Step 2: open WhatsApp with pre-filled message
      const waPhone = (phone||'').replace(/\D/g,'').replace(/^0/,'44');
      if (waPhone) {
        waQbBtn.textContent = 'Opening WhatsApp…';
        const firstName = (_contactName||'').split(' ')[0];
        const text = encodeURIComponent(
          `Hi${firstName ? ' '+firstName : ''}, please find your quotation ${qNo} from GB Electrical in the message below. Let us know if you have any questions. Thank you.`
        );
        window.open(`https://wa.me/${waPhone}?text=${text}`, '_blank');
        setStatus(`📁 Quotation-${qNo}.html saved to Downloads — in WhatsApp click 📎 → Document to attach it`);
      } else {
        setStatus(`📁 Quotation-${qNo}.html saved to Downloads — open WhatsApp, find the contact and click 📎 to attach`, false);
      }
    } catch(e) { setStatus('WhatsApp error: ' + e.message, false); }
    waQbBtn.disabled = false; waQbBtn.textContent = '💬 Send via WhatsApp';
  });

  btnRow.appendChild(saveBtn);
  btnRow.appendChild(pdfBtn);
  btnRow.appendChild(waQbBtn);
  panel.appendChild(btnRow);

  // Send to Client (only when quote has been saved to portal)
  if (_qbQuotation?.id) {
    const sendRow = document.createElement('div');
    sendRow.style.cssText = 'margin-top:6px';
    const sendBtn = document.createElement('button');
    sendBtn.className = 'jd-btn';
    sendBtn.style.cssText = 'width:100%;background:rgba(99,102,241,.09);color:#6366f1;border-color:rgba(99,102,241,.35)';
    const _qSt = _qbQuotation?.status || '';
    sendBtn.textContent = _qSt === 'pending' ? '📧 Re-send to Client' : _qSt === 'approved' ? '✓ Approved — Re-send?' : '📧 Send to Client';
    sendBtn.addEventListener('click', async () => {
      if (!confirm(`Send quotation to ${cust || 'the client'}?\n\nThey will receive an email with an approval link.`)) return;
      sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
      try {
        await trpcMutate('quotations.send', { id: _qbQuotation.id });
        sendBtn.textContent = '✓ Sent to client';
        setStatus('Quotation sent to client ✓');
        _qbQuotation.status = 'pending';
        const _nt = document.getElementById('qb-title');
        if (_nt) {
          const qNo = _qbQuotation.quote_no || '';
          _nt.innerHTML = `Build Quotation${qNo?' · '+esc(qNo):''} <span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:3px;background:#F59E0B22;color:#F59E0B;border:1px solid #F59E0B44">Pending</span> <span style="font-weight:400;color:var(--text2)">— ${esc(job.job_no||'')}</span>`;
        }
      } catch(e) {
        sendBtn.disabled = false;
        sendBtn.textContent = '📧 Send to Client';
        setStatus('Send failed: ' + e.message, false);
      }
    });
    sendRow.appendChild(sendBtn);
    panel.appendChild(sendRow);
  }

  // Gemini key link
  const aiRow = document.createElement('div');
  aiRow.style.cssText = 'margin-top:8px;font-size:11px;color:var(--text3)';
  aiRow.innerHTML = `<a href="#" id="qb-ai-key-link" style="color:var(--text3);text-decoration:underline">Set Gemini AI key</a>
    <span style="margin-left:6px" id="qb-ai-key-status"></span>`;
  aiRow.querySelector('#qb-ai-key-link').addEventListener('click', async e => {
    e.preventDefault();
    const stored = await store.get('gemini_key');
    const cur    = stored.gemini_key || '';
    const key    = prompt('Enter your Gemini API key\n(free at aistudio.google.com/apikey):\n\nLeave blank to clear.', cur);
    if (key === null) return;
    await store.set({ gemini_key: key.trim() });
    const statusEl = document.getElementById('qb-ai-key-status');
    if (statusEl) statusEl.textContent = key.trim() ? '✓ Key saved' : '(cleared)';
    setStatus(key.trim() ? 'Gemini AI key saved' : 'Gemini key cleared');
  });
  // Show if key already set
  store.get('gemini_key').then(s => {
    const statusEl = document.getElementById('qb-ai-key-status');
    if (statusEl && s.gemini_key) statusEl.textContent = '✓ Key set';
  }).catch(() => {});
  panel.appendChild(aiRow);

  _qbUpdateTotals();
  return panel;
}

function _qbUpdateTotals() {
  const totalsDiv = document.getElementById('qb-totals');
  if (!totalsDiv) return;
  const vatR     = Number(document.getElementById('qb-vat')?.value ?? 0);
  const subtotal = _qbLines.reduce((s, l) => s + (Number(l.qty) || 1) * (Number(l.unit_price) || 0), 0);
  const vat      = subtotal * vatR / 100;
  const total    = subtotal + vat;
  totalsDiv.innerHTML = `
    <div class="qb-total-row"><span>Subtotal</span><span>£${subtotal.toFixed(2)}</span></div>
    ${vatR > 0 ? `<div class="qb-total-row"><span>VAT (${vatR}%)</span><span>£${vat.toFixed(2)}</span></div>` : ''}
    <div class="qb-total-row qb-total-final"><span>Total</span><span>£${total.toFixed(2)}</span></div>`;
}

async function _qbGetGeminiKey() {
  const stored = await store.get('gemini_key');
  if (stored.gemini_key) return stored.gemini_key;
  const key = prompt('Enter your Gemini API key (free at aistudio.google.com/apikey):');
  if (!key?.trim()) return null;
  await store.set({ gemini_key: key.trim() });
  return key.trim();
}

async function _qbGeminiRewrite(text, apiKey) {
  const prompt = `You are helping GB Electrical / OHM Electrical Engineering write a professional client quotation. Rewrite this as clear, professional text for a client-facing quotation line item. Keep all technical detail. Be concise. Output the rewritten text only:\n\n${text}`;
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }
  );
  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}));
    throw new Error(errData?.error?.message || `HTTP ${resp.status}`);
  }
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

async function _qbFetchImageAsBase64(url) {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`Photo fetch failed: ${resp.status}`);
  const blob = await resp.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror   = reject;
    reader.readAsDataURL(blob);
  });
}

async function _qbDownloadPdf(meta, selectedPhotos, opts = {}) {
  setStatus('Fetching photos for PDF…');
  const photoData = [];
  for (const a of selectedPhotos) {
    try {
      const dataUrl = await _qbFetchImageAsBase64(BASE + a.url);
      photoData.push({
        photoId: a.id,
        dataUrl,
        kind: { photo_before:'Before', photo_after:'After', signature:'Signature' }[a.kind] || a.kind || '',
        by: a.uploaded_by_name || '',
      });
    } catch(e) { console.warn('Skipped photo:', a.id, e.message); }
  }
  setStatus('Opening PDF…');

  const subtotal = meta.lines.reduce((s, l) => s + (l.qty || 1) * (l.unit_price || 0), 0);
  const vat      = subtotal * meta.vatRate / 100;
  const total    = subtotal + vat;

  // Style [Pic N] references as clickable links to the photo in the appendix
  const stylePicRefs = text => esc(text).replace(/\[Pic (\d+)\]/g,
    (m, n) => `<a href="#pic-${n}" style="color:#E1251B;font-weight:700;font-size:10px;text-decoration:underline dotted;cursor:pointer">${m}</a>`);

  const linesHtml = meta.lines.map(l => {
    const lineTotal = (l.qty || 1) * (l.unit_price || 0);
    const descLines = (l.description || '').split('\n');
    const mainDesc  = stylePicRefs(descLines[0] || '');
    const noteLines = descLines.slice(1).filter(ln => ln.trim());
    const notesHtml = noteLines.length
      ? `<div style="margin-top:5px">${noteLines.map(ln => `<div style="color:#444">${stylePicRefs(ln)}</div>`).join('')}</div>`
      : '';
    return `<tr>
      <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;vertical-align:top">${mainDesc}${notesHtml}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap;vertical-align:top">${l.qty || 1}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap;vertical-align:top">£${(l.unit_price || 0).toFixed(2)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap;vertical-align:top">${meta.vatRate}%</td>
      <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap;vertical-align:top">£${lineTotal.toFixed(2)}</td>
    </tr>`;
  }).join('');

  // Build photo appendix: tagged photos first (in label order), then untagged selected
  const taggedOrder = [..._qbPhotoRefs.entries()]
    .sort((a, b) => parseInt(a[1].replace('Pic ', '')) - parseInt(b[1].replace('Pic ', '')));
  const taggedIds  = new Set(taggedOrder.map(([id]) => id));

  // Map photoId → photoData entry for quick lookup
  const photoMap = new Map(photoData.map(p => [p.photoId, p]));

  const orderedPhotos = [
    ...taggedOrder.map(([id, label]) => ({ ...(photoMap.get(id) || {}), label })).filter(p => p.dataUrl),
    ...photoData.filter(p => !taggedIds.has(p.photoId)),
  ];

  const photosSection = orderedPhotos.length ? `
    <div style="page-break-before:always;padding:32px 36px 40px;font-family:-apple-system,'Helvetica Neue',Arial,sans-serif">
      <div style="font-size:13px;font-weight:800;text-transform:uppercase;color:#1a1a1a;margin-bottom:8px;letter-spacing:0.5px">Photo Appendix</div>
      <div style="height:1px;background:#E1251B;margin-bottom:20px"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        ${orderedPhotos.map(p => {
          const anchorId = p.label ? `pic-${p.label.replace('Pic ', '')}` : '';
          return `<div${anchorId ? ` id="${anchorId}"` : ''} style="scroll-margin-top:20px">
            <img src="${p.dataUrl}" style="width:100%;border:1px solid #e5e7eb;display:block">
            <div style="font-size:11px;color:#1a1a1a;margin-top:5px;font-weight:${p.label ? '700' : '400'}">
              ${p.label ? `<span style="color:#E1251B;font-size:13px">[${esc(p.label)}]</span> — ` : ''}${esc(p.kind || '')}${p.by ? ` · ${esc(p.by)}` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>` : '';

  const logoSvg = `<svg viewBox="0 0 88 68" xmlns="http://www.w3.org/2000/svg" width="88" height="68">
    <rect x="0" y="0" width="66" height="55" rx="3" fill="#E1251B"/>
    <text x="33" y="41" font-family="Arial Black,Arial,sans-serif" font-size="28" font-weight="900" fill="white" text-anchor="middle" dominant-baseline="auto">GB</text>
    <text x="33" y="66" font-family="Arial,sans-serif" font-size="6" fill="#333" text-anchor="middle" letter-spacing="0.8">ELECTRICAL ENGINEERING LTD</text>
  </svg>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${esc(meta.quoteNo)}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif;
  color: #1a1a1a; background: #fff;
  max-width: 820px; margin: 0 auto; padding: 32px 36px 48px;
  font-size: 12px; line-height: 1.45;
}
.print-bar {
  position: fixed; top: 0; left: 0; right: 0;
  background: #1f2937; padding: 9px 20px;
  display: flex; align-items: center; gap: 12px; z-index: 100;
}
.print-btn {
  padding: 7px 16px; background: #E1251B; color: #fff;
  border: none; border-radius: 4px; font-size: 13px; font-weight: 700; cursor: pointer;
}
.print-btn:hover { background: #c01f17; }
.print-note { color: rgba(255,255,255,0.65); font-size: 12px; }
body { padding-top: 62px; }
@media print {
  body { padding-top: 32px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .print-bar { display: none !important; }
  @page { margin: 14mm 12mm; size: A4; }
}
</style>
</head>
<body>

<div class="print-bar">
  <button class="print-btn" onclick="window.print()">🖨️ Print / Save as PDF</button>
  <span class="print-note">Use Print → Save as PDF</span>
</div>

<!-- HEADER -->
<table style="width:100%;border-collapse:collapse;margin-bottom:10px">
  <tr>
    <td style="vertical-align:middle;padding-right:18px;width:96px">${logoSvg}</td>
    <td style="vertical-align:top;padding-top:3px">
      <div style="font-size:15px;font-weight:700;color:#1a1a1a;margin-bottom:4px">GB Electrical</div>
      <div style="font-size:10.5px;color:#555;line-height:1.65">
        7 Mill Lane, Chadwell Heath, Romford, Essex, RM6 6TT<br>
        07865753925 · Compliance@gbelectricals.co.uk
      </div>
    </td>
    <td style="vertical-align:top;text-align:right;padding-top:2px">
      <div style="font-size:34px;font-weight:900;color:#E1251B;letter-spacing:-0.5px;line-height:1">QUOTATION</div>
      <div style="font-size:11px;color:#555;margin-top:5px">QUOTATION NO.&nbsp;<strong style="color:#1a1a1a">${esc(meta.quoteNo)}</strong></div>
    </td>
  </tr>
</table>

<!-- Red rule -->
<div style="height:1.5px;background:#E1251B;margin-bottom:7px"></div>

<!-- Company no -->
<div style="font-size:10px;color:#999;margin-bottom:14px">Company No. 15476506</div>

<!-- 3-column info -->
<table style="width:100%;border-collapse:collapse;margin-bottom:16px">
  <tr style="vertical-align:top">
    <td style="width:37%;padding-right:14px;border-right:1px solid #e5e7eb;padding-bottom:6px">
      <div style="font-size:8.5px;color:#888;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;margin-bottom:6px">QUOTATION FOR</div>
      ${meta.customer ? `<div style="font-size:12px;font-weight:700;color:#1a1a1a;margin-bottom:3px">${esc(meta.customer)}</div>` : ''}
      ${meta.contactAddr ? `<div style="font-size:11px;color:#333;line-height:1.5">${esc(meta.contactAddr)}</div>` : ''}
    </td>
    <td style="width:36%;padding:0 14px;border-right:1px solid #e5e7eb;padding-bottom:6px">
      <div style="font-size:8.5px;color:#888;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;margin-bottom:6px">WORKS TO BE CARRIED OUT AT</div>
      ${meta.propertyAddr ? `<div style="font-size:11px;color:#333;line-height:1.5">${esc(meta.propertyAddr)}</div>` : ''}
    </td>
    <td style="width:27%;padding-left:14px;padding-bottom:6px">
      <table style="width:100%;border-collapse:collapse">
        <tr>
          <td style="font-size:8.5px;color:#888;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;padding-bottom:4px">QUOTATION DATE</td>
          <td style="font-size:11px;font-weight:700;color:#1a1a1a;text-align:right;padding-bottom:4px">${esc(meta.date)}</td>
        </tr>
        ${meta.jobNo ? `<tr>
          <td style="font-size:8.5px;color:#888;font-weight:700;text-transform:uppercase;letter-spacing:0.7px">JOB REF</td>
          <td style="font-size:11px;font-weight:700;color:#1a1a1a;text-align:right">${esc(meta.jobNo)}</td>
        </tr>` : ''}
      </table>
    </td>
  </tr>
</table>

${meta.message ? `<div style="background:#fafafa;border:1px solid #e5e7eb;padding:10px 14px;margin-bottom:14px;font-size:11px;color:#333;white-space:pre-wrap;line-height:1.5">${stylePicRefs(meta.message)}</div>` : ''}

<!-- QUOTED WORK heading -->
<div style="font-size:11.5px;font-weight:800;text-transform:uppercase;letter-spacing:0.4px;color:#1a1a1a;margin-bottom:6px">QUOTED WORK</div>
<div style="height:1px;background:#ccc;margin-bottom:0"></div>

<!-- Line items table -->
<table style="width:100%;border-collapse:collapse;margin-bottom:0">
  <thead>
    <tr style="background:#f3f4f6;border-top:1px solid #d1d5db;border-bottom:1px solid #d1d5db">
      <th style="padding:7px 10px;text-align:left;font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#374151">DESCRIPTION</th>
      <th style="padding:7px 10px;text-align:right;font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#374151;width:44px">QTY</th>
      <th style="padding:7px 10px;text-align:right;font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#374151;width:84px">UNIT PRICE</th>
      <th style="padding:7px 10px;text-align:right;font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#374151;width:40px">VAT</th>
      <th style="padding:7px 10px;text-align:right;font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#374151;width:84px">AMOUNT</th>
    </tr>
  </thead>
  <tbody>${linesHtml}</tbody>
</table>

<div style="height:1px;background:#d1d5db;margin-bottom:22px"></div>

<!-- Bottom: How to approve (left) + Totals (right) -->
<table style="width:100%;border-collapse:collapse;margin-bottom:16px">
  <tr style="vertical-align:top">
    <td style="width:54%;padding-right:20px">
      <table style="width:100%;border-collapse:collapse;border:1px solid #d1d5db">
        <tr>
          <td style="padding:12px 14px">
            <div style="font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:#888;margin-bottom:8px">HOW TO APPROVE</div>
            <div style="font-size:10.5px;color:#333;line-height:1.55;margin-bottom:12px">Review every line, then approve or decline this quotation in your client portal. Nothing is booked and nothing is owed until you approve it.</div>
            <div style="font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:#888;margin-bottom:5px">QUOTATION REFERENCE</div>
            <div style="font-size:17px;font-weight:900;color:#1a1a1a">${esc(meta.quoteNo)}</div>
          </td>
        </tr>
      </table>
    </td>
    <td style="width:46%;padding-left:4px">
      <table style="width:100%;border-collapse:collapse">
        <tr>
          <td style="font-size:11px;color:#555;padding:5px 0;border-bottom:1px solid #f3f4f6">Subtotal (excl. VAT)</td>
          <td style="font-size:11px;text-align:right;padding:5px 0;border-bottom:1px solid #f3f4f6">£${subtotal.toFixed(2)}</td>
        </tr>
        <tr>
          <td style="font-size:11px;color:#555;padding:5px 0;border-bottom:2px solid #E1251B">VAT total at ${meta.vatRate}%</td>
          <td style="font-size:11px;text-align:right;padding:5px 0;border-bottom:2px solid #E1251B">£${vat.toFixed(2)}</td>
        </tr>
        <tr>
          <td colspan="2" style="text-align:right;padding-top:10px">
            <div style="font-size:8.5px;text-transform:uppercase;letter-spacing:0.7px;color:#888;margin-bottom:4px">QUOTATION TOTAL</div>
            <div style="font-size:30px;font-weight:900;color:#1a1a1a;line-height:1;letter-spacing:-0.5px">£${total.toFixed(2)}</div>
            <div style="font-size:10px;color:#888;margin-top:3px">Including VAT</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>

<!-- Please note -->
<div style="border-top:1px solid #e5e7eb;padding-top:10px;margin-bottom:16px;display:flex;gap:10px;align-items:baseline">
  <span style="font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:#888;flex-shrink:0">PLEASE NOTE</span>
  <span style="font-size:10px;color:#555;line-height:1.5">This is a quotation, not an invoice — nothing is payable on this document. An invoice is issued once the work is done.</span>
</div>

<!-- Footer -->
<div style="border-top:1px solid #e5e7eb;padding-top:8px;display:flex;justify-content:space-between;align-items:center;font-size:10px;color:#999">
  <span>${esc(meta.quoteNo)}</span>
  <span>GB Electrical · NICEIC Approved Contractor 15476506</span>
  <span>Page 1 of 1</span>
</div>

${photosSection}
</body>
</html>`;

  if (opts.download) {
    // Trigger a direct file download (no print dialog) — file lands in Downloads
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `Quotation-${meta.quoteNo}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    return;
  }

  const w = window.open('', '_blank');
  if (!w) { setStatus('Pop-up blocked — allow pop-ups for this page', false); return; }
  w.document.write(html);
  w.document.close();
  setStatus('PDF page opened — use Print → Save as PDF');
}

// ── MONTH VIEW ────────────────────────────────────────────────────────────────

async function loadMonth(force=false) {
  const body = document.getElementById('month-body');
  body.innerHTML = '<div class="loading-row"><div class="spinner"></div>Loading…</div>';
  document.getElementById('month-label').textContent = fmtMonth(curMonth.year, curMonth.month);
  setStatus('Loading…');

  try {
    const first = new Date(curMonth.year, curMonth.month-1, 1);
    const last  = new Date(curMonth.year, curMonth.month, 0);
    const mondays = [];
    let mon = mondayOf(isoOf(first));
    while (new Date(mon+'T00:00:00') <= last) { mondays.push(mon); mon = addDays(mon, 7); }

    await Promise.all(mondays.map(m => getWeek(m, force)));
    renderMonth();
    setStatus(`Loaded · ${now()}`);
  } catch(e) {
    body.innerHTML = err(e.message);
    setStatus(e.message, false);
  }
}

function jobsForDate(iso) {
  const mon   = mondayOf(iso);
  const lanes = cache[mon];
  if (!lanes) return [];
  const di    = weekDays(mon).indexOf(iso);
  if (di < 0) return [];
  const jobs  = [];
  lanes.forEach(lane => (lane.days[di]?.jobs||[]).forEach(j => jobs.push({...j, _eng: lane.engineer})));
  return jobs;
}

function renderMonth() {
  const body = document.getElementById('month-body');
  body.innerHTML = '';
  const {year, month} = curMonth;
  const today = todayISO();
  const first = new Date(year, month-1, 1);
  const last  = new Date(year, month, 0);
  const start = new Date(mondayOf(isoOf(first))+'T00:00:00');

  const grid = document.createElement('div');
  grid.className = 'month-grid';

  ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].forEach(d => {
    const el = document.createElement('div');
    el.className = 'month-dow'; el.textContent = d; grid.appendChild(el);
  });

  const cur = new Date(start);
  while (cur <= last || cur.getDay() !== 1) {
    const iso = isoOf(cur);
    const thisMonth = cur.getMonth()+1 === month;
    const isToday   = iso === today;
    const jobs      = jobsForDate(iso);

    const cell = document.createElement('div');
    cell.className = 'month-cell' + (!thisMonth?' other-month':'') + (isToday?' today-cell':'');

    const num = document.createElement('div');
    num.className = 'month-num'; num.textContent = cur.getDate();
    cell.appendChild(num);

    // Daily summary row: count + total value
    if (jobs.length > 0) {
      const dailyTotal = jobs.reduce((s, j) => s + (Number(j.price) || 0), 0);
      const statsEl = document.createElement('div');
      statsEl.className = 'month-day-stats';
      statsEl.innerHTML = `<span>${jobs.length} job${jobs.length!==1?'s':''}</span>${dailyTotal>0?`<span>£${dailyTotal.toFixed(0)}</span>`:''}`;
      cell.appendChild(statsEl);
    }

    jobs.slice(0, 3).forEach(j => {
      const st    = jobStatus(j);
      const color = STATUS_COLORS[st] || '#888';
      const lbl   = j.title || j.property?.address?.line1 || j.address || 'Job';
      const row   = document.createElement('div');
      row.className = 'month-job-row';
      row.title = STATUS_LABEL[st] || st;
      row.innerHTML = `<span class="month-dot" style="background:${color}"></span><span class="month-lbl">${esc(lbl)}</span>`;
      cell.appendChild(row);
    });
    if (jobs.length > 3) {
      const m = document.createElement('div');
      m.className = 'month-more'; m.textContent = `+${jobs.length-3} more`;
      cell.appendChild(m);
    }

    cell.addEventListener('click', () => { curDate=iso; curWeek=mondayOf(iso); switchView('day'); });
    grid.appendChild(cell);

    cur.setDate(cur.getDate()+1);
    if (cur > last && cur.getDay() === 1) break;
  }

  body.appendChild(grid);
}

// ── ADD JOB ───────────────────────────────────────────────────────────────────

let _addJobContactId  = null;
let _addJobPropertyId = null;
let _addJobAgencyId   = null;
let _contactSearchTmr = null;
let _jobOptions       = null;
let _addJobCertTypes  = new Set();   // checked cert type IDs
let _addJobEngineers  = [];          // [{id, name}] multi-engineer

async function _loadJobOptions() {
  if (_jobOptions) return _jobOptions;
  try { _jobOptions = await trpcQuery('settings.jobOptions'); } catch(e) {}
  return _jobOptions || {};
}

function _injectAddJobCSS() {
  if (document.getElementById('_add_job2_css')) return;
  const s = document.createElement('style');
  s.id = '_add_job2_css';
  s.textContent = `
    #view-add{align-items:flex-start!important;padding:16px 10px!important;overflow-y:auto!important}
    #view-add .add-box{width:100%!important;max-width:1020px!important;background:transparent!important;border:none!important;box-shadow:none!important;padding:0!important;gap:12px!important;display:flex;flex-direction:column}
    .aj-hdr{font-size:14px;font-weight:700;color:var(--text1)}
    .aj-hdr span{font-size:11px;font-weight:400;opacity:.5;margin-left:6px}
    .aj-cards{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start}
    .aj-right-col{display:flex;flex-direction:column;gap:14px}
    .aj-card{background:var(--bg2);border:1px solid var(--border);border-radius:12px;display:flex;flex-direction:column}
    .aj-ch{padding:10px 16px;border-bottom:1px solid var(--border);background:var(--bg3);display:flex;align-items:center;gap:8px;border-radius:12px 12px 0 0}
    .aj-chi{font-size:15px;line-height:1}
    .aj-cht{font-size:12px;font-weight:700;color:var(--text1);text-transform:uppercase;letter-spacing:.04em}
    .aj-cb{padding:14px 16px;display:flex;flex-direction:column;gap:10px}
    .aj-row{display:flex;gap:8px;align-items:flex-end}
    .aj-fg{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}
    .aj-fl{font-size:10px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.05em}
    .aj-req{color:var(--red)}
    .aj-sel-wrap{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:8px 12px;display:flex;align-items:center;justify-content:space-between;gap:8px}
    .aj-sel-nm{font-size:12.5px;font-weight:600;color:var(--text1)}
    .aj-sel-sb{font-size:11px;color:var(--text2)}
    .aj-sel-cl{font-size:11px;color:var(--text3);cursor:pointer;border:none;background:none;text-decoration:underline;padding:0;flex-shrink:0}
    .aj-sel-cl:hover{color:var(--text1)}
    .aj-div{font-size:10px;color:var(--text3);display:flex;align-items:center;gap:6px}
    .aj-div::before,.aj-div::after{content:'';flex:1;height:1px;background:var(--border)}
    .aj-new{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
    .aj-new-lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text3)}
    .aj-sec{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text3)}
    .aj-cert-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px}
    .aj-cert{display:flex;align-items:center;gap:5px;padding:5px 7px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);cursor:pointer;user-select:none;transition:border-color .1s}
    .aj-cert:hover{border-color:var(--red)}
    .aj-cert.on{border-color:var(--red);background:var(--bg4)}
    .aj-cert.on .aj-ct{font-weight:600;color:var(--text1)}
    .aj-cbx{width:13px;height:13px;border-radius:3px;border:1.5px solid var(--text3);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:9px;color:transparent;transition:all .1s}
    .aj-cert.on .aj-cbx{background:var(--red);border-color:var(--red);color:#fff}
    .aj-ct{font-size:11px;color:var(--text2);line-height:1.2}
    .aj-chips{display:flex;flex-wrap:wrap;gap:4px;min-height:0}
    .aj-chip{display:inline-flex;align-items:center;gap:4px;background:var(--bg4);border:1px solid var(--border);border-radius:20px;padding:3px 8px 3px 6px;font-size:11px;color:var(--text2)}
    .aj-chip-x{background:none;border:none;cursor:pointer;color:var(--text3);padding:0 1px;font-size:13px;line-height:1;display:flex;align-items:center}
    .aj-chip-x:hover{color:var(--text1)}
    .aj-drop-wrap{position:relative}
    .aj-drop{position:absolute;left:0;right:0;top:100%;z-index:200;background:var(--bg2);border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-top:2px;max-height:180px;overflow-y:auto;box-shadow:0 4px 16px rgba(0,0,0,.15)}
    .aj-dh{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:5px 10px 3px;color:var(--text3);background:var(--bg3);border-bottom:1px solid var(--border)}
    .aj-di{padding:7px 10px;cursor:pointer;border-bottom:1px solid var(--border);font-size:12.5px;color:var(--text1)}
    .aj-di:last-child{border-bottom:none}
    .aj-di:hover{background:var(--bg3)}
    .aj-di-nm{font-weight:600}
    .aj-di-sb{font-size:11px;color:var(--text2);margin-top:1px}
    .aj-badge{font-size:9px;padding:1px 5px;border-radius:7px;background:var(--bg4);color:var(--text2);margin-left:4px;font-weight:600}
    .aj-dn{font-size:12px;color:var(--text3);padding:8px 10px;text-align:center}
    .aj-pclookup{flex-shrink:0;width:34px;height:34px;border-radius:7px;border:1px solid var(--border);background:var(--bg3);cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;align-self:flex-end}
    .aj-pclookup:hover{background:var(--bg4)}
    .aj-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding-top:4px}
    .aj-coming{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:220px;opacity:.45}
    .aj-coming-icon{font-size:36px}
    .aj-coming-txt{font-size:13px;font-weight:600;color:var(--text2)}
    .aj-coming-sub{font-size:11px;color:var(--text3);text-align:center}
    .aj-ins-idle{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:180px;opacity:.4}
    .aj-ins-idle-icon{font-size:32px}
    .aj-ins-idle-txt{font-size:12px;color:var(--text2);text-align:center}
    .aj-ins-loading{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text2);padding:20px;justify-content:center}
    .aj-ins-err{font-size:12px;color:var(--text3);padding:20px;text-align:center}
    .aj-ins-row{display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--border)}
    .aj-ins-row:last-child{border-bottom:none}
    .aj-ins-icon{font-size:18px;flex-shrink:0;width:22px;text-align:center;margin-top:1px}
    .aj-ins-body{flex:1;min-width:0}
    .aj-ins-lbl{font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px}
    .aj-ins-val{font-size:13px;font-weight:600;color:var(--text)}
    .aj-ins-sub{font-size:11px;color:var(--text3);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .aj-ins-muted{font-weight:400;color:var(--text2)}
    .aj-ins-warn{color:#b45309}
    .aj-ins-ok{color:#16a34a}
    .aj-ins-alert{color:#dc2626}
    @media(max-width:600px){.aj-cards{grid-template-columns:1fr}#view-add{padding:8px 4px!important}}
  `;
  document.head.appendChild(s);
}

function _renderEngChips() {
  const el = document.getElementById('aj-eng-chips');
  if (!el) return;
  if (!_addJobEngineers.length) { el.innerHTML = ''; return; }
  el.innerHTML = _addJobEngineers.map(e =>
    `<span class="aj-chip">${esc(e.name)}<button class="aj-chip-x" data-id="${esc(String(e.id))}" type="button">×</button></span>`
  ).join('');
  el.querySelectorAll('.aj-chip-x').forEach(btn => {
    btn.addEventListener('click', () => {
      _addJobEngineers = _addJobEngineers.filter(e => String(e.id) !== btn.dataset.id);
      _renderEngChips();
    });
  });
}

async function openAddJob() {
  _addJobContactId  = null;
  _addJobPropertyId = null;
  _addJobCertTypes  = new Set();
  _addJobEngineers  = [];
  _injectAddJobCSS();

  const opts = await _loadJobOptions();

  // Collect engineers from all cached weeks
  const engMap = new Map();
  Object.values(cache).forEach(lanes => {
    (Array.isArray(lanes) ? lanes : []).forEach(l => {
      if (l.engineer?.id) {
        const nm = l.engineer.name || [l.engineer.firstName, l.engineer.lastName].filter(Boolean).join(' ');
        if (nm) engMap.set(String(l.engineer.id), nm.trim());
      }
    });
  });
  const allEngineers = [...engMap.entries()].map(([id, name]) => ({id, name}));

  const trades    = opts.trades    || ['Electrical','Gas','Fire Safety','Testing & Inspection','General Maintenance','EV Charging'];
  const tradeOpts = ['<option value="">– trade –</option>',
    ...trades.map(t => `<option value="${esc(t)}">${esc(t)}</option>`)].join('');

  const slots    = opts.timeslots || ['9-11','11-1','1-3','3-5'];
  const slotOpts = ['<option value="">Any time</option>','<option value="AM">Morning (AM)</option>','<option value="PM">Afternoon (PM)</option>',
    ...slots.map(s => `<option value="${esc(s)}">${esc(s)}</option>`)].join('');

  const prioOpts = '<option value="normal">Normal</option><option value="urgent">Urgent</option><option value="certificate">Certificate</option><option value="repair">Repair</option><option value="emergency">Emergency</option><option value="low">Low</option>';

  const FALLBACK_CERTS = [
    {id:'gas-safety',name:'Gas Safety (CP12)'},{id:'eicr',name:'EICR'},
    {id:'pat',name:'PAT Testing'},{id:'fire-alarm',name:'Fire Alarm'},
    {id:'emergency-lighting',name:'Emergency Lighting'},{id:'epc',name:'EPC'},
    {id:'legionella',name:'Legionella Risk Assessment'},{id:'fire-extinguisher',name:'Fire Extinguisher Service'},
    {id:'smoke-alarm',name:'Domestic Smoke Alarm (BS 5839-6)'},{id:'fire-risk',name:'Fire Risk Assessment'},
    {id:'deic',name:'D.EIC'},
  ];
  const certTypes = (opts.certTypes && opts.certTypes.length) ? opts.certTypes : FALLBACK_CERTS;

  const ctypes    = opts.contactTypes || ['Landlord','Tenant','Owner','Letting Agent','Commercial','Other'];
  const ctypeOpts = '<option value="">— Select type —</option>' + ctypes.map(t => {
    const val = typeof t === 'string' ? t : (t.key || t.id || t.value || t.name || t.label || '');
    const lbl = typeof t === 'string' ? t : (t.label || t.name || t.key || t.id || t.value || '');
    return val ? `<option value="${esc(val)}">${esc(lbl || val)}</option>` : '';
  }).join('');

  const today = curDate || todayISO();

  const box = document.querySelector('#view-add .add-box');
  box.innerHTML = `
    <div class="aj-hdr">Add Job<span>— saves directly to portal</span></div>
    <div class="aj-cards">

      <div class="aj-card">
        <div class="aj-ch"><span class="aj-chi">🔧</span><span class="aj-cht">Job Details</span></div>
        <div class="aj-cb">
          <div class="aj-row">
            <div class="aj-fg" style="flex:2">
              <div class="aj-fl">Address</div>
              <div class="aj-drop-wrap">
                <input class="inp" id="aj-addr" placeholder="Street, Town" autocomplete="off">
                <div class="aj-drop" id="aj-addr-drop" style="display:none"></div>
              </div>
            </div>
            <div class="aj-fg" style="flex:1">
              <div class="aj-fl">Postcode</div>
              <input class="inp" id="aj-pc" placeholder="SW1A 1AA">
            </div>
            <button class="aj-pclookup" id="aj-pc-btn" type="button" title="Look up postcode">🔍</button>
          </div>
          <div class="aj-row">
            <div class="aj-fg">
              <div class="aj-fl">Trade</div>
              <select class="inp" id="aj-trade">${tradeOpts}</select>
            </div>
            <div class="aj-fg">
              <div class="aj-fl">Priority</div>
              <select class="inp" id="aj-prio">${prioOpts}</select>
            </div>
          </div>
          <div class="aj-fg">
            <div class="aj-fl">Job Title <span class="aj-req">*</span></div>
            <input class="inp" id="aj-title" placeholder="e.g. EICR Inspection, Boiler service">
          </div>
          <div class="aj-fg">
            <div class="aj-fl">Description / Invoice line</div>
            <textarea class="inp" id="aj-desc" rows="2" placeholder="Details for this job…" style="resize:vertical;min-height:44px"></textarea>
          </div>
          <div class="aj-sec">Certificate types (tick all that apply)</div>
          <div class="aj-cert-grid" id="aj-cert-grid"></div>
          <div class="aj-row">
            <div class="aj-fg">
              <div class="aj-fl">Date <span class="aj-req">*</span></div>
              <input class="inp" type="date" id="aj-date" value="${esc(today)}">
            </div>
            <div class="aj-fg">
              <div class="aj-fl">Timeslot</div>
              <select class="inp" id="aj-time">${slotOpts}</select>
            </div>
          </div>
          <div class="aj-row">
            <div class="aj-fg" style="flex:1">
              <div class="aj-fl">Amount (£)</div>
              <input class="inp" type="number" id="aj-amount" placeholder="0.00" step="0.01" min="0">
            </div>
            <div class="aj-fg" style="flex:2">
              <div class="aj-fl">Access Notes</div>
              <input class="inp" id="aj-access" placeholder="Key safe code, gate…">
            </div>
          </div>
          <div class="aj-fg">
            <div class="aj-fl">Engineer(s)</div>
            <div id="aj-eng-chips" class="aj-chips"></div>
            <div class="aj-drop-wrap">
              <input class="inp" id="aj-eng-inp" placeholder="Type to search engineer…" autocomplete="off">
              <div class="aj-drop" id="aj-eng-drop" style="display:none"></div>
            </div>
          </div>
          <div class="aj-fg">
            <div class="aj-fl">Notes</div>
            <textarea class="inp" id="aj-notes" rows="2" placeholder="Internal notes…" style="resize:vertical;min-height:44px"></textarea>
          </div>
        </div>
      </div>

      <div class="aj-right-col">
      <div class="aj-card">
        <div class="aj-ch"><span class="aj-chi">👤</span><span class="aj-cht">Client Details</span></div>
        <div class="aj-cb">
          <div class="aj-fg">
            <div class="aj-fl">Search by name, phone or email</div>
            <div class="aj-drop-wrap">
              <input class="inp" id="aj-cs-inp" type="text" placeholder="Type to find existing client…" autocomplete="off">
              <div class="aj-drop" id="aj-cs-drop" style="display:none"></div>
            </div>
          </div>
          <div id="aj-sel" style="display:none" class="aj-sel-wrap">
            <div>
              <div class="aj-sel-nm" id="aj-sel-nm"></div>
              <div class="aj-sel-sb" id="aj-sel-sb"></div>
            </div>
            <button class="aj-sel-cl" id="aj-sel-cl" type="button">✕ Clear</button>
          </div>
          <div class="aj-div">or add new client</div>
          <div class="aj-new">
            <div class="aj-new-lbl">New client</div>
            <div class="aj-row">
              <div class="aj-fg">
                <div class="aj-fl">Full Name <span class="aj-req">*</span></div>
                <input class="inp" id="aj-new-name" placeholder="Client name">
              </div>
              <div class="aj-fg">
                <div class="aj-fl">Phone</div>
                <input class="inp" id="aj-new-phone" type="tel" placeholder="07…">
              </div>
            </div>
            <div class="aj-row">
              <div class="aj-fg">
                <div class="aj-fl">Email</div>
                <input class="inp" id="aj-new-email" type="email" placeholder="email@…">
              </div>
              <div class="aj-fg">
                <div class="aj-fl">Type</div>
                <select class="inp" id="aj-new-type">${ctypeOpts}</select>
              </div>
            </div>
            <div class="aj-fg">
              <div class="aj-fl">Company (optional)</div>
              <input class="inp" id="aj-new-co" placeholder="Letting agent, company…">
            </div>
            <div class="aj-fg" id="aj-agency-row" style="display:none">
              <div class="aj-fl">Agency <span class="aj-req">*</span> <span style="font-weight:400;color:var(--text3)">(required for Agent)</span></div>
              <div class="aj-drop-wrap">
                <input class="inp" id="aj-agency-inp" type="text" placeholder="Search existing agency…" autocomplete="off">
                <div class="aj-drop" id="aj-agency-drop" style="display:none"></div>
              </div>
              <div id="aj-agency-sel" style="display:none;margin-top:6px;align-items:center;gap:8px;background:var(--bg3);padding:6px 10px;border-radius:6px;font-size:12px">
                <span style="font-size:14px">🏢</span>
                <span id="aj-agency-sel-nm" style="font-weight:600;flex:1"></span>
                <button id="aj-agency-sel-cl" type="button" style="font-size:11px;border:none;background:none;color:var(--text2);cursor:pointer;padding:0">✕</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="aj-card" id="aj-insights">
        <div class="aj-ch"><span class="aj-chi" id="aj-ins-icon">💡</span><span class="aj-cht" id="aj-ins-title">Smart Insights</span></div>
        <div class="aj-cb" id="aj-ins-body">
          <div class="aj-ins-idle">
            <div class="aj-ins-idle-icon">🔍</div>
            <div class="aj-ins-idle-txt">Select a client or property above<br>to see smart insights here</div>
          </div>
        </div>
      </div>
      </div>

    </div>
    <div class="err-msg" id="aj-err" style="display:none"></div>
    <div class="aj-footer">
      <button class="btn" id="btn-add-cancel" type="button">Cancel</button>
      <button class="btn-primary" id="btn-add-save" type="button">Add to Portal</button>
    </div>
  `;

  // Cert type checkboxes
  const cgEl = document.getElementById('aj-cert-grid');
  cgEl.innerHTML = certTypes.map(ct =>
    `<div class="aj-cert" data-id="${esc(String(ct.id))}"><div class="aj-cbx">✓</div><div class="aj-ct">${esc(ct.name)}</div></div>`
  ).join('');
  cgEl.querySelectorAll('.aj-cert').forEach(el => {
    el.addEventListener('click', () => {
      const cid = el.dataset.id;
      if (_addJobCertTypes.has(cid)) { _addJobCertTypes.delete(cid); el.classList.remove('on'); }
      else                           { _addJobCertTypes.add(cid);    el.classList.add('on'); }
    });
  });

  document.getElementById('btn-add-cancel').addEventListener('click', closeAddJob);
  document.getElementById('btn-add-save').addEventListener('click', saveJob);

  const pcBtn    = document.getElementById('aj-pc-btn');
  const pcInp    = document.getElementById('aj-pc');
  const addrInp  = document.getElementById('aj-addr');
  const addrDrop = document.getElementById('aj-addr-drop');
  pcBtn.addEventListener('click', () => _lookupPostcode(pcInp.value.trim(), addrInp, pcInp));
  pcInp.addEventListener('keydown', e => { if (e.key==='Enter') { e.preventDefault(); _lookupPostcode(pcInp.value.trim(), addrInp, pcInp); }});

  let _addrTmr = null;
  addrInp.oninput = () => {
    const q = addrInp.value.trim();
    clearTimeout(_addrTmr);
    if (q.length < 2) { addrDrop.style.display = 'none'; return; }
    _addrTmr = setTimeout(() => _searchAddress(q, addrInp, addrDrop, pcInp), 300);
  };
  addrInp.onblur = () => { setTimeout(() => { addrDrop.style.display = 'none'; }, 200); };

  const csInp  = document.getElementById('aj-cs-inp');
  const csDrop = document.getElementById('aj-cs-drop');
  csInp.oninput = () => {
    const q = csInp.value.trim();
    clearTimeout(_contactSearchTmr);
    if (q.length < 2) { csDrop.style.display = 'none'; return; }
    _contactSearchTmr = setTimeout(() => _searchContacts(q, csInp, csDrop), 320);
  };
  csInp.onblur = () => { setTimeout(() => { csDrop.style.display = 'none'; }, 200); };

  document.getElementById('aj-sel-cl').addEventListener('click', () => {
    _addJobContactId  = null;
    _addJobPropertyId = null;
    _addJobAgencyId   = null;
    document.getElementById('aj-sel').style.display = 'none';
    document.getElementById('aj-cs-inp').value = '';
    ['aj-new-name','aj-new-phone','aj-new-email','aj-new-co'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    const typeEl = document.getElementById('aj-new-type');
    if (typeEl) typeEl.selectedIndex = 0;
    const agRow = document.getElementById('aj-agency-row');
    if (agRow) agRow.style.display = 'none';
    const agSel = document.getElementById('aj-agency-sel');
    if (agSel) agSel.style.display = 'none';
    const agInp = document.getElementById('aj-agency-inp');
    if (agInp) agInp.value = '';
    _insSetHeader('💡', 'Smart Insights');
    const p = _insPanel(); if (p) p.innerHTML = '<div class="aj-ins-idle"><div class="aj-ins-idle-icon">🔍</div><div class="aj-ins-idle-txt">Select a client or property above<br>to see smart insights here</div></div>';
  });

  const engInp  = document.getElementById('aj-eng-inp');
  const engDrop = document.getElementById('aj-eng-drop');
  engInp.oninput = () => {
    const q = engInp.value.trim().toLowerCase();
    if (!q) { engDrop.style.display = 'none'; return; }
    const matches = allEngineers.filter(e =>
      e.name.toLowerCase().includes(q) && !_addJobEngineers.find(x => x.id === e.id)
    );
    if (!matches.length) {
      engDrop.innerHTML = '<div class="aj-dn">No engineers found</div>';
      engDrop.style.display = 'block';
      return;
    }
    engDrop.innerHTML = matches.map(e =>
      `<div class="aj-di" data-id="${esc(String(e.id))}" data-name="${esc(e.name)}">${esc(e.name)}</div>`
    ).join('');
    engDrop.querySelectorAll('.aj-di').forEach(item => {
      item.addEventListener('mousedown', ev => {
        ev.preventDefault();
        _addJobEngineers.push({id: item.dataset.id, name: item.dataset.name});
        _renderEngChips();
        engInp.value = '';
        engDrop.style.display = 'none';
      });
    });
    engDrop.style.display = 'block';
  };
  engInp.onblur = () => { setTimeout(() => { engDrop.style.display = 'none'; }, 200); };

  // Agency picker — shown only when Type = "agent"
  const agencyRow  = document.getElementById('aj-agency-row');
  const agencyInp  = document.getElementById('aj-agency-inp');
  const agencyDrop = document.getElementById('aj-agency-drop');
  const agencySel  = document.getElementById('aj-agency-sel');
  const agencySelNm = document.getElementById('aj-agency-sel-nm');
  const agencySelCl = document.getElementById('aj-agency-sel-cl');

  let _agencyTmr = null;

  function _showAgencyRow(show) {
    if (agencyRow) agencyRow.style.display = show ? '' : 'none';
    if (!show) { _addJobAgencyId = null; if (agencyInp) agencyInp.value = ''; if (agencySel) agencySel.style.display = 'none'; if (agencyDrop) agencyDrop.style.display = 'none'; }
  }

  document.getElementById('aj-new-type')?.addEventListener('change', e => {
    _showAgencyRow(e.target.value === 'agent');
  });

  if (agencyInp) {
    agencyInp.oninput = () => {
      const q = agencyInp.value.trim();
      clearTimeout(_agencyTmr);
      if (q.length < 1) { agencyDrop.style.display = 'none'; return; }
      _agencyTmr = setTimeout(async () => {
        agencyDrop.innerHTML = '<div class="aj-dn">Searching…</div>';
        agencyDrop.style.display = 'block';
        const res = await trpcQuery('directory.contacts.list', { type: 'agency', query: q, pageSize: 8 }).catch(() => null);
        const items = res?.items || [];
        const createRow = `<div class="aj-di aj-di-create" data-create="1" data-name="${esc(q)}" style="border-top:1px solid var(--border);color:var(--red);font-weight:600">➕ Create "${esc(q)}" as new agency</div>`;
        agencyDrop.innerHTML = (items.length
          ? items.map(a => `<div class="aj-di" data-id="${esc(String(a.id))}" data-name="${esc(a.name || a.company || '')}">${esc(a.name || a.company || '')}</div>`).join('')
          : '<div class="aj-dn">No existing agencies found</div>'
        ) + createRow;

        agencyDrop.querySelectorAll('.aj-di:not(.aj-di-create)').forEach(item => {
          item.addEventListener('mousedown', ev => {
            ev.preventDefault();
            _addJobAgencyId = item.dataset.id;
            agencyInp.value = '';
            agencyDrop.style.display = 'none';
            if (agencySelNm) agencySelNm.textContent = item.dataset.name;
            if (agencySel)   agencySel.style.display = 'flex';
          });
        });

        agencyDrop.querySelector('.aj-di-create')?.addEventListener('mousedown', async ev => {
          ev.preventDefault();
          agencyDrop.innerHTML = '<div class="aj-dn">Creating agency…</div>';
          try {
            const created = await trpcMutate('directory.contacts.create', { name: q, type: 'agency' });
            _addJobAgencyId = created?.id;
            agencyInp.value = '';
            agencyDrop.style.display = 'none';
            if (agencySelNm) agencySelNm.textContent = q;
            if (agencySel)   agencySel.style.display = 'flex';
          } catch(err) {
            agencyDrop.innerHTML = '<div class="aj-dn" style="color:#f87171">Failed to create agency</div>';
          }
        });
      }, 300);
    };
    agencyInp.onblur = () => { setTimeout(() => { if (agencyDrop) agencyDrop.style.display = 'none'; }, 200); };
  }

  if (agencySelCl) {
    agencySelCl.addEventListener('click', () => {
      _addJobAgencyId = null;
      if (agencyInp)  agencyInp.value = '';
      if (agencySel)  agencySel.style.display = 'none';
    });
  }

  document.getElementById('view-add').style.display = 'flex';
}

async function _searchContacts(q, inp, drop) {
  drop.innerHTML = '<div class="aj-dn">Searching…</div>';
  drop.style.display = 'block';

  const [cRes, pRes] = await Promise.allSettled([
    trpcQuery('directory.contacts.list', { query: q, pageSize: 7 }),
    trpcQuery('properties.list',          { query: q, pageSize: 7 }),
  ]);

  const contacts   = cRes.status === 'fulfilled' ? (cRes.value?.items   || []) : [];
  const properties = pRes.status === 'fulfilled' ? (pRes.value?.items   || []) : [];

  if (!contacts.length && !properties.length) {
    drop.innerHTML = '<div class="aj-dn">No matches — fill in new client below</div>';
    return;
  }

  drop.innerHTML = '';

  if (contacts.length) {
    const hdr = document.createElement('div');
    hdr.className = 'aj-dh';
    hdr.textContent = 'Contacts';
    drop.appendChild(hdr);

    contacts.forEach(c => {
      const name = c.name || c.company || '';
      const sub  = [c.company !== name ? c.company : null, c.phone, c.email].filter(Boolean).join(' · ');
      const badge = c.type ? `<span class="aj-badge">${esc(c.type)}</span>` : '';
      const li = document.createElement('div');
      li.className = 'aj-di';
      li.innerHTML = `<div class="aj-di-nm">${esc(name)}${badge}</div>${sub ? `<div class="aj-di-sb">${esc(sub)}</div>` : ''}`;
      li.addEventListener('mousedown', e => {
        e.preventDefault();
        inp.value = '';
        _addJobContactId  = c.id || null;
        _addJobPropertyId = null;
        // Show selected badge
        const selEl = document.getElementById('aj-sel');
        const nmEl  = document.getElementById('aj-sel-nm');
        const sbEl  = document.getElementById('aj-sel-sb');
        if (nmEl) nmEl.textContent = name;
        if (sbEl) sbEl.textContent = sub || (c.type || '');
        if (selEl) selEl.style.display = 'flex';
        // Fill address fields if contact has address
        const aEl = document.getElementById('aj-addr');
        const pEl = document.getElementById('aj-pc');
        if (aEl && c.address)  aEl.value = c.address;
        if (pEl && c.postcode) pEl.value = c.postcode;
        // Auto-fill new client form with real contact data
        const fName  = document.getElementById('aj-new-name');
        const fPhone = document.getElementById('aj-new-phone');
        const fEmail = document.getElementById('aj-new-email');
        const fType  = document.getElementById('aj-new-type');
        const fCo    = document.getElementById('aj-new-co');
        if (fName  && name)      fName.value  = name;
        if (fPhone && c.phone)   fPhone.value = c.phone;
        if (fEmail && c.email)   fEmail.value = c.email;
        if (fCo    && c.company && c.company !== name) fCo.value = c.company;
        if (fType && c.type) {
          // option values are now keys (lowercase), contacts store keys — direct match
          fType.value = c.type;
          if (!fType.value) { // fallback: case-insensitive search then append
            const opts = [...fType.options];
            const match = opts.find(o => o.value.toLowerCase() === c.type.toLowerCase());
            if (match) fType.value = match.value;
            else {
              const opt = document.createElement('option');
              opt.value = c.type; opt.textContent = c.type; opt.selected = true;
              fType.appendChild(opt);
            }
          }
        }
        drop.style.display = 'none';
        loadInsights('contact', c.id);
      });
      drop.appendChild(li);
    });
  }

  if (properties.length) {
    const hdr = document.createElement('div');
    hdr.className = 'aj-dh';
    hdr.textContent = 'Saved Properties';
    drop.appendChild(hdr);

    properties.forEach(p => {
      const li = document.createElement('div');
      li.className = 'aj-di';
      const sub = [p.postcode, p.contactName].filter(Boolean).join(' · ');
      li.innerHTML = `<div class="aj-di-nm">${esc(p.address || '')}</div>${sub ? `<div class="aj-di-sb">${esc(sub)}</div>` : ''}`;
      li.addEventListener('mousedown', e => {
        e.preventDefault();
        inp.value = '';
        _addJobContactId  = p.contactId || null;
        _addJobPropertyId = p.id        || null;
        // Show selected badge
        const selEl = document.getElementById('aj-sel');
        const nmEl  = document.getElementById('aj-sel-nm');
        const sbEl  = document.getElementById('aj-sel-sb');
        if (nmEl) nmEl.textContent = p.address || '';
        if (sbEl) sbEl.textContent = sub;
        if (selEl) selEl.style.display = 'flex';
        // Fill address fields
        const aEl = document.getElementById('aj-addr');
        const pEl = document.getElementById('aj-pc');
        if (aEl) aEl.value = p.address  || '';
        if (pEl) pEl.value = p.postcode || '';
        // Fill client name from property contact
        const fName = document.getElementById('aj-new-name');
        if (fName && p.contactName) fName.value = p.contactName;
        drop.style.display = 'none';
        if (p.id) loadInsights('property', p.id);
        else if (p.contactId) loadInsights('contact', p.contactId);
      });
      drop.appendChild(li);
    });
  }
}

// ── Smart Insights Panel ──────────────────────────────────────────────────────

function _insPanel() { return document.getElementById('aj-ins-body'); }

function _insSetHeader(icon, title) {
  const ic = document.getElementById('aj-ins-icon');
  const ti = document.getElementById('aj-ins-title');
  if (ic) ic.textContent = icon;
  if (ti) ti.textContent = title;
}

function _insRenderRows(panel, rows) {
  panel.innerHTML = rows.map(r => `
    <div class="aj-ins-row">
      <div class="aj-ins-icon">${r.icon}</div>
      <div class="aj-ins-body">
        <div class="aj-ins-lbl">${r.label}</div>
        <div class="aj-ins-val">${r.value}</div>
        ${r.sub ? `<div class="aj-ins-sub">${r.sub}</div>` : ''}
      </div>
    </div>`).join('');
}

function _daysAgoStr(isoDate) {
  if (!isoDate) return null;
  const d = Math.round((Date.now() - new Date(isoDate).getTime()) / 86400000);
  if (d < 0) return 'In the future';
  if (d === 0) return 'Today';
  if (d === 1) return 'Yesterday';
  if (d < 30)  return `${d}d ago`;
  if (d < 365) return `${Math.round(d/30)}mo ago`;
  return `${Math.round(d/365)}yr ago`;
}

function _daysFromNowStr(isoDate) {
  if (!isoDate) return null;
  const d = Math.round((new Date(isoDate).getTime() - Date.now()) / 86400000);
  if (d < 0) return { text: `Expired ${Math.abs(d)}d ago`, cls: 'aj-ins-alert' };
  if (d === 0) return { text: 'Expires today', cls: 'aj-ins-alert' };
  if (d <= 30) return { text: `Expires in ${d}d`, cls: 'aj-ins-warn' };
  if (d <= 90) return { text: `Expires in ${d}d`, cls: 'aj-ins-warn' };
  const mo = Math.round(d / 30);
  return { text: mo >= 12 ? `Expires in ${Math.round(mo/12)}yr` : `Expires in ${mo}mo`, cls: 'aj-ins-ok' };
}

function _fmtDate(iso) {
  if (!iso) return '–';
  try { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch(e) { return iso; }
}

function _certExpiryRows(jobs) {
  // slug → { label, days } mapping for the portal's cert_type_ids
  const CERT_MAP = {
    gas_safety_cp12:           { label: 'CP12 Gas Safety',   days: 365  },
    cp12:                      { label: 'CP12 Gas Safety',   days: 365  },
    gas:                       { label: 'Gas Safety',        days: 365  },
    eicr:                      { label: 'EICR',              days: 1825 },
    electrical_installation:   { label: 'EL Install',        days: 1825 },
    pat_testing:               { label: 'PAT Test',          days: 365  },
    pat:                       { label: 'PAT Test',          days: 365  },
    fire_alarm:                { label: 'Fire Alarm',        days: 365  },
    emergency_lighting:        { label: 'Emergency Lighting',days: 365  },
  };
  const seen = {};
  jobs.forEach(j => {
    const slugs = j.cert_type_ids || j.certTypeIds || j.certTypes || [];
    const d = j.scheduled_date || j.scheduledDate || j.date || '';
    if (!d) return;
    slugs.forEach(raw => {
      const slug = (typeof raw === 'string' ? raw : raw?.id || raw?.key || '').toLowerCase();
      const match = CERT_MAP[slug] || Object.entries(CERT_MAP).find(([k]) => slug.includes(k) || k.includes(slug))?.[1];
      if (match && (!seen[match.label] || d > seen[match.label].date)) {
        seen[match.label] = { date: d, days: match.days };
      }
    });
  });
  return Object.entries(seen).map(([label, { date, days }]) => {
    const expDate = new Date(new Date(date).getTime() + days * 86400000).toISOString().slice(0, 10);
    const exp = _daysFromNowStr(expDate);
    return {
      icon: '📜',
      label: `${label} Expiry`,
      value: `<span class="${exp.cls}">${exp.text}</span>`,
      sub: `Last done: ${_fmtDate(date)} · Expires: ${_fmtDate(expDate)}`
    };
  });
}

async function loadInsights(type, id) {
  const panel = _insPanel();
  if (!panel) return;
  panel.innerHTML = '<div class="aj-ins-loading"><div class="spinner" style="width:14px;height:14px;margin:0"></div> Loading insights…</div>';

  if (type === 'property') {
    _insSetHeader('📍', 'Property History');
    try { await _loadPropertyInsights(id, panel); } catch(e) { panel.innerHTML = '<div class="aj-ins-err">Could not load property data</div>'; }
  } else {
    _insSetHeader('👤', 'Client Summary');
    try { await _loadContactInsights(id, panel); } catch(e) { panel.innerHTML = '<div class="aj-ins-err">Could not load client data</div>'; }
  }
}

async function _loadPropertyInsights(propertyId, panel) {
  // Scan up to 6 pages (300 most recent jobs) for this property — jobs newest-first
  const pages = await Promise.allSettled(
    [0, 50, 100, 150, 200, 250].map(offset => trpcQuery('jobs.list', { pageSize: 50, offset }))
  );
  const allJobs = pages.flatMap(p => p.value?.jobs || []);
  const jobs = allJobs.filter(j => j.property_id === propertyId);

  // jobs are already newest-first from the API
  const lastJob = jobs[0] || null;
  const totalJobs = jobs.length;

  const outstanding = jobs.filter(j => (j.status || '').toLowerCase() === 'invoiced');
  const outAmt = outstanding.reduce((s, j) => s + Number(j.price || 0), 0);

  const rows = [];

  rows.push({
    icon: '🗓',
    label: 'Last Visit',
    value: lastJob
      ? `${_fmtDate(lastJob.scheduled_date)} <span class="aj-ins-muted">(${_daysAgoStr(lastJob.scheduled_date)})</span>`
      : 'No previous visits on record',
    sub: lastJob ? esc(lastJob.title || '') : ''
  });

  rows.push({
    icon: totalJobs ? '📋' : '🆕',
    label: 'Total Jobs Here',
    value: totalJobs ? `${totalJobs} job${totalJobs !== 1 ? 's' : ''} found` : 'First job at this address',
    sub: ''
  });

  rows.push({
    icon: outstanding.length ? '💳' : '✅',
    label: 'Outstanding Balance',
    value: outstanding.length
      ? `<span class="aj-ins-warn">£${outAmt.toFixed(2)} <span class="aj-ins-muted">(${outstanding.length} unpaid invoice${outstanding.length !== 1 ? 's' : ''})</span></span>`
      : '<span class="aj-ins-ok">All clear ✓</span>',
    sub: ''
  });

  const certRows = _certExpiryRows(jobs);
  certRows.forEach(r => rows.push(r));
  if (!certRows.length) {
    rows.push({ icon: '📜', label: 'Certificates', value: '<span class="aj-ins-muted">No cert history found</span>', sub: '' });
  }

  _insRenderRows(panel, rows);
}

async function _loadContactInsights(contactId, panel) {
  // Step 1: find all agents under this contact (works if it's an agency; returns [] otherwise)
  const agentsRes = await trpcQuery('directory.contacts.list', { agencyId: contactId, pageSize: 50 }).catch(() => null);
  const agents    = (agentsRes?.items || []).slice(0, 9); // cap at 9 to keep API calls reasonable
  const isAgency  = agents.length > 0;
  const allIds    = [contactId, ...agents.map(a => a.id)];
  const idSet     = new Set(allIds);

  // Step 2: fetch properties + invoices for every ID, plus 3 job pages — all in parallel
  const allFetches = await Promise.allSettled([
    ...allIds.map(id => trpcQuery('properties.list', { contactId: id, pageSize: 50 })),
    ...allIds.map(id => trpcQuery('invoices.list',   { contactId: id, pageSize: 50 })),
    trpcQuery('jobs.list', { pageSize: 50, offset:   0 }),
    trpcQuery('jobs.list', { pageSize: 50, offset:  50 }),
    trpcQuery('jobs.list', { pageSize: 50, offset: 100 }),
  ]);

  const n          = allIds.length;
  const propList   = allFetches.slice(0, n).flatMap(r => r.value?.items || []);
  const invoices   = allFetches.slice(n, n * 2).flatMap(r => r.value?.items || []);
  const contactJobs= allFetches.slice(n * 2).flatMap(p => p.value?.jobs || []).filter(j => idSet.has(j.contact_id));
  const lastJob    = contactJobs[0] || null;

  // Invoice-based financials
  const unpaidInvs  = invoices.filter(i => !i.settled && Number(i.balance || 0) > 0);
  const unpaidAmt   = unpaidInvs.reduce((s, i) => s + Number(i.balance || 0), 0);
  const paidInvs    = invoices.filter(i => i.paidAt).sort((a, b) => b.paidAt.localeCompare(a.paidAt));
  const lastPaidAt  = paidInvs[0]?.paidAt || null;
  const totalInvAmt = invoices.reduce((s, i) => s + Number(i.total || 0), 0);

  const rows = [];

  // Agency context row
  if (isAgency) {
    rows.push({
      icon: '🏢',
      label: 'Agency Group',
      value: `${agents.length} agent${agents.length !== 1 ? 's' : ''} under this agency`,
      sub: agents.map(a => esc(a.name)).join(' · ')
    });
  }

  rows.push({
    icon: '🏠',
    label: isAgency ? 'Properties (all agents)' : 'Properties',
    value: propList.length ? `${propList.length} propert${propList.length !== 1 ? 'ies' : 'y'}` : 'No properties on file',
    sub: propList.slice(0, 2).map(p => esc(p.address || '')).join(' · ')
  });

  rows.push({
    icon: '🗓',
    label: isAgency ? 'Last Job (any agent)' : 'Last Job',
    value: lastJob
      ? `${_fmtDate(lastJob.scheduled_date)} <span class="aj-ins-muted">(${_daysAgoStr(lastJob.scheduled_date)})</span>`
      : '<span class="aj-ins-muted">Not in recent 150 jobs</span>',
    sub: lastJob ? esc(lastJob.title || '') : ''
  });

  rows.push({
    icon: unpaidInvs.length ? '⚠️' : '✅',
    label: isAgency ? 'Unpaid Invoices (group)' : 'Unpaid Invoices',
    value: unpaidInvs.length
      ? `<span class="aj-ins-warn">£${unpaidAmt.toFixed(2)} owed <span class="aj-ins-muted">(${unpaidInvs.length} invoice${unpaidInvs.length !== 1 ? 's' : ''})</span></span>`
      : '<span class="aj-ins-ok">No outstanding balance ✓</span>',
    sub: unpaidInvs.length
      ? unpaidInvs.slice(0, 2).map(i => `${i.invoiceNo || ''} ${i.effectiveStatus || ''} £${Number(i.balance||0).toFixed(0)}`).join(' · ')
      : ''
  });

  rows.push({
    icon: lastPaidAt ? '💚' : '❓',
    label: 'Last Payment',
    value: lastPaidAt
      ? `${_fmtDate(lastPaidAt)} <span class="aj-ins-muted">(${_daysAgoStr(lastPaidAt)})</span>`
      : '<span class="aj-ins-muted">No payments recorded</span>',
    sub: invoices.length ? `${invoices.length} invoice${invoices.length !== 1 ? 's' : ''} total · £${totalInvAmt.toFixed(2)} billed` : ''
  });

  const statusPills = contactJobs.length
    ? [...new Set(contactJobs.map(j => j.status || '').filter(Boolean))].join(' · ')
    : '';
  rows.push({
    icon: '📊',
    label: isAgency ? 'Recent Jobs (group)' : 'Recent Jobs',
    value: `<span id="aj-ins-jcount">${contactJobs.length} found in last 150 jobs</span>
            <button id="aj-ins-searchall" style="margin-left:8px;font-size:10px;padding:2px 8px;border-radius:10px;border:1px solid var(--border);background:var(--bg3);color:var(--text2);cursor:pointer;font-family:inherit;vertical-align:middle">🔍 Search all</button>`,
    sub: `<span id="aj-ins-jpills">${statusPills}</span>`
  });

  _insRenderRows(panel, rows);

  // Wire up deep-search button
  document.getElementById('aj-ins-searchall')?.addEventListener('click', async function() {
    const btn      = this;
    const countEl  = document.getElementById('aj-ins-jcount');
    const pillsEl  = document.getElementById('aj-ins-jpills');
    btn.disabled   = true;
    btn.textContent = '⏳ Searching…';
    btn.style.color = 'var(--text3)';

    let offset = 0; const pageSize = 50;
    const allFound = [...contactJobs]; // already have first 150
    let totalScanned = 150;

    // fetch from offset 150 onwards
    offset = 150;
    try {
      while (true) {
        const r = await trpcQuery('jobs.list', { pageSize, offset });
        const page = r?.jobs || [];
        if (!page.length) break;
        const matched = page.filter(j => idSet.has(j.contact_id));
        allFound.push(...matched);
        totalScanned += page.length;
        if (countEl) countEl.innerHTML = `<span style="color:var(--text3);font-size:11px">🔍 ${allFound.length} found · scanned ${totalScanned}…</span>`;
        if (page.length < pageSize) break;
        offset += pageSize;
      }
    } catch(e) {
      if (countEl) countEl.textContent = `${allFound.length} found (search interrupted)`;
      btn.remove();
      return;
    }

    // Build status breakdown
    const statusMap = {};
    allFound.forEach(j => { const s = j.status || 'unknown'; statusMap[s] = (statusMap[s] || 0) + 1; });
    const breakdown = Object.entries(statusMap)
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `${n} ${s.replace(/_/g,' ')}`)
      .join(' · ');

    if (countEl) countEl.innerHTML = `<strong>${allFound.length}</strong> jobs from ${totalScanned} scanned`;
    if (pillsEl) pillsEl.textContent = breakdown || '—';
    btn.remove();
  });
}

async function _searchAddress(q, addrInp, drop, pcInp) {
  drop.innerHTML = '<div class="aj-dn">Searching…</div>';
  drop.style.display = 'block';

  const [pRes, pcRes] = await Promise.allSettled([
    trpcQuery('properties.list', { query: q, pageSize: 8 }),
    fetch(`https://api.postcodes.io/postcodes?q=${encodeURIComponent(q)}&limit=8`).then(r => r.json()),
  ]);

  const properties = pRes.status  === 'fulfilled' ? (pRes.value?.items   || []) : [];
  const postcodes  = pcRes.status === 'fulfilled' ? (pcRes.value?.result  || []) : [];

  if (!properties.length && !postcodes.length) {
    drop.innerHTML = '<div class="aj-dn">No suggestions found</div>';
    return;
  }

  drop.innerHTML = '';

  if (properties.length) {
    const hdr = document.createElement('div');
    hdr.className = 'aj-dh';
    hdr.textContent = 'Saved Addresses';
    drop.appendChild(hdr);
    properties.forEach(p => {
      const li  = document.createElement('div');
      li.className = 'aj-di';
      const sub = [p.postcode, p.contactName].filter(Boolean).join(' · ');
      li.innerHTML = `<div class="aj-di-nm">${esc(p.address || '')}</div>${sub ? `<div class="aj-di-sb">${esc(sub)}</div>` : ''}`;
      li.addEventListener('mousedown', e => {
        e.preventDefault();
        addrInp.value = p.address || '';
        if (p.postcode && pcInp) pcInp.value = p.postcode;
        if (p.contactId) { _addJobContactId = p.contactId; _addJobPropertyId = p.id || null; }
        drop.style.display = 'none';
      });
      drop.appendChild(li);
    });
  }

  if (postcodes.length) {
    const hdr = document.createElement('div');
    hdr.className = 'aj-dh';
    hdr.textContent = 'UK Postcodes';
    drop.appendChild(hdr);
    postcodes.forEach(pc => {
      const li  = document.createElement('div');
      li.className = 'aj-di';
      const loc = [pc.admin_ward, pc.admin_district].filter(Boolean).join(', ');
      li.innerHTML = `<div class="aj-di-nm">${esc(pc.postcode)}</div>${loc ? `<div class="aj-di-sb">${esc(loc)}</div>` : ''}`;
      li.addEventListener('mousedown', e => {
        e.preventDefault();
        if (pcInp) pcInp.value = pc.postcode;
        drop.style.display = 'none';
      });
      drop.appendChild(li);
    });
  }
}

async function _lookupPostcode(pc, addrInp, pcInp) {
  const clean = pc.replace(/\s+/g, '').toUpperCase();
  if (clean.length < 3) return;
  const btn = document.getElementById('aj-pc-btn');
  if (btn) { btn.textContent = '⏳'; btn.disabled = true; }
  try {
    const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(clean)}`);
    const d = await r.json();
    if (d.status === 200 && d.result) {
      if (pcInp) pcInp.value = d.result.postcode;
      if (addrInp && !addrInp.value) {
        const loc = [d.result.admin_ward, d.result.admin_district].filter(Boolean).join(', ');
        if (loc) addrInp.placeholder = loc;
      }
    } else {
      const r2 = await fetch(`https://api.postcodes.io/postcodes?q=${encodeURIComponent(clean)}&limit=5`);
      const d2 = await r2.json();
      if (d2.result?.length) {
        const errEl = document.getElementById('aj-err');
        if (errEl) { errEl.textContent = 'Did you mean: ' + d2.result.map(x => x.postcode).join(', ') + '?'; errEl.style.display = 'block'; }
      }
    }
  } catch(e) { /* network error, ignore */ }
  finally {
    if (btn) { btn.textContent = '🔍'; btn.disabled = false; }
  }
}

async function saveJob() {
  const errEl = document.getElementById('aj-err');
  if (errEl) errEl.style.display = 'none';
  const _err = msg => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };

  const address  = document.getElementById('aj-addr')?.value.trim()      || '';
  const postcode = document.getElementById('aj-pc')?.value.trim()        || '';
  const title    = document.getElementById('aj-title')?.value.trim()     || '';
  const desc     = document.getElementById('aj-desc')?.value.trim()      || '';
  const trade    = document.getElementById('aj-trade')?.value            || '';
  const priority = document.getElementById('aj-prio')?.value             || 'normal';
  const date     = document.getElementById('aj-date')?.value             || '';
  const time     = document.getElementById('aj-time')?.value             || '';
  const amount   = document.getElementById('aj-amount')?.value           || '';
  const access   = document.getElementById('aj-access')?.value.trim()    || '';
  const notes    = document.getElementById('aj-notes')?.value.trim()     || '';
  const newName  = document.getElementById('aj-new-name')?.value.trim()  || '';
  const newPhone = document.getElementById('aj-new-phone')?.value.trim() || '';
  const newEmail = document.getElementById('aj-new-email')?.value.trim() || '';
  const newType  = document.getElementById('aj-new-type')?.value         || '';
  const newCo    = document.getElementById('aj-new-co')?.value.trim()    || '';

  if (!title) { _err('Job Title is required'); return; }
  if (!date)  { _err('Date is required'); return; }

  const certArr  = [..._addJobCertTypes];

  const btn = document.getElementById('btn-add-save');
  if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
  try {
    // Step 1: resolve or create contact (portal requires contactId)
    let contactId = _addJobContactId || null;
    if (!contactId && newName) {
      if (btn) btn.textContent = 'Creating contact…';
      const c = await trpcMutate('directory.contacts.create', {
        name: newName,
        ...(newPhone          ? {phone:    newPhone}          : {}),
        ...(newEmail          ? {email:    newEmail}          : {}),
        ...(newType           ? {type:     newType}           : {}),
        ...(newCo             ? {company:  newCo}             : {}),
        ...(_addJobAgencyId   ? {agencyId: _addJobAgencyId}   : {}),
      });
      contactId = c?.id;
    }
    if (!contactId) { _err('Client name is required'); if (btn) { btn.disabled = false; btn.textContent = 'Add to Portal'; } return; }

    // Step 2: resolve or create property (portal requires propertyId)
    let propertyId = _addJobPropertyId || null;
    if (!propertyId && (address || postcode)) {
      if (btn) btn.textContent = 'Creating property…';
      const p = await trpcMutate('properties.create', {
        ...(address  ? {address}  : {}),
        ...(postcode ? {postcode} : {}),
        contactId,
      });
      propertyId = p?.id;
    }
    if (!propertyId) { _err('Address is required'); if (btn) { btn.disabled = false; btn.textContent = 'Add to Portal'; } return; }

    // Step 3: create the job
    if (btn) btn.textContent = 'Adding…';
    const job = await trpcMutate('jobs.create', {
      title,
      scheduledDate: date,
      propertyId,
      contactId,
      ...(trade                 ? {trade}                                    : {}),
      ...(priority              ? {priority}                                 : {}),
      ...(amount                ? {price: parseFloat(amount)}                : {}),
      ...(access                ? {accessNotes: access}                      : {}),
      ...(notes                 ? {notes}                                    : {}),
      ...(_addJobEngineers.length ? {engineerId: _addJobEngineers[0].id}    : {}),
    });
    const jobId = job?.id;
    if (!jobId) throw new Error('No job ID returned');

    // Step 4: update fields the create endpoint ignores
    const updateFields = {};
    if (time)           updateFields.timeslot    = time;
    if (certArr.length) updateFields.certTypeIds = certArr;
    if (desc)           updateFields.description = desc;
    updateFields.confirmed = true;
    await trpcMutate('jobs.update', { id: jobId, ...updateFields });

    closeAddJob();
    clearCache();
    await switchView(view);
    setStatus('Job added ✓');
  } catch(e) {
    _err('Failed: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Add to Portal'; }
  }
}

function closeAddJob() {
  _addJobContactId  = null;
  _addJobPropertyId = null;
  _addJobCertTypes  = new Set();
  _addJobEngineers  = [];
  document.getElementById('view-add').style.display = 'none';
}

// ── Login / Logout ────────────────────────────────────────────────────────────

async function tryLogin() {
  const email = document.getElementById('inp-email').value.trim();
  const pass  = document.getElementById('inp-pass').value;
  const errEl = document.getElementById('login-err');
  const btn   = document.getElementById('btn-login');
  if (!email||!pass) { showErr(errEl,'Enter email and password'); return; }
  btn.disabled=true; btn.textContent='Signing in…'; errEl.style.display='none';
  try {
    const res  = await api.login(email, pass);
    user       = res?.user || res;
    setUser(user?.name||user?.email||email);
    await store.set({savedEmail: email});
    const d = new Date();
    curDate  = todayISO();
    curWeek  = mondayOf(curDate);
    curMonth = {year:d.getFullYear(), month:d.getMonth()+1};
    await switchView('day');
    startAutoRefresh();
  } catch(e) {
    showErr(errEl, e.message||'Login failed');
    btn.disabled=false; btn.textContent='Sign In';
  }
}

async function logout() {
  stopAutoRefresh();
  try { await api.logout(); } catch {}
  user=null; clearCache(); engColors={}; colorIdx=0;
  showView('login');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function showErr(el, msg) { el.textContent=msg; el.style.display='block'; }
function now() { return new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}); }
function err(msg) { return `<div class="loading-row" style="color:#f87171">⚠ ${esc(msg)}</div>`; }
function isoOf(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  // Restore theme
  try { if (localStorage.getItem('gb-theme')==='light') isDark=false; } catch {}
  applyTheme();

  // Wire theme buttons
  ['week-theme','day-theme','month-theme','inv-theme-btn','stmt-theme-btn'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', toggleTheme);
  });

  // Wire view switch buttons
  document.querySelectorAll('.vbtn').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));

  // Login
  document.getElementById('btn-login').addEventListener('click', tryLogin);
  document.getElementById('inp-pass').addEventListener('keydown', e => { if (e.key==='Enter') tryLogin(); });
  document.getElementById('inp-email').addEventListener('keydown', e => { if (e.key==='Enter') document.getElementById('inp-pass').focus(); });

  // Restore saved email
  const saved = await store.get(['savedEmail']);
  if (saved.savedEmail) document.getElementById('inp-email').value = saved.savedEmail;

  // Week nav
  document.getElementById('week-prev').addEventListener('click', async () => { curWeek=addDays(curWeek,-7); await loadWeek(); });
  document.getElementById('week-next').addEventListener('click', async () => { curWeek=addDays(curWeek,7);  await loadWeek(); });
  document.getElementById('week-today').addEventListener('click', async () => { curDate=todayISO(); curWeek=mondayOf(curDate); await loadWeek(); });
  document.getElementById('week-refresh').addEventListener('click', async () => { clearCache(); await loadWeek(true); });
  document.getElementById('week-logout').addEventListener('click', logout);
  document.getElementById('week-add').addEventListener('click', openAddJob);

  // Day nav
  document.getElementById('day-prev').addEventListener('click', async () => { curDate=addDays(curDate,-1); await loadDay(); });
  document.getElementById('day-next').addEventListener('click', async () => { curDate=addDays(curDate,1);  await loadDay(); });
  document.getElementById('day-today').addEventListener('click', async () => { curDate=todayISO(); await loadDay(); });
  document.getElementById('day-refresh').addEventListener('click', async () => { clearCache(); await loadDay(true); });
  document.getElementById('day-logout').addEventListener('click', logout);
  document.getElementById('day-add').addEventListener('click', openAddJob);

  // Month nav
  document.getElementById('month-prev').addEventListener('click', async () => {
    curMonth.month--; if(curMonth.month<1){curMonth.month=12;curMonth.year--;} await loadMonth();
  });
  document.getElementById('month-next').addEventListener('click', async () => {
    curMonth.month++; if(curMonth.month>12){curMonth.month=1;curMonth.year++;} await loadMonth();
  });
  document.getElementById('month-today').addEventListener('click', async () => {
    const d=new Date(); curMonth={year:d.getFullYear(),month:d.getMonth()+1}; await loadMonth();
  });
  document.getElementById('month-refresh').addEventListener('click', async () => { clearCache(); await loadMonth(true); });
  document.getElementById('month-logout').addEventListener('click', logout);
  document.getElementById('month-add').addEventListener('click', openAddJob);

  // Invoices view
  document.getElementById('inv-back-btn')?.addEventListener('click', () => switchView('day'));
  document.getElementById('inv-refresh-btn')?.addEventListener('click', () => _loadInvoices(false));
  document.getElementById('inv-logout-btn')?.addEventListener('click', logout);

  // Statements view
  document.getElementById('stmt-back-btn')?.addEventListener('click', () => switchView('day'));
  document.getElementById('stmt-print-btn')?.addEventListener('click', () => window.print());
  document.getElementById('stmt-logout-btn')?.addEventListener('click', logout);

  // Add job overlay
  document.getElementById('btn-add-cancel').addEventListener('click', closeAddJob);
  document.getElementById('btn-add-save').addEventListener('click', saveJob);

  // Quotation builder
  document.getElementById('qb-close')?.addEventListener('click', closeQuotationBuilder);

  // Global search
  document.querySelectorAll('.gs-open-btn').forEach(btn => btn.addEventListener('click', openGlobalSearch));
  const gsInput = document.getElementById('gs-input');
  if (gsInput) {
    gsInput.addEventListener('input', () => {
      const q = gsInput.value.trim();
      clearTimeout(_gSearchTimer);
      if (q.length < 2) {
        const r = document.getElementById('gs-results');
        if (r) r.innerHTML = '<div class="gsearch-hint">Start typing to search all jobs…</div>';
        return;
      }
      _gSearchTimer = setTimeout(() => _doGlobalSearch(q), 400);
    });
    gsInput.addEventListener('keydown', e => { if (e.key === 'Escape') closeGlobalSearch(); });
  }
  document.getElementById('gs-close')?.addEventListener('click', closeGlobalSearch);
  document.getElementById('global-search-overlay')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeGlobalSearch();
  });

  // Auto-restore session
  showView('login');
  try {
    const me = await api.me();
    if (me?.user||me?.id||me?.email) {
      user = me?.user||me;
      setUser(user?.name||user?.email||'Logged in');
      const d = new Date();
      curDate  = todayISO();
      curWeek  = mondayOf(curDate);
      curMonth = {year:d.getFullYear(), month:d.getMonth()+1};
      await switchView('day');
      startAutoRefresh();
    }
  } catch { /* show login */ }
}

// ── GEMINI FULL-QUOTE GENERATOR ───────────────────────────────────────────────

async function _qbGeminiGenerateQuote(jobContext, apiKey) {
  const prompt = `You are helping GB Electrical write a professional client quotation. Based on the job details below, generate a complete set of line items. Each item should have a clear professional description, a quantity (usually 1), and a realistic UK market price in GBP. Return ONLY a JSON array in this exact format, no other text:\n[{"description":"Work description","qty":1,"unit_price":250.00}]\n\nJob details:\n${jobContext}`;
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    }
  );
  if (!resp.ok) {
    const ed = await resp.json().catch(() => ({}));
    throw new Error(ed?.error?.message || `HTTP ${resp.status}`);
  }
  const data = await resp.json();
  const raw  = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '[]';
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((l, i) => ({
      position: i + 1,
      description: String(l.description || ''),
      qty: Number(l.qty) || 1,
      unit_price: Number(l.unit_price) || 0,
    })) : null;
  } catch { return null; }
}

// ── GLOBAL SEARCH ─────────────────────────────────────────────────────────────

let _gSearchTimer = null;

function openGlobalSearch() {
  const overlay = document.getElementById('global-search-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  setTimeout(() => document.getElementById('gs-input')?.focus(), 50);
}

function closeGlobalSearch() {
  const overlay = document.getElementById('global-search-overlay');
  if (overlay) overlay.style.display = 'none';
  clearTimeout(_gSearchTimer);
}

async function _doGlobalSearch(q) {
  const resultsEl = document.getElementById('gs-results');
  if (!resultsEl) return;
  resultsEl.innerHTML = '<div class="gsearch-hint">Searching…</div>';
  const attempts = [
    () => trpcQuery('jobs.search',  { query: q, limit: 30 }),
    () => trpcQuery('jobs.list',    { search: q, limit: 30 }),
    () => trpcQuery('diary.search', { query: q, limit: 30 }),
    () => trpcQuery('jobs.query',   { q, limit: 30 }),
  ];
  let results = null;
  for (const fn of attempts) {
    try { results = await fn(); break; } catch(e) {
      if (e.message?.includes('404') || e.message?.includes('No procedure') || e.message?.includes('not found')) continue;
      resultsEl.innerHTML = `<div class="gsearch-hint" style="color:#ef4444">⚠ ${esc(e.message)}</div>`; return;
    }
  }
  if (!results) {
    resultsEl.innerHTML = '<div class="gsearch-hint">Search not yet available — open portal F12 to find the endpoint name</div>'; return;
  }
  const jobs = Array.isArray(results) ? results : (results?.jobs || results?.items || results?.data || []);
  if (!jobs.length) { resultsEl.innerHTML = '<div class="gsearch-hint">No results</div>'; return; }
  resultsEl.innerHTML = '';
  jobs.forEach(job => {
    const st    = jobStatus(job);
    const color = STATUS_COLORS[st] || '#888';
    const label = STATUS_LABEL[st] || st;
    const title = job.title || job.job_type || '';
    const addr  = jobAddr(job);
    const cust  = jobCustomer(job);
    const ref   = job.job_no || '';
    const row = document.createElement('div');
    row.className = 'gsearch-result';
    row.innerHTML = `
      <span class="gsearch-dot" style="background:${color}"></span>
      <div class="gsearch-info">
        <div class="gsearch-title">${esc(title||addr||'Job')} ${ref?`<span class="gsearch-ref">${esc(ref)}</span>`:''}</div>
        <div class="gsearch-sub">${esc(cust||'')}${cust&&addr?' · ':''}${esc(addr||'')}</div>
      </div>
      <span class="gsearch-badge" style="border-left:2px solid ${color};background:${color}18;color:${color}">${esc(label)}</span>`;
    row.addEventListener('click', () => { closeGlobalSearch(); openJobDetail(job.id); });
    resultsEl.appendChild(row);
  });
}

// ── INVOICE / STATEMENT STATE ─────────────────────────────────────────────────

let _invView        = 'outstanding';
let _invPage        = 1;
let _invPageSize    = 25;
let _invQuery       = '';
let _invContactType = '';
let _invSortBy      = 'dueAt';
let _invSortDir     = 'asc';
let _invAgingChip   = '';
let _invTotals      = null;
let _invItems       = [];
let _invTotal       = 0;
let _stmtContactId   = null;
let _stmtContactName = '';
let _invCSSInjected  = false;
let _invDescCache    = {};

// ── INVOICE CSS ────────────────────────────────────────────────────────────────

function _injectInvoiceCSS() {
  if (_invCSSInjected) return;
  _invCSSInjected = true;
  const s = document.createElement('style');
  s.textContent = `
    .inv-cards{display:flex;gap:8px;padding:10px 12px 0;flex-wrap:wrap}
    .inv-card{flex:1;min-width:110px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 12px}
    .inv-card-val{font-size:18px;font-weight:800;color:var(--text)}
    .inv-card-lbl{font-size:10px;color:var(--muted);margin-top:2px;text-transform:uppercase;letter-spacing:.5px}
    .inv-card.danger .inv-card-val{color:var(--red)}
    .inv-card.warn   .inv-card-val{color:#f59e0b}
    .inv-tabs{display:flex;gap:4px;padding:8px 12px 0;border-bottom:1px solid var(--border)}
    .inv-tab{padding:5px 12px;border-radius:6px 6px 0 0;font-size:12px;font-weight:600;background:none;border:1px solid transparent;border-bottom:none;color:var(--muted);cursor:pointer;transition:all .15s}
    .inv-tab.active{background:var(--surface);border-color:var(--border);color:var(--text)}
    .inv-tab:hover:not(.active){color:var(--text)}
    .inv-aging-row{display:flex;gap:6px;padding:8px 12px;flex-wrap:wrap;align-items:center}
    .inv-aging-lbl{font-size:11px;color:var(--muted);margin-right:4px}
    .inv-chip{padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;border:1px solid var(--border);background:var(--surface);color:var(--muted);cursor:pointer;transition:all .15s}
    .inv-chip:hover{border-color:var(--accent);color:var(--accent)}
    .inv-chip.active{background:var(--accent);border-color:var(--accent);color:#fff}
    .inv-filter-bar{display:flex;gap:6px;padding:0 12px 8px;align-items:center;flex-wrap:wrap}
    .inv-filter-bar input,.inv-filter-bar select{padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:12px}
    .inv-filter-bar input{flex:1;min-width:140px}
    .inv-filter-bar select{min-width:110px}
    .inv-table{width:100%;border-collapse:collapse;font-size:12px}
    .inv-table th{text-align:left;padding:6px 10px;font-size:10px;font-weight:700;color:var(--muted);border-bottom:2px solid var(--border);white-space:nowrap;position:sticky;top:0;background:var(--bg);z-index:1;text-transform:uppercase;letter-spacing:.4px}
    .inv-table th.sortable{cursor:pointer;user-select:none}
    .inv-table th.sortable:hover{color:var(--text)}
    .inv-row td{padding:7px 10px;border-bottom:1px solid var(--border);vertical-align:middle}
    .inv-row:hover td{background:var(--surface)}
    .inv-row{cursor:pointer;transition:background .1s}
    .inv-row.st-overdue td{background:rgba(239,68,68,.05)}
    .inv-row.st-overdue:hover td{background:rgba(239,68,68,.1)}
    .inv-row.st-paid td{background:rgba(34,197,94,.04)}
    .inv-row.st-paid:hover td{background:rgba(34,197,94,.08)}
    .inv-row.st-draft td{opacity:.7}
    .inv-badge{display:inline-block;padding:2px 7px;border-radius:10px;font-size:10px;font-weight:700;white-space:nowrap}
    .inv-badge.overdue{background:rgba(239,68,68,.15);color:#ef4444}
    .inv-badge.paid{background:rgba(34,197,94,.15);color:#16a34a}
    .inv-badge.draft{background:rgba(148,163,184,.15);color:#64748b}
    .inv-badge.current{background:rgba(59,130,246,.12);color:#3b82f6}
    .inv-badge.void{background:rgba(148,163,184,.1);color:#94a3b8;text-decoration:line-through}
    .inv-age{font-size:10px;padding:1px 5px;border-radius:8px;font-weight:600}
    .inv-age.age0{background:#fef9c3;color:#854d0e}
    .inv-age.age1{background:#fed7aa;color:#9a3412}
    .inv-age.age2{background:#fecaca;color:#b91c1c}
    .inv-detail-row{display:none}
    .inv-detail-row.open{display:table-row}
    .inv-detail-cell{padding:10px 16px 14px 32px;background:var(--surface);border-bottom:2px solid var(--border)}
    .inv-detail-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px 16px;margin-bottom:10px}
    .inv-detail-item{font-size:11px}
    .inv-detail-item span:first-child{color:var(--muted);display:block;font-size:10px}
    .inv-pay-history{margin-top:8px}
    .inv-pay-history-title{font-size:10px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px}
    .inv-pay-row{display:flex;gap:10px;font-size:11px;padding:3px 0;border-bottom:1px solid var(--border)}
    .inv-pay-row:last-child{border:none}
    .inv-detail-actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
    .inv-act-btn{padding:5px 12px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:11px;font-weight:600;cursor:pointer;transition:all .15s;text-decoration:none;display:inline-block}
    .inv-act-btn:hover{border-color:var(--accent);color:var(--accent)}
    .inv-act-btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
    .inv-act-btn.primary:hover{opacity:.85}
    .inv-pager{display:flex;align-items:center;gap:8px;padding:10px 12px;justify-content:center}
    .inv-pager button{padding:4px 12px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:12px;cursor:pointer}
    .inv-pager button:disabled{opacity:.35;cursor:default}
    .inv-pager-info{font-size:11px;color:var(--muted)}
    .inv-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:flex;align-items:center;justify-content:center}
    .inv-modal{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;width:320px;max-width:90vw}
    .inv-modal h3{margin:0 0 14px;font-size:15px}
    .inv-modal label{display:block;font-size:11px;color:var(--muted);margin-bottom:3px}
    .inv-modal input,.inv-modal select{width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px;margin-bottom:10px;box-sizing:border-box}
    .inv-modal-btns{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}
    .inv-modal-btns button{padding:7px 16px;border-radius:7px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:12px;font-weight:600;cursor:pointer}
    .inv-modal-btns .primary{background:var(--accent);border-color:var(--accent);color:#fff}
    .inv-chase-section{margin-top:12px;border-top:1px solid var(--border);padding-top:10px}
    .inv-chase-header{font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px}
    .inv-chase-note{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:6px}
    .inv-chase-meta{display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-bottom:4px}
    .inv-chase-meta strong{color:var(--text);font-weight:600}
    .inv-chase-text{font-size:12px;line-height:1.45;white-space:pre-wrap}
    .inv-chase-form{display:flex;gap:8px;margin-top:8px;align-items:flex-start}
    .inv-chase-input{flex:1;padding:7px 9px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:12px;font-family:inherit;resize:vertical;min-height:52px}
    .inv-chase-input:focus{outline:none;border-color:var(--accent)}
    .stmt-search-wrap{padding:14px 12px 6px}
    .stmt-search-wrap .inp{width:100%;box-sizing:border-box}
    .stmt-contact-drop{background:var(--surface);border:1px solid var(--border);border-radius:6px;max-height:200px;overflow-y:auto;margin-top:4px}
    .stmt-cd-item{padding:8px 12px;font-size:13px;cursor:pointer}
    .stmt-cd-item:hover{background:var(--bg)}
    .stmt-cd-sub{font-size:10px;color:var(--muted)}
    .stmt-cards{display:flex;gap:8px;padding:8px 12px;flex-wrap:wrap}
    .stmt-card{flex:1;min-width:110px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 12px}
    .stmt-card-val{font-size:16px;font-weight:800;color:var(--text)}
    .stmt-card-lbl{font-size:10px;color:var(--muted);margin-top:2px;text-transform:uppercase;letter-spacing:.5px}
    .stmt-card.danger .stmt-card-val{color:var(--red)}
    .stmt-card.ok .stmt-card-val{color:#16a34a}
    .stmt-aging-row{display:flex;gap:6px;padding:4px 12px 8px;flex-wrap:wrap;align-items:center}
    .stmt-timeline{width:100%;border-collapse:collapse;font-size:12px}
    .stmt-timeline th{text-align:left;padding:6px 10px;font-size:10px;color:var(--muted);border-bottom:2px solid var(--border);position:sticky;top:0;background:var(--bg);z-index:1;text-transform:uppercase;letter-spacing:.4px;font-weight:700}
    .stmt-row td{padding:7px 10px;border-bottom:1px solid var(--border)}
    .stmt-row.inv-row-type td{background:rgba(239,68,68,.04)}
    .stmt-row.pay-row-type td{background:rgba(34,197,94,.04)}
    .stmt-row:hover td{filter:brightness(.97)}
    .stmt-bal-col{font-weight:700;text-align:right;white-space:nowrap}
    .stmt-bal-pos{color:#16a34a}
    .stmt-bal-neg{color:var(--red)}
    .stmt-type-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;vertical-align:middle}
    .stmt-type-dot.inv{background:#ef4444}
    .stmt-type-dot.pay{background:#22c55e}
    @media print{
      #view-statements .app-header,.stmt-search-wrap,.stmt-aging-row{display:none!important}
      #view-statements{display:block!important;overflow:visible!important}
      #stmt-body{overflow:visible!important}
    }
  `;
  document.head.appendChild(s);
}

// ── INVOICE HELPERS ────────────────────────────────────────────────────────────

function _invFmt(pounds) {
  if (pounds == null) return '—';
  return '£' + (pounds).toLocaleString('en-GB', {minimumFractionDigits:2, maximumFractionDigits:2});
}
function _invFmtPence(pence) {
  if (pence == null) return '—';
  return '£' + (pence / 100).toLocaleString('en-GB', {minimumFractionDigits:2, maximumFractionDigits:2});
}

function _invAgingInfo(dueAt) {
  if (!dueAt) return { pill:'', pillCls:'', bucket:'' };
  const days = Math.floor((Date.now() - new Date(dueAt).getTime()) / 86400000);
  if (days < 0) return { pill:'', pillCls:'', bucket:'' };
  if (days <= 30) return { pill:`${days}d`, pillCls:'age0', bucket:'0-30' };
  if (days <= 60) return { pill:`${days}d`, pillCls:'age1', bucket:'31-60' };
  return { pill:`${days}d`, pillCls:'age2', bucket:'60+' };
}

function _invAgingFilter(item) {
  if (!_invAgingChip) return true;
  if (item.effectiveStatus !== 'overdue') return false;
  return _invAgingInfo(item.dueAt).bucket === _invAgingChip;
}

function _invStatusBadge(status) {
  const labels = { overdue:'Overdue', paid:'Paid', draft:'Draft', void:'Void', current:'Outstanding' };
  const cls = { overdue:'overdue', paid:'paid', draft:'draft', void:'void', current:'current' }[status] || 'current';
  return `<span class="inv-badge ${cls}">${labels[status] || status}</span>`;
}

// ── INVOICES VIEW ──────────────────────────────────────────────────────────────

async function openInvoices() {
  _injectInvoiceCSS();
  showView('invoices');
  await _loadInvoices(true);
}

async function _loadInvoices(resetPage = false) {
  if (resetPage) _invPage = 1;
  const bodyEl = document.getElementById('inv-body');
  const topEl  = document.getElementById('inv-top');
  if (bodyEl) bodyEl.innerHTML = '<div class="loading-row"><div class="spinner"></div>Loading invoices…</div>';

  const [totals, list] = await Promise.all([
    trpcQuery('invoices.totals', {}).catch(() => null),
    trpcQuery('invoices.list', {
      view:        _invView,
      page:        _invPage,
      pageSize:    _invPageSize,
      sortBy:      _invSortBy,
      sortDir:     _invSortDir,
      ..._invQuery       ? { query:       _invQuery       } : {},
      ..._invContactType ? { contactType: _invContactType } : {},
    }).catch(() => null),
  ]);

  _invTotals = totals;
  _invItems  = list?.invoices || list?.items || [];
  _invTotal  = list?.total ?? _invItems.length;

  // Render immediately — descriptions fill in the background
  _renderInvoicePage();

  // Fetch line-item descriptions in background (non-blocking), update cells as they arrive
  _invItems.forEach(async inv => {
    if (_invDescCache[inv.id] !== undefined) return;
    try {
      const detail = await trpcQuery('invoices.get', { invoiceId: inv.id });
      const lineItems = detail?.items || [];
      const desc = lineItems.map(li => li.description).filter(Boolean).join(' • ');
      _invDescCache[inv.id] = { desc: desc || inv.notes || '', lineItems };
    } catch(e) {
      _invDescCache[inv.id] = { desc: inv.notes || '', lineItems: [] };
    }
    // Update the description cell in the DOM directly
    const cell = document.querySelector(`[data-desc-id="${inv.id}"]`);
    if (cell) cell.textContent = _invDescCache[inv.id].desc || '—';
  });
}

function _renderInvoicePage() {
  const topEl  = document.getElementById('inv-top');
  const bodyEl = document.getElementById('inv-body');
  if (topEl)  topEl.innerHTML  = _buildInvTopHTML();
  if (bodyEl) bodyEl.innerHTML = _buildInvBodyHTML();
  _wireInvControls();
}

function _buildInvTopHTML() {
  const t = _invTotals || {};
  const tabs = [
    { key:'outstanding', label:'Outstanding' },
    { key:'overdue',     label:'Overdue'     },
    { key:'all',         label:'All'         },
    { key:'draft',       label:'Drafts'      },
    { key:'paid',        label:'Paid'        },
  ];
  const tabsHTML = tabs.map(tab =>
    `<button class="inv-tab${_invView===tab.key?' active':''}" data-invtab="${tab.key}">${tab.label}</button>`
  ).join('');

  const chips = [
    { key:'0-30',  label:'1–30 days' },
    { key:'31-60', label:'31–60 days' },
    { key:'60+',   label:'60+ days'  },
  ];
  const chipsHTML = (_invView === 'overdue')
    ? `<div class="inv-aging-row">
        <span class="inv-aging-lbl">Age:</span>
        ${chips.map(c=>`<button class="inv-chip${_invAgingChip===c.key?' active':''}" data-agechip="${c.key}">${c.label}</button>`).join('')}
        ${_invAgingChip?`<button class="inv-chip" data-agechip="">All ages</button>`:''}
       </div>`
    : '';

  const ctypes  = ['','landlord','agency','agent','developer'];
  const ctLabel = { '':'All contacts', landlord:'Landlord', agency:'Agency', agent:'Agent', developer:'Developer' };
  const ctSel   = ctypes.map(v=>`<option value="${v}"${_invContactType===v?' selected':''}>${ctLabel[v]}</option>`).join('');

  const sorts = [
    { val:'dueAt|asc',   label:'Due ↑'      },
    { val:'dueAt|desc',  label:'Due ↓'      },
    { val:'total|desc',  label:'Amount ↓'   },
    { val:'total|asc',   label:'Amount ↑'   },
  ];
  const curSort  = `${_invSortBy}|${_invSortDir}`;
  const sortSel  = sorts.map(s=>`<option value="${s.val}"${curSort===s.val?' selected':''}>${s.label}</option>`).join('');

  return `
    <div class="inv-cards">
      <div class="inv-card danger">
        <div class="inv-card-val">${_invFmtPence(t.owedPence)}</div>
        <div class="inv-card-lbl">Total owed</div>
      </div>
      <div class="inv-card warn">
        <div class="inv-card-val">${t.overdue ?? '—'}</div>
        <div class="inv-card-lbl">Overdue</div>
      </div>
      <div class="inv-card">
        <div class="inv-card-val">${t.drafts ?? '—'}</div>
        <div class="inv-card-lbl">Drafts</div>
      </div>
    </div>
    <div class="inv-tabs">${tabsHTML}</div>
    ${chipsHTML}
    <div class="inv-filter-bar">
      <input type="text" id="inv-search" placeholder="Search invoice, contact…" value="${esc(_invQuery)}">
      <select id="inv-ct">${ctSel}</select>
      <select id="inv-sort">${sortSel}</select>
    </div>
  `;
}

function _buildInvBodyHTML() {
  const items = _invItems.filter(_invAgingFilter);
  const totalPages = Math.max(1, Math.ceil(_invTotal / _invPageSize));

  if (!items.length) {
    return `<div style="padding:40px;text-align:center;color:var(--muted);font-size:13px">No invoices found</div>`;
  }

  const rows = items.map((inv, idx) => {
    const status = inv.effectiveStatus || (inv.settled ? 'paid' : (inv.dueAt && new Date(inv.dueAt) < new Date()) ? 'overdue' : 'current');
    const aging  = status === 'overdue' ? _invAgingInfo(inv.dueAt) : { pill:'', pillCls:'' };
    const balance = inv.balance ?? ((inv.total||0) - (inv.paidAmount||0));
    const cached   = _invDescCache[inv.id];
    const descVal  = esc(cached?.desc || inv.notes || '—');
    const lineItems = cached?.lineItems || [];

    const detailHTML = `
      <div class="inv-detail-grid">
        <div class="inv-detail-item"><span>Site</span>${esc(inv.siteAddress||'—')}</div>
        <div class="inv-detail-item"><span>Contact</span>${esc(inv.contactName||'—')} <span style="font-size:10px;color:var(--muted)">(${esc(inv.contactType||'')})</span></div>
        <div class="inv-detail-item"><span>Issued</span>${inv.issuedAt?new Date(inv.issuedAt).toLocaleDateString('en-GB'):'—'}</div>
        <div class="inv-detail-item"><span>Subtotal</span>${_invFmt(inv.subtotal)}</div>
        <div class="inv-detail-item"><span>VAT (${inv.vatRate||0}%)</span>${_invFmt(inv.vatAmount)}</div>
        <div class="inv-detail-item"><span>Total</span><strong>${_invFmt(inv.total)}</strong></div>
        <div class="inv-detail-item"><span>Paid</span>${_invFmt(inv.paidAmount||0)}</div>
        <div class="inv-detail-item"><span>Balance</span><strong>${_invFmt(balance)}</strong></div>
        ${inv.notes?`<div class="inv-detail-item" style="grid-column:1/-1"><span>Notes</span>${esc(inv.notes)}</div>`:''}
      </div>
      ${lineItems.length ? `
        <div style="margin-top:8px">
          <table style="width:100%;border-collapse:collapse;font-size:11px">
            <thead><tr style="border-bottom:1px solid var(--border);color:var(--muted)">
              <th style="text-align:left;padding:4px 6px;font-weight:600">Description</th>
              <th style="text-align:right;padding:4px 6px;font-weight:600">Qty</th>
              <th style="text-align:right;padding:4px 6px;font-weight:600">Unit</th>
              <th style="text-align:right;padding:4px 6px;font-weight:600">Total</th>
            </tr></thead>
            <tbody>${lineItems.map(li=>`<tr style="border-bottom:1px solid var(--border)">
              <td style="padding:4px 6px">${esc(li.description||'')}</td>
              <td style="text-align:right;padding:4px 6px">${li.qty}</td>
              <td style="text-align:right;padding:4px 6px">${_invFmt(li.unitPrice)}</td>
              <td style="text-align:right;padding:4px 6px;font-weight:600">${_invFmt(li.lineTotal)}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
      ` : ''}
      ${inv.payments?.length ? `
        <div class="inv-pay-history">
          <div class="inv-pay-history-title">Payments (${inv.payments.length})</div>
          ${inv.payments.map(p=>`
            <div class="inv-pay-row">
              <span style="flex:1">${p.receivedAt?new Date(p.receivedAt).toLocaleDateString('en-GB'):'—'}</span>
              <span style="flex:1;color:var(--muted)">${esc(p.method||'')}</span>
              <span style="font-weight:600;color:#16a34a">${_invFmt(p.amount)}</span>
              ${p.stripePaymentRef?`<span style="font-size:10px;color:var(--muted)">${esc(p.stripePaymentRef)}</span>`:''}
            </div>
          `).join('')}
        </div>
      ` : ''}
      <div class="inv-detail-actions">
        ${status!=='paid'&&status!=='void'&&status!=='draft'?`<button class="inv-act-btn primary" data-rpay="${inv.id}" data-rbal="${balance}" data-rno="${esc(inv.invoiceNo||'')}">₤ Record Payment</button>`:''}
        ${status==='draft'?`<button class="inv-act-btn" data-issue="${inv.id}">Issue Invoice</button>`:''}
        ${inv.pdfPath?`
          <button class="inv-act-btn" data-vpdf="${inv.id}">👁 View PDF</button>
          <button class="inv-act-btn" data-dlpdf="${inv.id}" data-dlno="${esc(inv.invoiceNo||inv.id)}">⬇ Download</button>
          <button class="inv-act-btn" data-copypdf="${inv.id}">📋 Copy PDF</button>
        `:''}
      </div>
      ${inv.jobId ? `
        <div class="inv-chase-section">
          <div class="inv-chase-header">💬 Chase Notes</div>
          <div class="inv-chase-thread" data-chasejob="${inv.jobId}">
            <div style="color:var(--muted);font-size:11px">Click to expand and load notes…</div>
          </div>
          <div class="inv-chase-form">
            <textarea class="inv-chase-input" placeholder="e.g. Called SAMIR — said will pay by Friday 17th Oct…" rows="2"></textarea>
            <button class="inv-act-btn primary inv-chase-submit" data-chasejobid="${inv.jobId}">Add Note</button>
          </div>
        </div>
      ` : ''}
    `;

    return `
      <tr class="inv-row st-${status}" data-idx="${idx}" data-jobid="${esc(inv.jobId||'')}"  data-jobno="${esc(inv.jobNo||'')}"  data-cname="${esc(inv.contactName||'')}"  data-invno="${esc(inv.invoiceNo||'')}"  >
        <td style="font-weight:700;font-size:11px;white-space:nowrap">${esc(inv.invoiceNo||'—')}</td>
        <td style="font-size:11px;white-space:nowrap">${esc(inv.jobNo||'—')}</td>
        <td style="font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(inv.siteAddress||'—')}</td>
        <td data-desc-id="${inv.id}" style="font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)">${descVal}</td>
        <td style="white-space:nowrap">${inv.dueAt?new Date(inv.dueAt).toLocaleDateString('en-GB'):'—'}${aging.pill?`<span class="inv-age ${aging.pillCls}" style="margin-left:4px">${aging.pill}</span>`:''}
        </td>
        <td style="text-align:right;font-weight:700;color:${balance<=0?'#16a34a':'inherit'}">${_invFmt(balance<=0 ? (inv.total||0) : balance)}</td>
        <td>${_invStatusBadge(status)}</td>
      </tr>
      <tr class="inv-detail-row" data-detail="${idx}">
        <td class="inv-detail-cell" colspan="7">${detailHTML}</td>
      </tr>
    `;
  }).join('');

  const pager = totalPages > 1
    ? `<div class="inv-pager">
        <button id="inv-prev-page" ${_invPage<=1?'disabled':''}>← Prev</button>
        <span class="inv-pager-info">Page ${_invPage} of ${totalPages} · ${_invTotal} invoices</span>
        <button id="inv-next-page" ${_invPage>=totalPages?'disabled':''}>Next →</button>
       </div>`
    : `<div class="inv-pager"><span class="inv-pager-info">${items.length} invoices</span></div>`;

  return `
    <div style="overflow-x:auto">
      <table class="inv-table">
        <thead><tr>
          <th>Invoice #</th>
          <th>Job #</th>
          <th>Address</th>
          <th>Description</th>
          <th class="sortable" data-sort="dueAt">Due${_invSortBy==='dueAt'?(_invSortDir==='asc'?' ↑':' ↓'):''}</th>
          <th style="text-align:right">Balance</th>
          <th>Status</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${pager}
  `;
}

async function _loadChaseNotes(jobId, el) {
  el.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:4px 0">Loading notes…</div>';
  try {
    const data = await trpcQuery('jobs.get', {id: jobId});
    const notes = (data?.events || [])
      .filter(e => e.event_type === 'note')
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    if (!notes.length) {
      el.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:4px 0">No chase notes yet — add the first one below.</div>';
      return;
    }
    el.innerHTML = notes.map(n => `
      <div class="inv-chase-note">
        <div class="inv-chase-meta">
          <strong>${esc(n.actor_name || 'Unknown')}</strong>
          <span>${new Date(n.created_at).toLocaleString('en-GB', {day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})}</span>
        </div>
        <div class="inv-chase-text">${esc(n.message || '')}</div>
      </div>
    `).join('');
  } catch(err) {
    el.innerHTML = `<div style="color:var(--red);font-size:11px">Failed to load notes: ${esc(err?.message||String(err))}</div>`;
  }
}

function _wireInvControls() {
  document.querySelectorAll('[data-invtab]').forEach(btn => {
    btn.addEventListener('click', async () => {
      _invView = btn.dataset.invtab;
      _invAgingChip = '';
      await _loadInvoices(true);
    });
  });

  document.querySelectorAll('[data-agechip]').forEach(btn => {
    btn.addEventListener('click', () => {
      _invAgingChip = btn.dataset.agechip;
      _renderInvoicePage();
    });
  });

  let _invSrchTimer;
  const searchEl = document.getElementById('inv-search');
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      clearTimeout(_invSrchTimer);
      _invSrchTimer = setTimeout(async () => {
        _invQuery = searchEl.value.trim();
        await _loadInvoices(true);
      }, 450);
    });
  }

  const ctEl = document.getElementById('inv-ct');
  if (ctEl) ctEl.addEventListener('change', async () => { _invContactType = ctEl.value; await _loadInvoices(true); });

  const sortEl = document.getElementById('inv-sort');
  if (sortEl) sortEl.addEventListener('change', async () => {
    const [by, dir] = sortEl.value.split('|');
    _invSortBy = by; _invSortDir = dir;
    await _loadInvoices(true);
  });

  document.querySelectorAll('.inv-table th.sortable').forEach(th => {
    th.addEventListener('click', async () => {
      const col = th.dataset.sort;
      if (_invSortBy === col) { _invSortDir = _invSortDir === 'asc' ? 'desc' : 'asc'; }
      else { _invSortBy = col; _invSortDir = 'asc'; }
      await _loadInvoices(false);
    });
  });

  document.querySelectorAll('.inv-row').forEach(row => {
    row.addEventListener('click', async e => {
      if (e.target.closest('.inv-act-btn, a, .inv-chase-form')) return;
      const detRow = document.querySelector(`.inv-detail-row[data-detail="${row.dataset.idx}"]`);
      if (!detRow) return;
      const wasOpen = detRow.classList.contains('open');
      detRow.classList.toggle('open');
      if (!wasOpen) {
        const jobId = row.dataset.jobid;
        const threadEl = detRow.querySelector('[data-chasejob]');
        if (jobId && threadEl) _loadChaseNotes(jobId, threadEl);
      }
    });
  });

  document.querySelectorAll('.inv-chase-submit').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const jobId = btn.dataset.chasejobid;
      const form = btn.closest('.inv-chase-section');
      const textarea = form?.querySelector('.inv-chase-input');
      const text = textarea?.value?.trim();
      if (!text) return;
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        await trpcMutate('jobs.addNote', {id: jobId, text});
        textarea.value = '';
        const threadEl = form.querySelector('[data-chasejob]');
        if (threadEl) await _loadChaseNotes(jobId, threadEl);
      } catch(err) {
        alert('Failed to save note: ' + (err?.message || err));
      } finally {
        btn.disabled = false; btn.textContent = 'Add Note';
      }
    });
  });

  async function _invGetPdfUrl(invoiceId) {
    const res = await trpcQuery('invoices.pdf', { invoiceId });
    const relUrl = res?.url;
    if (!relUrl) throw new Error('No PDF URL returned');
    return {
      viewUrl:  'https://gbelectricals.co.uk' + relUrl,
      fetchUrl: 'https://gb-proxy.gbmandeep.workers.dev' + relUrl,
    };
  }

  // View PDF in new tab
  document.querySelectorAll('[data-vpdf]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = '…';
      try {
        const { viewUrl } = await _invGetPdfUrl(btn.dataset.vpdf);
        window.open(viewUrl, '_blank', 'noopener');
      } catch(err) {
        alert('Could not load PDF: ' + (err?.message || err));
      } finally {
        btn.disabled = false; btn.textContent = orig;
      }
    });
  });

  // Download PDF as file (fetch through proxy to avoid CORS)
  document.querySelectorAll('[data-dlpdf]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = '⬇ Fetching…';
      try {
        const { fetchUrl } = await _invGetPdfUrl(btn.dataset.dlpdf);
        const r = await fetch(fetchUrl, { credentials: 'include' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const blob = await r.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = (btn.dataset.dlno || 'invoice') + '.pdf';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
      } catch(err) {
        alert('Download failed: ' + (err?.message || err));
      } finally {
        btn.disabled = false; btn.textContent = orig;
      }
    });
  });

  // Copy PDF to clipboard (fetch through proxy; try blob then fall back to URL)
  document.querySelectorAll('[data-copypdf]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = '📋 Fetching…';
      try {
        const { fetchUrl, viewUrl } = await _invGetPdfUrl(btn.dataset.copypdf);
        const r = await fetch(fetchUrl, { credentials: 'include' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const blob = await r.blob();
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'application/pdf': blob })]);
          btn.textContent = '✓ PDF copied!';
        } catch {
          await navigator.clipboard.writeText(viewUrl);
          btn.textContent = '✓ Link copied';
        }
        setTimeout(() => { btn.disabled = false; btn.textContent = orig; }, 2500);
        return;
      } catch(err) {
        alert('Copy failed: ' + (err?.message || err));
        btn.disabled = false; btn.textContent = orig;
      }
    });
  });

  document.querySelectorAll('[data-rpay]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      _openRecordPayment(btn.dataset.rpay, parseInt(btn.dataset.rbal)||0, btn.dataset.rno);
    });
  });

  document.querySelectorAll('[data-issue]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      btn.disabled = true; btn.textContent = 'Issuing…';
      try {
        await trpcMutate('invoices.issue', { invoiceId: btn.dataset.issue });
        await _loadInvoices(false);
      } catch(err) {
        btn.disabled = false; btn.textContent = 'Issue Invoice';
        alert('Failed to issue: ' + (err?.message || err));
      }
    });
  });

  document.getElementById('inv-prev-page')?.addEventListener('click', async () => {
    if (_invPage > 1) { _invPage--; await _loadInvoices(false); }
  });
  document.getElementById('inv-next-page')?.addEventListener('click', async () => {
    _invPage++; await _loadInvoices(false);
  });
}

// ── RECORD PAYMENT MODAL ───────────────────────────────────────────────────────

function _openRecordPayment(invoiceId, balance, invoiceNo) {
  const today = new Date().toISOString().slice(0,10);
  const modal = document.createElement('div');
  modal.className = 'inv-modal-backdrop';
  modal.innerHTML = `
    <div class="inv-modal">
      <h3>Record Payment — ${esc(invoiceNo)}</h3>
      <label>Amount (£)</label>
      <input id="rp-amount" type="number" min="0.01" step="0.01" value="${(+balance||0).toFixed(2)}">
      <label>Method</label>
      <select id="rp-method">
        <option value="bank">Bank Transfer</option>
        <option value="cash">Cash</option>
        <option value="stripe">Stripe</option>
      </select>
      <label>Date received</label>
      <input id="rp-date" type="date" value="${today}">
      <div id="rp-err" style="color:var(--red);font-size:11px;min-height:16px"></div>
      <div class="inv-modal-btns">
        <button id="rp-cancel">Cancel</button>
        <button id="rp-save" class="primary">Save Payment</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.getElementById('rp-cancel').addEventListener('click', () => modal.remove());
  document.getElementById('rp-save').addEventListener('click', async () => {
    const amtStr  = document.getElementById('rp-amount').value.trim();
    const method  = document.getElementById('rp-method').value;
    const dateVal = document.getElementById('rp-date').value;
    const errEl   = document.getElementById('rp-err');
    const amt     = parseFloat(amtStr);
    if (!amtStr || isNaN(amt) || amt <= 0) { errEl.textContent = 'Enter a valid amount'; return; }
    if (!dateVal) { errEl.textContent = 'Enter a date'; return; }
    const saveBtn = document.getElementById('rp-save');
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      await trpcMutate('invoices.recordPayment', {
        invoiceId, method, receivedAt: dateVal,
        amount: amt,
      });
      modal.remove();
      await _loadInvoices(false);
    } catch(err) {
      saveBtn.disabled = false; saveBtn.textContent = 'Save Payment';
      errEl.textContent = err?.message || 'Failed to record payment';
    }
  });
}

// ── STATEMENTS VIEW ────────────────────────────────────────────────────────────

async function openStatements() {
  _injectInvoiceCSS();
  showView('statements');
  _renderStatementsShell();
}

function _renderStatementsShell() {
  const bodyEl = document.getElementById('stmt-body');
  if (!bodyEl) return;
  bodyEl.innerHTML = `
    <div class="stmt-search-wrap">
      <input id="stmt-contact-inp" class="inp" type="text" placeholder="Search contact (landlord, agency, agent)…" autocomplete="off">
      <div id="stmt-contact-drop" class="stmt-contact-drop" style="display:none"></div>
    </div>
    <div id="stmt-content" style="padding:0 12px">
      <div style="text-align:center;padding:60px 20px;color:var(--muted);font-size:13px">Search for a contact above to load their statement</div>
    </div>
  `;

  let _stmtSrchTimer;
  const inp  = document.getElementById('stmt-contact-inp');
  const drop = document.getElementById('stmt-contact-drop');

  inp?.addEventListener('input', () => {
    const q = inp.value.trim();
    clearTimeout(_stmtSrchTimer);
    if (q.length < 2) { drop.style.display = 'none'; return; }
    _stmtSrchTimer = setTimeout(async () => {
      const res = await trpcQuery('directory.contacts.list', { query: q, pageSize: 10 }).catch(() => null);
      const items = res?.items || res?.contacts || [];
      if (!items.length) {
        drop.innerHTML = '<div class="stmt-cd-item" style="color:var(--muted)">No contacts found</div>';
        drop.style.display = '';
        return;
      }
      drop.innerHTML = items.map(c => `
        <div class="stmt-cd-item" data-id="${esc(c.id)}" data-name="${esc(c.name||c.contactName||'')}">
          ${esc(c.name||c.contactName||'')}
          <div class="stmt-cd-sub">${esc(c.type||'')}${c.company?` · ${esc(c.company)}`:''}</div>
        </div>
      `).join('');
      drop.style.display = '';
    }, 350);
  });

  drop?.addEventListener('mousedown', async e => {
    const item = e.target.closest('.stmt-cd-item[data-id]');
    if (!item) return;
    e.preventDefault();
    _stmtContactId   = item.dataset.id;
    _stmtContactName = item.dataset.name;
    inp.value = _stmtContactName;
    drop.style.display = 'none';
    await _loadStatement(_stmtContactId, _stmtContactName);
  });

  inp?.addEventListener('blur', () => { setTimeout(() => { drop.style.display = 'none'; }, 150); });
}

async function _loadStatement(contactId, contactName) {
  const contentEl = document.getElementById('stmt-content');
  if (contentEl) contentEl.innerHTML = '<div class="loading-row"><div class="spinner"></div>Loading statement…</div>';

  const [invList, payList, totals] = await Promise.all([
    trpcQuery('invoices.list', { contactId, view:'all', pageSize:200, sortBy:'dueAt', sortDir:'asc' }).catch(() => null),
    trpcQuery('payments.list', { contactId, pageSize:200 }).catch(() => null),
    trpcQuery('invoices.totals', { contactId }).catch(() => null),
  ]);

  const invoices = invList?.invoices || invList?.items || [];
  const payments = payList?.items    || payList?.payments || [];
  _renderStatement(contactId, contactName, invoices, payments, totals);
}

function _renderStatement(contactId, contactName, invoices, payments, totals) {
  const contentEl = document.getElementById('stmt-content');
  if (!contentEl) return;

  const totalInvoiced = invoices.reduce((s,i) => s + (i.total||0), 0);
  const totalPaid     = invoices.reduce((s,i) => s + (i.paidAmount||0), 0);
  const outstanding   = totalInvoiced - totalPaid;
  const overdueInvs   = invoices.filter(i => i.effectiveStatus === 'overdue');

  const ageBuckets = { '0-30':0, '31-60':0, '60+':0 };
  overdueInvs.forEach(i => {
    const info = _invAgingInfo(i.dueAt);
    if (info.bucket) ageBuckets[info.bucket] += i.balance ?? ((i.total||0) - (i.paidAmount||0));
  });

  const timeline = [];
  invoices.forEach(inv => {
    timeline.push({ type:'invoice', date: inv.issuedAt||inv.dueAt, ref: inv.invoiceNo, desc:`Invoice ${inv.invoiceNo||''}`, site: inv.siteAddress, amount: inv.total, status: inv.effectiveStatus });
  });
  payments.forEach(pay => {
    timeline.push({ type:'payment', date: pay.receivedAt, ref: pay.invoiceNo, desc:`Payment — ${pay.method||''}`, site:'', amount: pay.amount });
  });
  timeline.sort((a,b) => (a.date?new Date(a.date).getTime():0) - (b.date?new Date(b.date).getTime():0));

  let running = 0;
  const timelineRows = timeline.map(row => {
    running += row.type === 'invoice' ? (row.amount||0) : -(row.amount||0);
    const dateStr = row.date ? new Date(row.date).toLocaleDateString('en-GB') : '—';
    const balCls  = running <= 0 ? 'stmt-bal-pos' : 'stmt-bal-neg';
    const balStr  = `${_invFmt(Math.abs(running))}${running < 0 ? ' CR' : ''}`;
    const dotCls  = row.type === 'invoice' ? 'inv' : 'pay';
    const invAmt  = row.type === 'invoice' ? `<span style="color:var(--red)">${_invFmt(row.amount)}</span>` : '—';
    const payAmt  = row.type === 'payment' ? `<span style="color:#16a34a">−${_invFmt(row.amount)}</span>` : '—';
    const statusBit = row.type==='invoice'&&row.status ? ` ${_invStatusBadge(row.status)}` : '';
    return `
      <tr class="stmt-row ${row.type==='invoice'?'inv-row-type':'pay-row-type'}">
        <td>${dateStr}</td>
        <td><span class="stmt-type-dot ${dotCls}"></span>${esc(row.ref||'')}</td>
        <td>${esc(row.desc)}${statusBit}</td>
        <td style="font-size:11px;color:var(--muted);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(row.site||'')}</td>
        <td style="text-align:right">${invAmt}</td>
        <td style="text-align:right">${payAmt}</td>
        <td class="stmt-bal-col ${balCls}">${balStr}</td>
      </tr>`;
  }).join('');

  const agePillsHTML = Object.entries(ageBuckets)
    .filter(([,v]) => v > 0)
    .map(([k,v]) => `<span class="inv-chip active" style="cursor:default">${k}d: ${_invFmt(v)}</span>`)
    .join('');

  contentEl.innerHTML = `
    <div style="padding:8px 0 4px"><div style="font-size:16px;font-weight:800;color:var(--text)">${esc(contactName)}</div></div>
    <div class="stmt-cards">
      <div class="stmt-card danger">
        <div class="stmt-card-val">${_invFmt(outstanding)}</div>
        <div class="stmt-card-lbl">Outstanding</div>
      </div>
      <div class="stmt-card">
        <div class="stmt-card-val">${_invFmt(totalInvoiced)}</div>
        <div class="stmt-card-lbl">Total invoiced</div>
      </div>
      <div class="stmt-card ok">
        <div class="stmt-card-val">${_invFmt(totalPaid)}</div>
        <div class="stmt-card-lbl">Total paid</div>
      </div>
      <div class="stmt-card${overdueInvs.length?' danger':''}">
        <div class="stmt-card-val">${overdueInvs.length}</div>
        <div class="stmt-card-lbl">Overdue invoices</div>
      </div>
    </div>
    ${agePillsHTML?`<div class="stmt-aging-row"><span class="inv-aging-lbl">Aging:</span>${agePillsHTML}</div>`:''}
    <div style="overflow-x:auto;margin-top:4px">
      <table class="stmt-timeline">
        <thead><tr>
          <th>Date</th><th>Reference</th><th>Description</th><th>Site</th>
          <th style="text-align:right">Invoiced</th>
          <th style="text-align:right">Paid</th>
          <th style="text-align:right">Balance</th>
        </tr></thead>
        <tbody>${timelineRows||'<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--muted)">No transactions found</td></tr>'}</tbody>
      </table>
    </div>
  `;
}

document.addEventListener('DOMContentLoaded', init);
