/* GB Diary — Draft Certificate Manager
   Opens a panel overlay to list, date and issue all draft certificates.
   Auto-expiry rules:
     PAT / Gas / FRA / Emergency Lighting : issue + 1 year  − 1 day
     EICR                                 : issue + 5 years − 1 day (quick: 3 yr / 5 yr)
     Emergency Lighting                   : quick: 6 mo / 12 mo − 1 day
     EPC                                  : issue + 10 years − 1 day
*/

(function () {
  const BASE  = 'https://gbelectricals.co.uk';
  const TRPC  = 'https://gb-proxy.gbmandeep.workers.dev/trpc';

  /* ── helpers ── */
  function toLocalISO(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  function today() { return toLocalISO(new Date()); }
  function addPeriod(iso, months, minusDays) {
    const d = new Date(iso + 'T00:00:00');
    d.setMonth(d.getMonth() + months);
    d.setDate(d.getDate() - minusDays);
    return toLocalISO(d);
  }

  const EXPIRY_RULES = {
    pat:                             { months: 12, minusDays: 1 },
    cp12:                            { months: 12, minusDays: 1 },
    gas_safety:                      { months: 12, minusDays: 1 },
    fire_risk_assessment:            { months: 12, minusDays: 1 },
    emergency_lighting:              { months: 12, minusDays: 1 },
    eicr:                            { months: 60, minusDays: 1 },
    epc:                             { months: 120, minusDays: 1 },
  };

  const QUICK_BTNS = {
    eicr:              [{ label: '3 Years', months: 36 }, { label: '5 Years', months: 60 }],
    emergency_lighting:[{ label: '6 Months', months: 6 }, { label: '12 Months', months: 12 }],
  };

  /* ── API ── */
  async function api(path, input) {
    const url = `${TRPC}/${path}?input=` + encodeURIComponent(JSON.stringify({ json: input }));
    const r = await fetch(url, { credentials: 'include' });
    const d = await r.json();
    const row = Array.isArray(d) ? d[0] : d;
    if (row?.error) throw new Error(row.error?.json?.message || 'API error');
    const data = row?.result?.data;
    return data?.json !== undefined ? data.json : data;
  }
  async function post(path, input) {
    const r = await fetch(`${TRPC}/${path}`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ json: input }),
    });
    const d = await r.json();
    const row = Array.isArray(d) ? d[0] : d;
    if (row?.error) throw new Error(row.error?.json?.message || 'API error');
    return row?.result?.data?.json ?? row?.result?.data;
  }

  /* ── styles ── */
  function injectStyles() {
    if (document.getElementById('gb-dc-style')) return;
    const s = document.createElement('style');
    s.id = 'gb-dc-style';
    s.textContent = `
#gb-dc-overlay{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
#gb-dc-panel{background:#1a1a1a;border:1px solid #333;border-radius:14px;width:920px;max-width:96vw;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,.6);}
#gb-dc-hdr{padding:14px 18px;border-bottom:1px solid #333;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;}
#gb-dc-hdr h2{margin:0;font-size:15px;font-weight:700;color:#f0f0f0;}
#gb-dc-hdr-right{display:flex;align-items:center;gap:8px;}
#gb-dc-total{font-size:11px;color:#888;}
#gb-dc-close{background:none;border:none;font-size:19px;cursor:pointer;color:#666;padding:0 4px;line-height:1;}
#gb-dc-close:hover{color:#ccc;}
#gb-dc-body{overflow-y:auto;flex:1;}
.gb-dc-row{border-bottom:1px solid #252525;}
.gb-dc-row-main{display:flex;align-items:center;gap:8px;padding:9px 16px;cursor:pointer;user-select:none;}
.gb-dc-row-main:hover{background:#1f1f1f;}
.gb-dc-chev{font-size:9px;color:#555;width:12px;flex-shrink:0;transition:transform .15s;}
.gb-dc-chev.open{transform:rotate(90deg);}
.gb-dc-type{font-size:11px;font-weight:700;color:#818cf8;width:190px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.gb-dc-addr{font-size:12px;color:#ccc;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.gb-dc-who{font-size:11px;color:#777;width:110px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.gb-dc-tag{font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;flex-shrink:0;}
.gb-dc-tag-nopdf{background:rgba(245,158,11,.15);color:#d97706;}
.gb-dc-tag-pdf{background:rgba(22,163,74,.12);color:#4ade80;}
.gb-dc-job{font-size:10px;color:#555;width:68px;flex-shrink:0;}
.gb-dc-exp{display:none;padding:14px 16px 18px 28px;background:#141416;border-top:1px solid #252525;}
.gb-dc-exp.open{display:block;}
.gb-dc-exp-title{font-size:12px;font-weight:600;color:#ccc;margin-bottom:12px;}
.gb-dc-fields{display:flex;gap:18px;flex-wrap:wrap;align-items:flex-end;}
.gb-dc-field label{display:block;font-size:10px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px;}
.gb-dc-field input[type=date]{border:1px solid #333;border-radius:7px;padding:7px 10px;font-size:13px;color:#f0f0f0;width:165px;background:#1a1a1a;color-scheme:dark;}
.gb-dc-field input[type=date]:focus{outline:none;border-color:#818cf8;box-shadow:0 0 0 2px rgba(129,140,248,.2);}
.gb-dc-noexp{display:flex;align-items:center;gap:6px;font-size:12px;color:#666;padding-bottom:2px;cursor:pointer;}
.gb-dc-noexp input{cursor:pointer;width:14px;height:14px;accent-color:#818cf8;}
.gb-dc-quick{display:flex;align-items:center;gap:8px;margin-top:10px;}
.gb-dc-quick-lbl{font-size:11px;font-weight:600;color:#555;}
.gb-dc-qbtn{padding:5px 12px;border-radius:5px;font-size:11px;font-weight:700;cursor:pointer;border:1.5px solid #4f46e5;color:#818cf8;background:transparent;transition:all .15s;}
.gb-dc-qbtn:hover,.gb-dc-qbtn.active{background:#4f46e5;color:#fff;border-color:#4f46e5;}
.gb-dc-actions{display:flex;align-items:center;gap:10px;margin-top:14px;flex-wrap:wrap;}
.gb-dc-btn{padding:8px 18px;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:background .15s;}
.gb-dc-btn-issue{background:#4f46e5;color:#fff;}
.gb-dc-btn-issue:hover{background:#4338ca;}
.gb-dc-btn-issue:disabled{background:#2e2b7a;color:#888;cursor:not-allowed;}
.gb-dc-btn-view{background:#252525;color:#ccc;border:1px solid #333;}
.gb-dc-btn-view:hover{background:#2f2f2f;}
.gb-dc-msg{font-size:12px;}
.gb-dc-msg.ok{color:#4ade80;}
.gb-dc-msg.err{color:#f87171;}
.gb-dc-loading{padding:50px;text-align:center;color:#555;font-size:14px;}
.gb-dc-issued .gb-dc-row-main{opacity:.4;}
.gb-dc-issued .gb-dc-row-main{background:#0d1a0d;}
`;
    document.head.appendChild(s);
  }

  /* ── render ── */
  function render(certs) {
    const body = document.getElementById('gb-dc-body');
    document.getElementById('gb-dc-total').textContent = `${certs.length} draft${certs.length !== 1 ? 's' : ''}`;
    if (!certs.length) {
      body.innerHTML = '<div class="gb-dc-loading">No draft certificates</div>';
      return;
    }
    body.innerHTML = '';

    certs.forEach((c, i) => {
      const hasPdf = c.has_pdf;
      const rule = EXPIRY_RULES[c.cert_type_id];
      const quickBtns = QUICK_BTNS[c.cert_type_id] || [];
      const defaultExpiry = rule
        ? (c.expiry_date || addPeriod(c.issue_date || today(), rule.months, rule.minusDays))
        : (c.expiry_date || '');

      const row = document.createElement('div');
      row.className = 'gb-dc-row';
      row.id = `gb-dc-r-${i}`;

      const quickHtml = quickBtns.length
        ? `<div class="gb-dc-quick">
            <span class="gb-dc-quick-lbl">Quick:</span>
            ${quickBtns.map(b => `<button class="gb-dc-qbtn" data-months="${b.months}" data-i="${i}">${b.label}</button>`).join('')}
           </div>`
        : '';

      row.innerHTML = `
        <div class="gb-dc-row-main">
          <span class="gb-dc-chev" id="gb-dc-chev-${i}">▶</span>
          <span class="gb-dc-type">${c.cert_type_name}</span>
          <span class="gb-dc-addr">${c.property?.address || ''}, ${c.property?.postcode || ''}</span>
          <span class="gb-dc-who">${c.contact?.name || ''}</span>
          <span class="gb-dc-tag ${hasPdf ? 'gb-dc-tag-pdf' : 'gb-dc-tag-nopdf'}">${hasPdf ? 'PDF' : 'No PDF'}</span>
          <span class="gb-dc-job">${c.job?.job_no || ''}</span>
        </div>
        <div class="gb-dc-exp" id="gb-dc-exp-${i}">
          <div class="gb-dc-exp-title">${c.cert_type_name} — ${c.property?.address || ''}, ${c.property?.postcode || ''}</div>
          <div class="gb-dc-fields">
            <div class="gb-dc-field">
              <label>Issue Date</label>
              <input type="date" id="gb-dc-iss-${i}" value="${c.issue_date || today()}" max="2035-12-31">
            </div>
            <div class="gb-dc-field" id="gb-dc-expf-${i}">
              <label>Expiry Date</label>
              <input type="date" id="gb-dc-expd-${i}" value="${defaultExpiry}" min="${today()}">
            </div>
            <div class="gb-dc-field" style="padding-bottom:8px">
              <label style="opacity:0">.</label>
              <label class="gb-dc-noexp">
                <input type="checkbox" id="gb-dc-noexp-${i}" ${c.no_expiry ? 'checked' : ''}> No expiry
              </label>
            </div>
          </div>
          ${quickHtml}
          <div class="gb-dc-actions">
            <button class="gb-dc-btn gb-dc-btn-issue" id="gb-dc-issbtn-${i}" data-id="${c.id}" data-i="${i}">Issue Certificate</button>
            <button class="gb-dc-btn gb-dc-btn-view" onclick="window.open('${BASE}/office/certificates/${c.id}','_blank')">View in Portal</button>
            <span class="gb-dc-msg" id="gb-dc-msg-${i}"></span>
          </div>
        </div>`;

      body.appendChild(row);

      const issInput  = document.getElementById(`gb-dc-iss-${i}`);
      const expdInput = document.getElementById(`gb-dc-expd-${i}`);
      const noexpCb   = document.getElementById(`gb-dc-noexp-${i}`);
      const expField  = document.getElementById(`gb-dc-expf-${i}`);

      /* no-expiry toggle */
      noexpCb.addEventListener('change', function () {
        expField.style.opacity = this.checked ? '0.3' : '1';
        expdInput.disabled = this.checked;
        row.querySelectorAll('.gb-dc-qbtn').forEach(b => { b.disabled = this.checked; });
      });
      if (c.no_expiry) { expField.style.opacity = '0.3'; expdInput.disabled = true; }

      /* issue date → auto expiry */
      issInput.addEventListener('change', function () {
        if (noexpCb.checked || !rule) return;
        const computed = addPeriod(this.value, rule.months, rule.minusDays);
        expdInput.value = computed;
        flashField(expdInput);
        row.querySelectorAll('.gb-dc-qbtn').forEach(b => b.classList.remove('active'));
      });

      /* quick buttons */
      row.querySelectorAll('.gb-dc-qbtn').forEach(btn => {
        btn.addEventListener('click', () => {
          if (!issInput.value) { alert('Set issue date first'); return; }
          const months = parseInt(btn.dataset.months, 10);
          expdInput.value = addPeriod(issInput.value, months, 1);
          noexpCb.checked = false;
          expField.style.opacity = '1';
          expdInput.disabled = false;
          flashField(expdInput);
          row.querySelectorAll('.gb-dc-qbtn').forEach(b => b.classList.toggle('active', b === btn));
        });
      });

      /* expand toggle */
      row.querySelector('.gb-dc-row-main').addEventListener('click', () => {
        const exp  = document.getElementById(`gb-dc-exp-${i}`);
        const chev = document.getElementById(`gb-dc-chev-${i}`);
        const open = exp.classList.toggle('open');
        chev.classList.toggle('open', open);
      });

      /* issue button */
      document.getElementById(`gb-dc-issbtn-${i}`).addEventListener('click', async () => {
        const btn      = document.getElementById(`gb-dc-issbtn-${i}`);
        const msg      = document.getElementById(`gb-dc-msg-${i}`);
        const noExp    = noexpCb.checked;
        const issDate  = issInput.value;
        const expDate  = noExp ? null : expdInput.value;

        if (!issDate) { msg.className = 'gb-dc-msg err'; msg.textContent = 'Set issue date'; return; }
        if (!noExp && !expDate) { msg.className = 'gb-dc-msg err'; msg.textContent = 'Set expiry date or tick No expiry'; return; }

        btn.disabled = true; btn.textContent = 'Issuing…'; msg.textContent = '';
        try {
          const payload = { id: c.id, issue_date: issDate };
          if (!noExp && expDate) payload.expiry_date = expDate;
          if (noExp) payload.no_expiry = true;
          await post('certs.issue', payload);
          msg.className = 'gb-dc-msg ok'; msg.textContent = '✓ Issued!';
          btn.textContent = '✓ Done'; btn.style.background = '#16a34a';
          document.getElementById(`gb-dc-r-${i}`).classList.add('gb-dc-issued');
        } catch (err) {
          msg.className = 'gb-dc-msg err'; msg.textContent = err.message;
          btn.disabled = false; btn.textContent = 'Issue Certificate';
        }
      });
    });
  }

  function flashField(el) {
    el.style.borderColor = '#818cf8';
    el.style.background  = '#1e1d3a';
    setTimeout(() => { el.style.borderColor = ''; el.style.background = ''; }, 1100);
  }

  /* ── public open function ── */
  window.openDraftCertsPanel = async function () {
    if (document.getElementById('gb-dc-overlay')) return;
    injectStyles();

    const overlay = document.createElement('div');
    overlay.id = 'gb-dc-overlay';
    overlay.innerHTML = `
      <div id="gb-dc-panel">
        <div id="gb-dc-hdr">
          <h2>📋 Draft Certificates</h2>
          <div id="gb-dc-hdr-right">
            <span id="gb-dc-total"></span>
            <button id="gb-dc-close">✕</button>
          </div>
        </div>
        <div id="gb-dc-body"><div class="gb-dc-loading">Loading drafts…</div></div>
      </div>`;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.getElementById('gb-dc-close').addEventListener('click', () => overlay.remove());

    try {
      const data  = await api('certs.list', { status: 'draft', pageSize: 100 });
      const certs = data?.certs || [];
      render(certs);
    } catch (err) {
      document.getElementById('gb-dc-body').innerHTML =
        `<div class="gb-dc-loading" style="color:#f87171">Error: ${err.message}</div>`;
    }
  };
})();
