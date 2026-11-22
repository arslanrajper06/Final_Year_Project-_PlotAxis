/* ---------------------------------------------------------------
   PlotAxis — Shared customer portal page logic
----------------------------------------------------------------*/

const { STORAGE_KEY, API_ROOT, state, saveState, toast } = window.PlotAxisCore;
const VIEW_META = window.PlotAxisPageMeta;
const currentView = document.body.dataset.page;
const defaultPlotStatuses = new Map(PLOTS.map(plot => [plot.id, plot.status]));
let reservationSyncFailed = false;
let legacyReservationSyncFailed = false;

async function reservationApi(path, options = {}) {
  const headers = {
    ...(options.headers || {}),
    Authorization: `Bearer ${localStorage.getItem("plotaxis_token") || ""}`,
  };
  if (options.body) headers["Content-Type"] = "application/json";
  const response = await fetch(`${API_ROOT}${path}`, { ...options, headers });
  if (!(response.headers.get("content-type") || "").includes("application/json")) {
    if (response.status === 404) {
      throw new Error("Reservation API is unavailable. Restart the backend with npm start.");
    }
    throw new Error(`Reservation service returned an unexpected response (${response.status}).`);
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "Reservation service request failed.");
  return data;
}

async function syncReservationState() {
  const previousState = JSON.stringify({
    bookings: state.bookings,
    statuses: PLOTS.map(plot => plot.status),
  });
  const savedReservations = await reservationApi("/reservations");
  if (!Array.isArray(savedReservations.bookings)) {
    throw new Error("Reservation service returned incomplete booking data.");
  }

  const remoteBookingIds = new Set(savedReservations.bookings.map(booking => String(booking.bookingId)));
  savedReservations.bookings.forEach(remoteBooking => {
    const localBooking = state.bookings.find(
      booking => String(booking.bookingId) === String(remoteBooking.bookingId)
    );
    if (localBooking) Object.assign(localBooking, remoteBooking);
    else state.bookings.push(remoteBooking);
  });

  const migrationErrors = [];
  for (const booking of state.bookings) {
    if (booking.serverManaged || booking.cancelled || remoteBookingIds.has(String(booking.bookingId))) continue;
    try {
      const result = await reservationApi("/reservations", {
        method: "POST",
        body: JSON.stringify({ booking }),
      });
      Object.assign(booking, result.booking);
      remoteBookingIds.add(String(booking.bookingId));
    } catch (error) {
      migrationErrors.push({ bookingId: booking.bookingId, error });
    }
  }

  if (migrationErrors.length) {
    migrationErrors.forEach(({ bookingId, error }) => {
      console.error(`Could not sync existing reservation ${bookingId}.`, error);
    });
    if (!legacyReservationSyncFailed) {
      toast("An existing reservation could not be synced. Please refresh or contact support.");
    }
    legacyReservationSyncFailed = true;
  } else {
    legacyReservationSyncFailed = false;
  }

  const [reservationData, availabilityData] = await Promise.all([
    reservationApi("/reservations"),
    reservationApi("/reservations/availability"),
  ]);
  if (!Array.isArray(reservationData.bookings) || !Array.isArray(availabilityData.reservedPlotIds)) {
    throw new Error("Reservation service returned incomplete data.");
  }
  reservationData.bookings.forEach(remoteBooking => {
    const localBooking = state.bookings.find(
      booking => String(booking.bookingId) === String(remoteBooking.bookingId)
    );
    if (localBooking) Object.assign(localBooking, remoteBooking);
    else state.bookings.push(remoteBooking);
  });

  const reservedPlotIds = new Set(availabilityData.reservedPlotIds);
  PLOTS.forEach(plot => {
    const originalStatus = defaultPlotStatuses.get(plot.id);
    plot.status = originalStatus === "Available" && reservedPlotIds.has(plot.id)
      ? "Reserved"
      : originalStatus;
  });

  const nextState = JSON.stringify({
    bookings: state.bookings,
    statuses: PLOTS.map(plot => plot.status),
  });
  reservationSyncFailed = false;
  if (previousState !== nextState) saveState();
  return previousState !== nextState;
}

document.getElementById("logoutBtn").addEventListener("click", () => {
  state.user = null;
  localStorage.removeItem("plotaxis_token");
  saveState();
  window.location.assign("index.html");
});

/* ---------------- Navigation ---------------- */

window.addEventListener("storage", event => {
  if (event.key !== STORAGE_KEY || !event.newValue) return;

  let latestState;
  try {
    latestState = JSON.parse(event.newValue);
  } catch (error) {
    console.error("Unable to sync customer payment updates from storage.", error);
    return;
  }

  if (!latestState || !Array.isArray(latestState.bookings)) {
    console.error("Unable to sync customer payment updates: stored bookings are invalid.");
    return;
  }

  Object.assign(state, latestState);
  if (currentView === "payments") renderPayments();
  if (currentView === "bookings") renderBookings();
});

function setView(view, bookingId) {
  const page = VIEW_META[view];
  if (!page) throw new Error(`Unknown customer portal view: ${view}`);
  if (view !== currentView) {
    const url = new URL(page.file, window.location.href);
    if (view === "payments" && bookingId) url.searchParams.set("booking", bookingId);
    window.location.assign(url);
    return;
  }
  if (bookingId) activeBookingId = bookingId;
  const renderers = {
    requirements: renderRequirements,
    search: renderSearch,
    recommend: renderRecommend,
    bookings: renderBookings,
    payments: renderPayments,
    certificates: renderCertificates,
  };
  document.getElementById("viewWrap").innerHTML = "";
  renderers[view]();
}

/* ---------------- Modal ---------------- */

const modalLayer = document.getElementById("modalLayer");
const modalCard = document.getElementById("modalCard");
let certificateObjectUrl = null;
let certificateShortcutHandler = null;
let certificateContextHandler = null;
let certificatePreviousMaxWidth = null;

function releaseCertificateViewer() {
  if (certificateObjectUrl) {
    URL.revokeObjectURL(certificateObjectUrl);
    certificateObjectUrl = null;
  }
  if (certificateShortcutHandler) {
    document.removeEventListener("keydown", certificateShortcutHandler, true);
    certificateShortcutHandler = null;
  }
  if (certificateContextHandler) {
    document.removeEventListener("contextmenu", certificateContextHandler, true);
    certificateContextHandler = null;
  }
  if (certificatePreviousMaxWidth !== null) {
    modalCard.style.maxWidth = certificatePreviousMaxWidth;
    certificatePreviousMaxWidth = null;
  }
}

function openModal(html, preserveCertificate = false) {
  if (!preserveCertificate) releaseCertificateViewer();
  modalCard.innerHTML = html;
  modalLayer.classList.remove("is-hidden");
}
function closeModal() {
  releaseCertificateViewer();
  modalLayer.classList.add("is-hidden");
  modalCard.innerHTML = "";
}
modalLayer.addEventListener("click", e => {
  if (e.target === modalLayer) closeModal();
});

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function fetchCertificateFile(certificateId) {
  const response = await fetch(`${API_ROOT}/certificates/${encodeURIComponent(certificateId)}/file`, {
    headers: { Authorization: `Bearer ${localStorage.getItem("plotaxis_token") || ""}` },
  });
  if (!response.ok) {
    if ((response.headers.get("content-type") || "").includes("application/json")) {
      const data = await response.json();
      throw new Error(data.message || "Certificate could not be opened.");
    }
    throw new Error(`Certificate request failed (${response.status}).`);
  }
  const mimeType = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
  if (!["application/pdf", "image/png", "image/jpeg"].includes(mimeType)) {
    throw new Error("The certificate has an unsupported file format.");
  }
  return { blob: await response.blob(), mimeType };
}

async function openCertificateViewer(certificate) {
  try {
    const { blob, mimeType } = await fetchCertificateFile(certificate.id);
    certificateObjectUrl = URL.createObjectURL(blob);
    const viewedAt = new Date().toLocaleString();
    const watermark = escapeHtml(`PlotAxis · Customer ID: ${state.user.id} · ${viewedAt}`);
    const content = mimeType === "application/pdf"
      ? `<iframe title="Protected society document" src="${certificateObjectUrl}#toolbar=0&navpanes=0&scrollbar=0" draggable="false" style="position:absolute;inset:0;width:100%;height:100%;border:0"></iframe>`
      : `<img src="${certificateObjectUrl}" alt="${escapeHtml(certificate.title)}" draggable="false" style="max-width:100%;max-height:100%;object-fit:contain;pointer-events:none;user-select:none">`;

    certificatePreviousMaxWidth = modalCard.style.maxWidth;
    modalCard.style.maxWidth = "min(92vw, 1100px)";
    openModal(`
      <h3>${escapeHtml(certificate.title)}</h3>
      <p class="panel-sub">${escapeHtml(certificate.societyName)} · ${escapeHtml(certificate.issuingAuthority)} · Approval No. ${escapeHtml(certificate.approvalNumber)}</p>
      <div id="certificateViewer" tabindex="0" style="position:relative;height:min(68vh,720px);min-height:320px;overflow:auto;background:#F2F5FC;user-select:none;-webkit-user-select:none">
        ${content}
        <div aria-hidden="true" style="position:absolute;inset:0;z-index:2;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-content:space-around;justify-items:center;gap:3rem;overflow:hidden;pointer-events:none;user-select:none">
          ${Array.from({ length: 8 }, () => `<span style="color:#1E2761;opacity:.22;font-size:12px;font-weight:700;white-space:nowrap;transform:rotate(-25deg)">${watermark}</span>`).join("")}
        </div>
      </div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" id="closeCertificateViewer">Close</button></div>
    `, true);

    const viewer = document.getElementById("certificateViewer");
    viewer.addEventListener("contextmenu", event => event.preventDefault());
    viewer.addEventListener("dragstart", event => event.preventDefault());
    certificateContextHandler = event => event.preventDefault();
    certificateShortcutHandler = event => {
      if ((event.ctrlKey || event.metaKey) && ["p", "s"].includes(event.key.toLowerCase())) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    document.addEventListener("contextmenu", certificateContextHandler, true);
    document.addEventListener("keydown", certificateShortcutHandler, true);
    document.getElementById("closeCertificateViewer").addEventListener("click", closeModal);
  } catch (error) {
    releaseCertificateViewer();
    console.error(`Could not open certificate ${certificate.id}.`, error);
    toast(error.message);
  }
}

/* ---------------- View: Requirements ---------------- */

 function renderRequirements() {
  const r = state.requirements || {
    budgetMin: 2500000,
    budgetMax: 6000000,
    sizeMin: 120,
    sizeMax: 250,
    societies: [],
    categories: [],
  };

  const selectedSocieties = Array.isArray(r.societies) ? r.societies : [];
  const selectedCategories = Array.isArray(r.categories) ? r.categories : [];

   const initialSocLabel = selectedSocieties.length ? `${selectedSocieties.length} selected` : "Any";
const initialCatLabel = selectedCategories.length ? `${selectedCategories.length} selected` : "Any";

  const wrap = document.getElementById("viewWrap");
  wrap.innerHTML = `
    <div class="panel panel-narrow">
      <h3>What are you looking for?</h3>
      <p class="panel-sub">These answers feed the recommendation engine on the next step — change them any time.</p>
      <form id="reqForm" class="req-form">
        <div class="field-row">
          <label>Budget — minimum (PKR)
            <input type="number" step="50000" id="budgetMin" value="${r.budgetMin}" required />
          </label>
          <label>Budget — maximum (PKR)
            <input type="number" step="50000" id="budgetMax" value="${r.budgetMax}" required />
          </label>
        </div>
        <div class="field-row">
          <label>Plot size — minimum (sq. yd)
            <input type="number" step="5" id="sizeMin" value="${r.sizeMin}" required />
          </label>
          <label>Plot size — maximum (sq. yd)
            <input type="number" step="5" id="sizeMax" value="${r.sizeMax}" required />
          </label>
        </div>
        <div class="field-row">
          <label>Preferred society
            <div class="multi-select" id="societyMultiSelect">
              <button type="button" class="multi-select-btn" id="societyDropdownBtn">
                <span id="societySelectedText">${initialSocLabel}</span>
              </button>
              <div class="multi-select-menu is-hidden" id="societyDropdownMenu">
                <label class="multi-select-item">
                  <input type="checkbox" id="societyAnyCheck" ${selectedSocieties.length === 0 ? "checked" : ""} />
                  <span>Any</span>
                </label>
                ${SOCIETIES.map(s => `
                  <label class="multi-select-item">
                    <input type="checkbox" name="society" value="${s}" ${selectedSocieties.includes(s) ? "checked" : ""} />
                    <span>${s}</span>
                  </label>
                `).join("")}
              </div>
            </div>
          </label>

          <label>Preferred category
            <div class="multi-select" id="categoryMultiSelect">
              <button type="button" class="multi-select-btn" id="categoryDropdownBtn">
                <span id="categorySelectedText">${initialCatLabel}</span>
              </button>
              <div class="multi-select-menu is-hidden" id="categoryDropdownMenu">
                <label class="multi-select-item">
                  <input type="checkbox" id="categoryAnyCheck" ${selectedCategories.length === 0 ? "checked" : ""} />
                  <span>Any</span>
                </label>
                ${CATEGORIES.map(c => `
                  <label class="multi-select-item">
                    <input type="checkbox" name="category" value="${c}" ${selectedCategories.includes(c) ? "checked" : ""} />
                    <span>${c}</span>
                  </label>
                `).join("")}
              </div>
            </div>
          </label>
        </div>
        <button type="submit" class="btn btn-primary">Save & see matches</button>
      </form>
    </div>
  `;

  function setupMultiSelect(wrapId, btnId, menuId, textId, anyId, inputName) {
    const dropdownWrap = document.getElementById(wrapId);
    const dropdownBtn = document.getElementById(btnId);
    const dropdownMenu = document.getElementById(menuId);
    const selectedText = document.getElementById(textId);
    const anyCheck = document.getElementById(anyId);
    const checks = [...dropdownMenu.querySelectorAll(`input[name="${inputName}"]`)];

    dropdownBtn.addEventListener("click", () => {
      document.querySelectorAll(".multi-select-menu").forEach(m => {
        if (m !== dropdownMenu) m.classList.add("is-hidden");
      });
      dropdownMenu.classList.toggle("is-hidden");
    });

    document.addEventListener("click", e => {
      if (!dropdownWrap.contains(e.target)) {
        dropdownMenu.classList.add("is-hidden");
      }
    });

    function updateLabel() {
      const checked = checks.filter(cb => cb.checked).map(cb => cb.value);
      if (checked.length === 0) {
        anyCheck.checked = true;
        selectedText.textContent = "Any";
      } else {
        anyCheck.checked = false;
        selectedText.textContent = checked.join(", ");
      }
    }

    anyCheck.addEventListener("change", () => {
      if (anyCheck.checked) {
        checks.forEach(cb => (cb.checked = false));
      }
      updateLabel();
    });

    checks.forEach(cb => cb.addEventListener("change", updateLabel));
    return checks;
  }

  const societyChecks = setupMultiSelect(
    "societyMultiSelect", "societyDropdownBtn", "societyDropdownMenu",
    "societySelectedText", "societyAnyCheck", "society"
  );
  const categoryChecks = setupMultiSelect(
    "categoryMultiSelect", "categoryDropdownBtn", "categoryDropdownMenu",
    "categorySelectedText", "categoryAnyCheck", "category"
  );

  document.getElementById("reqForm").addEventListener("submit", e => {
    e.preventDefault();
    const checkedSocieties = societyChecks.filter(cb => cb.checked).map(cb => cb.value);
    const checkedCategories = categoryChecks.filter(cb => cb.checked).map(cb => cb.value);

    state.requirements = {
      budgetMin: Number(document.getElementById("budgetMin").value),
      budgetMax: Number(document.getElementById("budgetMax").value),
      sizeMin: Number(document.getElementById("sizeMin").value),
      sizeMax: Number(document.getElementById("sizeMax").value),
      societies: checkedSocieties,
      categories: checkedCategories,
    };
    saveState();
    toast("Requirements saved");
    setView("recommend");
  });
}
 

 /* ---------------- View: Search ---------------- */

 

const STATUS_OPTIONS = ["Available", "Reserved", "Sold"];
const DEFAULT_SEARCH_FILTERS = { q: "", societies: [], categories: [], minPrice: 2000000, maxPrice: 40000000, statuses: [] };

function loadSearchFilters() {
  const saved = sessionStorage.getItem("plotaxis_search_filters");
  if (!saved) return { ...DEFAULT_SEARCH_FILTERS };
  try {
    const parsed = JSON.parse(saved);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Stored search filters are not an object.");
    }
    const filters = { ...DEFAULT_SEARCH_FILTERS, ...parsed };
    if (Array.isArray(parsed.statuses)
      && parsed.statuses.length === 1
      && parsed.statuses[0] === "Available") {
      filters.statuses = [];
    }
    return filters;
  } catch (error) {
    console.error("Could not restore plot search filters.", error);
    sessionStorage.removeItem("plotaxis_search_filters");
    return { ...DEFAULT_SEARCH_FILTERS };
  }
}

let searchFilters = loadSearchFilters();

function renderSearch() {
  const initialSocLabel = searchFilters.societies.length ? `${searchFilters.societies.length} selected` : "Any";
  const initialCatLabel = searchFilters.categories.length ? `${searchFilters.categories.length} selected` : "Any";
  const initialStatusLabel = searchFilters.statuses.length === 0
    ? "Any"
    : (searchFilters.statuses.length === 1 ? searchFilters.statuses[0] : `${searchFilters.statuses.length} selected`);

  const wrap = document.getElementById("viewWrap");
  wrap.innerHTML = `
    <div class="search-layout">
      <aside class="filters">
        <h3>Filters</h3>
        <label>Search by ID or block
          <input type="text" id="fQuery" placeholder="e.g. GH-D or corner" value="${searchFilters.q}" />
        </label>

        <label>Society
          <div class="multi-select" id="fSocietyMultiSelect">
            <button type="button" class="multi-select-btn" id="fSocietyDropdownBtn">
              <span id="fSocietySelectedText">${initialSocLabel}</span>
            </button>
            <div class="multi-select-menu is-hidden" id="fSocietyDropdownMenu">
              <label class="multi-select-item">
                <input type="checkbox" id="fSocietyAnyCheck" ${searchFilters.societies.length === 0 ? "checked" : ""} />
                <span>Any</span>
              </label>
              ${SOCIETIES.map(s => `
                <label class="multi-select-item">
                  <input type="checkbox" name="fSociety" value="${s}" ${searchFilters.societies.includes(s) ? "checked" : ""} />
                  <span>${s}</span>
                </label>
              `).join("")}
            </div>
          </div>
        </label>

        <label>Category
          <div class="multi-select" id="fCategoryMultiSelect">
            <button type="button" class="multi-select-btn" id="fCategoryDropdownBtn">
              <span id="fCategorySelectedText">${initialCatLabel}</span>
            </button>
            <div class="multi-select-menu is-hidden" id="fCategoryDropdownMenu">
              <label class="multi-select-item">
                <input type="checkbox" id="fCategoryAnyCheck" ${searchFilters.categories.length === 0 ? "checked" : ""} />
                <span>Any</span>
              </label>
              ${CATEGORIES.map(c => `
                <label class="multi-select-item">
                  <input type="checkbox" name="fCategory" value="${c}" ${searchFilters.categories.includes(c) ? "checked" : ""} />
                  <span>${c}</span>
                </label>
              `).join("")}
            </div>
          </div>
        </label>

        <label>Min price: <span id="fMinPriceLabel">${formatPKR(searchFilters.minPrice)}</span>
          <input type="range" id="fMinPrice" min="2000000" max="40000000" step="100000" value="${searchFilters.minPrice}" />
        </label>

        <label>Max price: <span id="fPriceLabel">${formatPKR(searchFilters.maxPrice)}</span>
          <input type="range" id="fPrice" min="2000000" max="40000000" step="100000" value="${searchFilters.maxPrice}" />
        </label>

        <label>Status
          <div class="multi-select multi-select--up" id="fStatusMultiSelect">
            <button type="button" class="multi-select-btn" id="fStatusDropdownBtn">
              <span id="fStatusSelectedText">${initialStatusLabel}</span>
            </button>
            <div class="multi-select-menu is-hidden" id="fStatusDropdownMenu">
              <label class="multi-select-item">
                <input type="checkbox" id="fStatusAnyCheck" ${searchFilters.statuses.length === 0 ? "checked" : ""} />
                <span>Any</span>
              </label>
              ${STATUS_OPTIONS.map(st => `
                <label class="multi-select-item">
                  <input type="checkbox" name="fStatus" value="${st}" ${searchFilters.statuses.includes(st) ? "checked" : ""} />
                  <span>${st}</span>
                </label>
              `).join("")}
            </div>
          </div>
        </label>
      </aside>
      <section class="results" id="results"></section>
    </div>
  `;

  function setupFilterMultiSelect(wrapId, btnId, menuId, textId, anyId, inputName) {
    const dropdownWrap = document.getElementById(wrapId);
    const dropdownBtn = document.getElementById(btnId);
    const dropdownMenu = document.getElementById(menuId);
    const selectedText = document.getElementById(textId);
    const anyCheck = document.getElementById(anyId);
    const checks = [...dropdownMenu.querySelectorAll(`input[name="${inputName}"]`)];

    dropdownBtn.addEventListener("click", () => {
      document.querySelectorAll(".multi-select-menu").forEach(m => {
        if (m !== dropdownMenu) m.classList.add("is-hidden");
      });
      dropdownMenu.classList.toggle("is-hidden");
    });

    document.addEventListener("click", e => {
      if (!dropdownWrap.contains(e.target)) {
        dropdownMenu.classList.add("is-hidden");
      }
    });

    anyCheck.addEventListener("change", () => {
      if (anyCheck.checked) {
        checks.forEach(cb => (cb.checked = false));
      }
      apply();
    });

    checks.forEach(cb => cb.addEventListener("change", apply));
    return { checks, anyCheck, selectedText };
  }

  let socCtrl, catCtrl, statusCtrl;

  const apply = (changedId) => {
    const checkedSocieties = socCtrl.checks.filter(cb => cb.checked).map(cb => cb.value);
    if (checkedSocieties.length === 0) {
      socCtrl.anyCheck.checked = true;
      socCtrl.selectedText.textContent = "Any";
    } else {
      socCtrl.anyCheck.checked = false;
      socCtrl.selectedText.textContent = `${checkedSocieties.length} selected`;
    }

    const checkedCategories = catCtrl.checks.filter(cb => cb.checked).map(cb => cb.value);
    if (checkedCategories.length === 0) {
      catCtrl.anyCheck.checked = true;
      catCtrl.selectedText.textContent = "Any";
    } else {
      catCtrl.anyCheck.checked = false;
      catCtrl.selectedText.textContent = `${checkedCategories.length} selected`;
    }

    const checkedStatuses = statusCtrl.checks.filter(cb => cb.checked).map(cb => cb.value);
    if (checkedStatuses.length === 0) {
      statusCtrl.anyCheck.checked = true;
      statusCtrl.selectedText.textContent = "Any";
    } else {
      statusCtrl.anyCheck.checked = false;
      statusCtrl.selectedText.textContent = checkedStatuses.length === 1 ? checkedStatuses[0] : `${checkedStatuses.length} selected`;
    }

    const minEl = document.getElementById("fMinPrice");
    const maxEl = document.getElementById("fPrice");
    let minVal = Number(minEl.value);
    let maxVal = Number(maxEl.value);

    // Min price kabhi Max price se zyada na ho
    if (minVal > maxVal) {
      if (changedId === "fMinPrice") {
        maxVal = minVal;
        maxEl.value = maxVal;
      } else {
        minVal = maxVal;
        minEl.value = minVal;
      }
    }

    searchFilters = {
      q: document.getElementById("fQuery").value.trim().toLowerCase(),
      societies: checkedSocieties,
      categories: checkedCategories,
      minPrice: minVal,
      maxPrice: maxVal,
      statuses: checkedStatuses,
    };
    sessionStorage.setItem("plotaxis_search_filters", JSON.stringify(searchFilters));
    document.getElementById("fMinPriceLabel").textContent = formatPKR(searchFilters.minPrice);
    document.getElementById("fPriceLabel").textContent = formatPKR(searchFilters.maxPrice);
    renderResults();
  };

  socCtrl = setupFilterMultiSelect(
    "fSocietyMultiSelect", "fSocietyDropdownBtn", "fSocietyDropdownMenu",
    "fSocietySelectedText", "fSocietyAnyCheck", "fSociety"
  );
  catCtrl = setupFilterMultiSelect(
    "fCategoryMultiSelect", "fCategoryDropdownBtn", "fCategoryDropdownMenu",
    "fCategorySelectedText", "fCategoryAnyCheck", "fCategory"
  );
  statusCtrl = setupFilterMultiSelect(
    "fStatusMultiSelect", "fStatusDropdownBtn", "fStatusDropdownMenu",
    "fStatusSelectedText", "fStatusAnyCheck", "fStatus"
  );

  ["fQuery", "fMinPrice", "fPrice"].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener("input", () => apply(id));
    el.addEventListener("change", () => apply(id));
  });

  renderResults();
}

function renderResults() {
  const ownActivePlotIds = new Set(
    state.bookings.filter(booking => !booking.cancelled).map(booking => booking.plotId)
  );
  const list = PLOTS.filter(p => {
    if (searchFilters.q && !(`${p.id} ${p.block} ${p.tags.join(" ")}`.toLowerCase().includes(searchFilters.q))) return false;
    if (searchFilters.societies.length > 0 && !searchFilters.societies.includes(p.society)) return false;
    if (searchFilters.categories.length > 0 && !searchFilters.categories.includes(p.category)) return false;
    if (p.price < searchFilters.minPrice) return false;
    if (p.price > searchFilters.maxPrice) return false;
    if (searchFilters.statuses.length > 0 && !searchFilters.statuses.includes(p.status)
      && !ownActivePlotIds.has(p.id)) return false;
    return true;
  });

  const results = document.getElementById("results");
  results.innerHTML = `
    <p class="results-count">${list.length} plot${list.length === 1 ? "" : "s"} found</p>
    <div class="plot-grid-list">
      ${list.map(p => plotCard(p)).join("") || emptyState("No plots match these filters", "Try widening your budget or clearing a filter.")}
    </div>
  `;
  bindPlotCardActions(results);
}
/* ---------------- View: Recommend ---------------- */

function renderRecommend() {
  const wrap = document.getElementById("viewWrap");
  if (!state.requirements) {
    wrap.innerHTML = emptyState(
      "We don't have your requirements yet",
      "Fill in your budget, size and location preferences and we'll rank every plot for you.",
      `<button class="btn btn-primary" id="goReq">Add requirements</button>`
    );
    document.getElementById("goReq").addEventListener("click", () => setView("requirements"));
    return;
  }

  const ranked = PLOTS
    .filter(p => p.status === "Available")
    .map(p => ({ plot: p, score: scorePlot(p, state.requirements) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 9);

  const socLabel = Array.isArray(state.requirements.societies) && state.requirements.societies.length
    ? state.requirements.societies.join(", ")
    : "Any society";

  const catLabel = Array.isArray(state.requirements.categories) && state.requirements.categories.length
    ? state.requirements.categories.join(", ")
    : (state.requirements.category || "Any category");

  wrap.innerHTML = `
    <div class="panel-header-row">
      <p class="panel-sub">Ranked against: ${formatPKR(state.requirements.budgetMin)}–${formatPKR(state.requirements.budgetMax)},
      ${state.requirements.sizeMin}–${state.requirements.sizeMax} sq. yd,
      ${socLabel}, ${catLabel}.
      <button class="link-btn" id="editReq">Edit</button></p>
    </div>
    <div class="plot-grid-list">
      ${ranked.map(({ plot, score }, i) => plotCard(plot, score, i === 0)).join("")}
    </div>
  `;
  document.getElementById("editReq").addEventListener("click", () => setView("requirements"));
  bindPlotCardActions(wrap);
}

 
/* ---------------- Plot card (shared) ---------------- */

function plotCard(p, score, isBest) {
  const already = state.bookings.some(b => b.plotId === p.id && !b.cancelled);
  const status = already ? "Reserved" : p.status;
  const disabled = status !== "Available" || already;
  const cta = already ? "Already booked" : status !== "Available" ? status : "Reserve this plot";
  return `
    <article class="plot-card">
      ${isBest ? `<span class="best-badge">Best match</span>` : ""}
      <div class="plot-card-top">
        <div class="plot-swatch" style="--sw-a:${swatchColor(p.id, 0)};--sw-b:${swatchColor(p.id, 1)}"></div>
        <div>
          <p class="plot-id">${p.id}</p>
          <p class="plot-society">${p.society} · Block ${p.block}</p>
        </div>
        ${typeof score === "number" ? `<div class="score-ring" style="--score:${score}"><span>${score}</span></div>` : ""}
      </div>
      <dl class="plot-specs">
        <div><dt>Size</dt><dd>${p.size} sq. yd</dd></div>
        <div><dt>Category</dt><dd>${p.category}</dd></div>
        <div><dt>Price</dt><dd>${formatPKR(p.price)}</dd></div>
      </dl>
      ${p.tags.length ? `<div class="tag-row">${p.tags.map(t => `<span class="tag">${t}</span>`).join("")}</div>` : ""}
      <div class="plot-card-footer">
        <span class="status-pill status-${status.toLowerCase()}">${status}</span>
        <button class="btn btn-small ${disabled ? "btn-disabled" : "btn-primary"}" data-reserve="${p.id}" ${disabled ? "disabled" : ""}>${cta}</button>
      </div>
    </article>
  `;
}

function swatchColor(id, i) {
  const palette = ["#1E2761", "#C9992C", "#5B6CC9", "#8CA0E8"];
  const hash = [...id].reduce((a, c) => a + c.charCodeAt(0), 0);
  return palette[(hash + i) % palette.length];
}

function bindPlotCardActions(root) {
  root.querySelectorAll("[data-reserve]").forEach(btn => {
    btn.addEventListener("click", () => openReserveModal(btn.dataset.reserve));
  });
}

/* ---------------- Reserve flow ---------------- */

function openReserveModal(plotId) {
  const plot = PLOTS.find(p => p.id === plotId);
  const down = Math.round(plot.price * 0.2);
  openModal(`
    <h3>Confirm your reservation</h3>
    <p class="panel-sub">Plot ${plot.id} · ${plot.society}, Block ${plot.block}</p>
    <dl class="confirm-specs">
      <div><dt>Total price</dt><dd>${formatPKR(plot.price)}</dd></div>
      <div><dt>Down payment (20%)</dt><dd>${formatPKR(down)}</dd></div>
      <div><dt>Remaining</dt><dd>16 quarterly installments</dd></div>
    </dl>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="cancelReserve">Cancel</button>
      <button class="btn btn-primary" id="confirmReserve">Confirm</button>
    </div>
  `);
  document.getElementById("cancelReserve").addEventListener("click", closeModal);
  const confirmButton = document.getElementById("confirmReserve");
  confirmButton.addEventListener("click", async () => {
    const bookedOn = new Date().toISOString().slice(0, 10);
    const booking = {
      bookingId: `booking-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      plotId: plot.id,
      bookedOn,
      installments: buildInstallmentPlan(plot, bookedOn),
    };

    confirmButton.disabled = true;
    try {
      const result = await reservationApi("/reservations", {
        method: "POST",
        body: JSON.stringify({ booking }),
      });
      state.bookings.push(result.booking);
      plot.status = "Reserved";
      saveState();
      closeModal();
      toast(`${plot.id} reserved — payment is due within 72 hours`);
      setView("bookings");
    } catch (error) {
      console.error("Could not reserve plot:", error);
      toast(error.message);
      try {
        await syncReservationState();
      } catch (syncError) {
        console.error("Could not refresh reservation availability.", syncError);
      }
    } finally {
      confirmButton.disabled = false;
    }
  });
}

/* ---------------- View: Bookings ---------------- */

function renderBookings() {
  processDueCancellations();
  const wrap = document.getElementById("viewWrap");
  if (!state.bookings.length) {
    wrap.innerHTML = emptyState(
      "No bookings yet",
      "Reserve a plot from Search or your Recommendations and it will show up here.",
      `<button class="btn btn-primary" id="goSearch">Search plots</button>`
    );
    document.getElementById("goSearch").addEventListener("click", () => setView("search"));
    return;
  }

  const activeBookings = state.bookings.filter(b => !b.cancelled);

  wrap.innerHTML = `
    ${activeBookings.length ? `<div class="booking-list">${activeBookings.map(b => {
    const plot = PLOTS.find(p => p.id === b.plotId);
    const paid = b.installments.filter(i => i.paid).length;
    const pct = Math.round((paid / b.installments.length) * 100);
    return `
      <article class="booking-row">
        <div class="plot-swatch" style="--sw-a:${swatchColor(plot.id, 0)};--sw-b:${swatchColor(plot.id, 1)}"></div>
        <div class="booking-info">
          <p class="plot-id">${plot.id} <span class="plot-society">· ${plot.society}, Block ${plot.block}</span></p>
          <p class="panel-sub">Booked ${b.bookedOn} · ${formatPKR(plot.price)}${b.paymentStatus === "pending" && b.paymentExpiresAt ? ` · Payment due ${new Date(b.paymentExpiresAt).toLocaleString()}` : ""}</p>
          ${b.cancellationPending ? `<p class="panel-sub">Cancellation pending until ${new Date(b.cancellationEffectiveAt).toLocaleString()} · Plot remains reserved.</p>` : ""}
          <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
          <p class="progress-label">${paid} of ${b.installments.length} installments paid (${pct}%)</p>
        </div>
        <div class="booking-actions">
          <button type="button" class="btn btn-ghost btn-small" data-view-payments="${b.bookingId}">View payments</button>
          <button type="button" class="btn btn-ghost btn-small" data-cancel-booking="${b.bookingId}">${b.cancellationPending ? "Undo cancellation" : "Cancel booking"}</button>
        </div>
      </article>
    `;
  }).join("")}</div>` : emptyState(
      "No active bookings",
      "Reserve a plot from Search or your Recommendations and it will show up here.",
      `<button class="btn btn-primary" id="goSearch">Search plots</button>`
    )}
  `;

  const goSearch = document.getElementById("goSearch");
  if (goSearch) goSearch.addEventListener("click", () => setView("search"));

  wrap.querySelectorAll("[data-view-payments]").forEach(btn => {
    btn.addEventListener("click", () => {
      activeBookingId = btn.dataset.viewPayments;
      setView("payments", activeBookingId);
    });
  });

  wrap.querySelectorAll("[data-cancel-booking]").forEach(btn => {
    btn.addEventListener("click", () => {
      const booking = state.bookings.find(b => b.bookingId === btn.dataset.cancelBooking);
      if (booking && booking.cancellationPending) {
        undoCancellationRequest(booking.bookingId);
      } else {
        confirmCancelBooking(btn.dataset.cancelBooking);
      }
    });
  });
}

function processDueCancellations() {
  const now = Date.now();
  let changed = false;

  state.bookings.forEach(booking => {
    if (!booking.cancellationPending || booking.serverManaged) return;

    const effectiveAt = Date.parse(booking.cancellationEffectiveAt);
    if (!Number.isFinite(effectiveAt)) {
      console.error(`Invalid cancellation deadline for booking ${booking.bookingId}.`);
      return;
    }

    if (effectiveAt <= now) {
      booking.cancelled = true;
      booking.cancelledOn = new Date(effectiveAt).toISOString().slice(0, 10);
      delete booking.cancellationPending;
      delete booking.cancellationRequestedAt;
      delete booking.cancellationEffectiveAt;
      changed = true;
    }
  });

  if (changed) saveState();
  return changed;
}

async function undoCancellationRequest(bookingId) {
  const booking = state.bookings.find(b => b.bookingId === bookingId);
  if (!booking || !booking.cancellationPending) return;

  try {
    if (booking.serverManaged) {
      const result = await reservationApi(`/reservations/${encodeURIComponent(bookingId)}/undo-cancel`, {
        method: "POST",
      });
      Object.assign(booking, result.booking);
    } else {
      delete booking.cancellationPending;
      delete booking.cancellationRequestedAt;
      delete booking.cancellationEffectiveAt;
    }
    saveState();
    toast("Cancellation request withdrawn; the plot remains reserved.");
    renderBookings();
  } catch (error) {
    console.error(`Could not withdraw cancellation for ${bookingId}:`, error);
    toast(error.message);
  }
}

function confirmCancelBooking(bookingId) {
  const booking = state.bookings.find(b => b.bookingId === bookingId);
  if (!booking || booking.cancelled || booking.cancellationPending) return;

  const plot = PLOTS.find(p => p.id === booking.plotId);
  openModal(`
    <h3>Request booking cancellation?</h3>
    <p class="panel-sub">
      The cancellation will stay pending for 5 minutes. ${plot.id} · ${plot.society}, Block ${plot.block}
      will remain reserved during that time. You can withdraw the request before it completes.
      Payment history is retained; this does not process a refund.
    </p>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" id="keepBooking">Keep reservation</button>
      <button type="button" class="btn btn-primary" id="confirmCancelBooking">Request cancellation</button>
    </div>
  `);

  document.getElementById("keepBooking").addEventListener("click", closeModal);
  document.getElementById("confirmCancelBooking").addEventListener("click", async () => {
    const requestedAt = new Date();
    try {
      if (booking.serverManaged) {
        const result = await reservationApi(`/reservations/${encodeURIComponent(bookingId)}/cancel`, {
          method: "POST",
        });
        Object.assign(booking, result.booking);
      } else {
        booking.cancellationPending = true;
        booking.cancellationRequestedAt = requestedAt.toISOString();
        booking.cancellationEffectiveAt = new Date(requestedAt.getTime() + 5 * 60 * 1000).toISOString();
      }
      saveState();
      closeModal();
      toast("Cancellation pending for 5 minutes; the plot remains reserved.");
      renderBookings();
    } catch (error) {
      console.error(`Could not request cancellation for ${bookingId}:`, error);
      toast(error.message);
    }
  });
}
/* ---------------- View: Payments ---------------- */

let activeBookingId = new URLSearchParams(window.location.search).get("booking");

function renderPayments() {
  processDueCancellations();
  const wrap = document.getElementById("viewWrap");
  const visibleBookings = state.bookings.filter(b => !b.cancelled);

  if (!visibleBookings.length) {
    wrap.innerHTML = emptyState(
      "No payments to show",
      "Payments for active bookings will appear here.",
      `<button class="btn btn-primary" id="goBookings">View bookings</button>`
    );
    document.getElementById("goBookings").addEventListener("click", () => setView("bookings"));
    return;
  }

  if (!activeBookingId || !visibleBookings.some(b => String(b.bookingId) === String(activeBookingId))) {
    activeBookingId = visibleBookings[0].bookingId;
  }

  const booking = visibleBookings.find(b => String(b.bookingId) === String(activeBookingId));
  const plot = PLOTS.find(p => p.id === booking.plotId);

  const paidCount = booking.installments.filter(i => i.paid).length;
  const pct = Math.round((paidCount / booking.installments.length) * 100);
  const next = booking.installments.find(i => !i.paid);

  wrap.innerHTML = `
    <div class="booking-switch">
      ${visibleBookings.map(b => {
        const bPlot = PLOTS.find(p => p.id === b.plotId);
        return `<button type="button" class="chip ${b.bookingId === activeBookingId ? "is-active" : ""}" data-payment-booking="${b.bookingId}">
          ${bPlot ? bPlot.id : b.plotId}${b.cancelled ? " · Cancelled" : ""}
        </button>`;
      }).join("")}
    </div>

    <div class="payments-summary">
      <p class="plot-id">${plot.id} <span class="plot-society">· ${plot.society}, Block ${plot.block}</span></p>
      <p class="panel-sub">${paidCount} of ${booking.installments.length} installments paid (${pct}%)</p>
      ${booking.cancellationPending ? `<p class="panel-sub">Cancellation pending until ${new Date(booking.cancellationEffectiveAt).toLocaleString()} · Plot remains reserved.</p>` : ""}
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      ${next ? `
        <div class="next-due-note">
          <p>Next: ${next.label} · ${formatPKR(next.amount)} · Due ${next.dueDate}</p>
        </div>
      ` : `<div class="next-due-note"><p>All payments have been completed.</p></div>`}
      <div class="payments-refresh-row">
        <button type="button" class="btn btn-ghost btn-small" id="refreshPaymentsBtn">Refresh payment status</button>
      </div>
    </div>

    <table class="pay-table">
      <thead>
        <tr>
          <th>Payment</th>
          <th>Amount</th>
          <th>Due date</th>
          <th>Status</th>
          <th>Receipt</th>
        </tr>
      </thead>
      <tbody>
        ${booking.installments.map(inst => `
          <tr class="${inst === next ? "is-next" : ""}">
            <td>${inst.label}</td>
            <td>${formatPKR(inst.amount)}</td>
            <td>${inst.dueDate}</td>
            <td>${inst.paid ? "Paid" : "Pending"}</td>
            <td>
              ${inst.paid
                ? (inst.transactionId
                  ? `<button type="button" class="btn btn-ghost btn-small" data-receipt="${booking.bookingId}|${inst.id}">View receipt</button>`
                  : `<span class="panel-sub">Receipt unavailable</span>`)
                : `<span class="panel-sub">Available when paid</span>`}
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  wrap.querySelector("#refreshPaymentsBtn").addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await syncReservationState();
      renderPayments();
      toast("Payment status refreshed.");
    } catch (error) {
      console.error("Could not refresh payment status.", error);
      toast("Could not refresh payment status. Check your connection and try again.");
      button.disabled = false;
    }
  });

  wrap.querySelectorAll("[data-payment-booking]").forEach(btn => {
    btn.addEventListener("click", () => {
      activeBookingId = btn.dataset.paymentBooking;
      history.replaceState(null, "", `payments.html?booking=${encodeURIComponent(activeBookingId)}`);
      renderPayments();
    });
  });

  wrap.querySelectorAll("[data-receipt]").forEach(btn => {
    btn.addEventListener("click", () => {
      const [bookingId, instId] = btn.dataset.receipt.split("|");
      if (typeof window.openInstallmentReceipt !== "function") {
        console.error("Receipt view is unavailable because its handler did not load.");
        toast("Receipt could not open. Refresh the page and try again.");
        return;
      }
      window.openInstallmentReceipt(bookingId, instId);
    });
  });
}

const CERTIFICATE_TYPE_LABELS = {
  society_registration: "Society registration certificate",
  noc: "NOC",
  approved_layout_plan: "Approved layout plan",
  land_ownership: "Land ownership document",
};

async function renderCertificates() {
  const wrap = document.getElementById("viewWrap");
  wrap.innerHTML = emptyState("Loading society documents", "Fetching secure document records.");
  try {
    const result = await reservationApi("/certificates");
    if (!Array.isArray(result.certificates)) {
      throw new Error("Certificate service returned incomplete data.");
    }
    if (!result.certificates.length) {
      wrap.innerHTML = emptyState(
        "No society documents available",
        "Verified certificates and approvals will appear here when the admin adds them."
      );
      return;
    }

    wrap.innerHTML = `
      <div class="booking-list">
        ${result.certificates.map(certificate => {
          const typeLabel = CERTIFICATE_TYPE_LABELS[certificate.documentType] || "Society document";
          const statusLabel = certificate.verificationStatus === "verified"
            ? "Verified"
            : certificate.verificationStatus === "rejected" ? "Rejected" : "Pending verification";
          return `
            <article class="booking-row">
              <div class="booking-info">
                <p class="plot-id">${escapeHtml(certificate.title)}</p>
                <p class="panel-sub">${escapeHtml(certificate.societyName)} · ${escapeHtml(typeLabel)}</p>
                <p class="panel-sub">Issuing authority: ${escapeHtml(certificate.issuingAuthority)} · Approval No. ${escapeHtml(certificate.approvalNumber)}</p>
                ${certificate.rejectionReason ? `<p class="panel-sub">Review note: ${escapeHtml(certificate.rejectionReason)}</p>` : ""}
              </div>
              <div class="booking-actions">
                <span class="status-pill">${escapeHtml(statusLabel)}</span>
                ${certificate.verificationStatus === "verified"
                  ? `<button type="button" class="btn btn-ghost btn-small" data-open-certificate="${escapeHtml(certificate.id)}">View document</button>`
                  : ""}
              </div>
            </article>
          `;
        }).join("")}
      </div>
    `;

    wrap.querySelectorAll("[data-open-certificate]").forEach(button => {
      const certificate = result.certificates.find(item => String(item.id) === button.dataset.openCertificate);
      button.addEventListener("click", () => openCertificateViewer(certificate));
    });
  } catch (error) {
    console.error("Could not load society documents.", error);
    wrap.innerHTML = emptyState(
      "Society documents unavailable",
      escapeHtml(error.message),
      `<button type="button" class="btn btn-primary" id="retryCertificates">Retry</button>`
    );
    document.getElementById("retryCertificates").addEventListener("click", renderCertificates);
  }
}

window.setInterval(async () => {
  let changed = processDueCancellations();
  try {
    changed = await syncReservationState() || changed;
  } catch (error) {
    console.error("Could not sync reservations with the server.", error);
    if (!reservationSyncFailed) toast("Reservation updates could not be loaded. Check your connection.");
    reservationSyncFailed = true;
  }
  if (!changed) return;
  if (currentView === "bookings") renderBookings();
  if (currentView === "payments") renderPayments();
  if (currentView === "search") renderSearch();
  if (currentView === "recommend") renderRecommend();
}, 60_000);

window.openInstallmentReceipt = function (bookingId, instId) {
  const booking = state.bookings.find(b => String(b.bookingId) === String(bookingId));
  if (!booking || booking.cancelled) {
    console.error(`Cannot open receipt: booking ${bookingId} is missing or cancelled.`);
    toast("This booking's receipt is unavailable.");
    return;
  }
  const plot = PLOTS.find(p => p.id === booking.plotId);
  const inst = booking.installments.find(item => item.id != null && String(item.id) === String(instId));
  if (!plot || !inst) {
    console.error(`Cannot open receipt: plot or installment details are missing for booking ${bookingId}.`);
    toast("Receipt details could not be loaded.");
    return;
  }
  if (!inst.paid || !inst.transactionId) {
    toast("A receipt is available after the payment is confirmed.");
    return;
  }

  const existing = document.getElementById("paReceiptOverlay");
  if (existing) existing.remove();

  const customerName = state.user?.name || "Customer";
  const customerEmail = state.user?.email || "";
  const tid = inst.transactionId;
  const paidDate = inst.paidDate || inst.dueDate;

  const overlay = document.createElement("div");
  overlay.id = "paReceiptOverlay";
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(18,23,63,0.65);display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;z-index:99999;padding:16px;";

  overlay.innerHTML = `
    <div style="background:#FFFFFF;width:100%;max-width:420px;max-height:calc(100vh - 32px);overflow-y:auto;margin:auto 0;border-radius:18px;padding:18px;box-shadow:0 20px 50px rgba(18,23,63,0.3);">
      <div style="background: linear-gradient(180deg, #1E2761 0%, #1E2761 118px, #FFFFFF 118px, #FFFFFF 100%); border-radius: 14px; border: 1.5px solid #E2E5F0; overflow: hidden;">
        <div style="padding: 18px 20px; text-align: center; color: #FFFFFF;">
          <div style="display: inline-block; background: #C9992C; color: #12173F; font-weight: 700; font-size: 11px; letter-spacing: 0.08em; padding: 3px 10px; border-radius: 999px; text-transform: uppercase;">PlotAxis Official Receipt</div>
          <h3 style="margin: 8px 0 2px; font-size: 19px; color: #FFFFFF;">Transaction Successful</h3>
          <p style="margin: 0; font-size: 12px; color: #C9D2F5;">TID: ${tid}</p>
        </div>

        <div style="padding: 18px 22px 14px; text-align: center;">
          <div style="width: 46px; height: 46px; margin: -36px auto 8px; background: #15803D; color: #FFFFFF; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: bold; border: 4px solid #FFFFFF; box-shadow: 0 4px 10px rgba(0,0,0,0.12);">✓</div>
          <p style="margin: 0; font-size: 12px; color: #5D6480; text-transform: uppercase; letter-spacing: 0.06em;">Amount Paid</p>
          <p style="margin: 4px 0 2px; font-size: 26px; font-weight: 800; color: #12173F;">${formatPKR(inst.amount)}</p>
          <span style="display: inline-block; background: #E3F7EB; color: #15803D; font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 999px;">● Verified & Paid</span>
        </div>

        <div style="border-top: 1.5px dashed #D7DCEB; margin: 0 18px;"></div>

        <div class="receipt-details-area">
          <div style="display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #F1F3FA;">
            <span style="color: #5D6480;">Paid By</span>
            <span style="font-weight: 600;">${escapeHtml(customerName)}</span>
          </div>
          ${customerEmail ? `
          <div style="display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #F1F3FA;">
            <span style="color: #5D6480;">Email</span>
            <span style="font-weight: 500;">${escapeHtml(customerEmail)}</span>
          </div>` : ""}
          <div style="display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #F1F3FA;">
            <span style="color: #5D6480;">Plot & Society</span>
            <span style="font-weight: 600;">${escapeHtml(`${plot.id} · ${plot.society} (Block ${plot.block})`)}</span>
          </div>
          <div style="display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #F1F3FA;">
            <span style="color: #5D6480;">Installment</span>
            <span style="font-weight: 600;">${escapeHtml(inst.label)}</span>
          </div>
          <div style="display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #F1F3FA;">
            <span style="color: #5D6480;">Payment Date</span>
            <span style="font-weight: 600;">${escapeHtml(paidDate)}</span>
          </div>
          <div style="display: flex; justify-content: space-between; padding: 6px 0;">
            <span style="color: #5D6480;">Payment Channel</span>
            <span style="font-weight: 600;">Society Office Verified</span>
          </div>
        </div>
      </div>

      <div style="display: flex; gap: 10px; justify-content: center; margin-top: 14px; flex-wrap:wrap;">
        <button type="button" class="btn btn-ghost" onclick="document.getElementById('paReceiptOverlay').remove()">Close</button>
        <button type="button" class="btn btn-ghost" id="printReceiptBtn">Print</button>
        <button type="button" class="btn btn-primary" id="downloadReceiptBtn">Download Receipt (PNG)</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.addEventListener("click", e => {
    if (e.target === overlay) overlay.remove();
  });

  document.getElementById("downloadReceiptBtn").onclick = async () => {
    try {
      await downloadReceiptImage({
        customerName,
        customerEmail,
        plotLabel: `${plot.id} · ${plot.society} (Block ${plot.block})`,
        installmentLabel: inst.label,
        amount: formatPKR(inst.amount),
        paidDate,
        transactionId: tid,
      });
    } catch (error) {
      console.error(`Could not download receipt ${tid}:`, error);
      toast(error.message || "Receipt could not be downloaded.");
    }
  };

  document.getElementById("printReceiptBtn").onclick = async () => {
    try {
      document.body.classList.add("printing-receipt");
      window.print();
    } catch (error) {
      console.error(`Could not print receipt ${tid}:`, error);
      toast(error.message || "Receipt could not be printed.");
    } finally {
      document.body.classList.remove("printing-receipt");
    }
  };
};

function downloadReceiptImage(info) {
  const canvas = document.createElement("canvas");
  canvas.width = 720;
  canvas.height = 900;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Receipt image could not be created in this browser.");

  ctx.fillStyle = "#F4F6FC";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(40, 40, 640, 820);

  ctx.fillStyle = "#1E2761";
  ctx.fillRect(40, 40, 640, 190);

  ctx.fillStyle = "#C9992C";
  ctx.fillRect(235, 68, 250, 32);
  ctx.fillStyle = "#12173F";
  ctx.font = "bold 14px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("PLOTAXIS OFFICIAL RECEIPT", 360, 89);

  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 28px sans-serif";
  ctx.fillText("Transaction Successful", 360, 142);

  ctx.fillStyle = "#C9D2F5";
  ctx.font = "16px sans-serif";
  ctx.fillText(`TID: ${info.transactionId}`, 360, 175);

  ctx.fillStyle = "#15803D";
  ctx.beginPath();
  ctx.arc(360, 230, 36, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = "#FFFFFF";
  ctx.stroke();

  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 34px sans-serif";
  ctx.fillText("✓", 360, 242);

  ctx.fillStyle = "#5D6480";
  ctx.font = "bold 15px sans-serif";
  ctx.fillText("AMOUNT PAID", 360, 305);

  ctx.fillStyle = "#12173F";
  ctx.font = "bold 42px sans-serif";
  ctx.fillText(info.amount, 360, 355);

  ctx.fillStyle = "#E3F7EB";
  ctx.fillRect(270, 375, 180, 32);
  ctx.fillStyle = "#15803D";
  ctx.font = "bold 15px sans-serif";
  ctx.fillText("● Verified & Paid", 360, 396);

  ctx.strokeStyle = "#D7DCEB";
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 8]);
  ctx.beginPath();
  ctx.moveTo(80, 440);
  ctx.lineTo(640, 440);
  ctx.stroke();
  ctx.setLineDash([]);

  const rows = [
    ["Paid By", info.customerName],
    ["Email", info.customerEmail || "N/A"],
    ["Plot & Society", info.plotLabel],
    ["Installment", info.installmentLabel],
    ["Payment Date", info.paidDate],
    ["Payment Channel", "Society Office Verified"],
    ["Transaction ID", info.transactionId],
  ];

  let y = 495;
  rows.forEach(([k, v]) => {
    ctx.textAlign = "left";
    ctx.fillStyle = "#5D6480";
    ctx.font = "18px sans-serif";
    ctx.fillText(k, 85, y);

    ctx.textAlign = "right";
    ctx.fillStyle = "#12173F";
    ctx.font = "bold 18px sans-serif";
    ctx.fillText(String(v), 635, y, 480);

    ctx.strokeStyle = "#F1F3FA";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(85, y + 18);
    ctx.lineTo(635, y + 18);
    ctx.stroke();

    y += 46;
  });

  ctx.textAlign = "center";
  ctx.fillStyle = "#5D6480";
  ctx.font = "14px sans-serif";
  ctx.fillText("Keep this receipt for your records.", 360, 835);

  const link = document.createElement("a");
  link.download = `PlotAxis-Receipt-${info.transactionId}.png`;
  link.href = canvas.toDataURL("image/png");
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  toast("Receipt downloaded!");
}

 
 
  /* ---------------- Shared ---------------- */

function emptyState(title, body, actionHtml = "") {
  return `
    <div class="empty-state">
      <div class="empty-mark"><span></span><span></span></div>
      <h3>${title}</h3>
      <p>${body}</p>
      ${actionHtml}
    </div>
  `;
}

/* ---------------- Boot ---------------- */

if (!state.user || !localStorage.getItem("plotaxis_token")) {
  window.location.replace("index.html");
} else {
  document.getElementById("userName").textContent = state.user.name;
  document.getElementById("userAvatar").textContent = state.user.name.trim()[0]?.toUpperCase() || "C";
  syncReservationState().catch(error => {
    console.error("Could not load reservations from the server.", error);
    reservationSyncFailed = true;
    toast("Reservation updates could not be loaded. Check your connection.");
  }).finally(() => setView(currentView));
}
