(() => {
const VIEW_META = {
  requirements: { title: "Your requirements", eyebrow: "Step 1 · Tell us what you need", file: "requirements.html" },
  search: { title: "Search plots", eyebrow: "Step 2 · Browse live inventory", file: "search.html" },
  recommend: { title: "Recommended for you", eyebrow: "Step 3 · Matched to your requirements", file: "recommendations.html" },
  bookings: { title: "My bookings", eyebrow: "Reserved and booked plots", file: "bookings.html" },
  payments: { title: "Installments & payments", eyebrow: "Track every due date", file: "payments.html" },
  certificates: { title: "Society verification", eyebrow: "Verified society documents", file: "society-verification.html" },
};

const currentPage = document.body.dataset.page;
if (!VIEW_META[currentPage]) {
  throw new Error(`Unknown customer portal page: ${currentPage}`);
}

window.PlotAxisPageMeta = VIEW_META;

const navigation = [
  ["requirements", '<path d="M4 6h16M4 12h10M4 18h7"/>', "Your requirements"],
  ["search", '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>', "Search plots"],
  ["recommend", '<path d="M12 2l2.6 6.6L21 11l-6.4 2.4L12 20l-2.6-6.6L3 11l6.4-2.4z"/>', "Recommended for you"],
  ["bookings", '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>', "My bookings"],
  ["payments", '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>', "Installments & payments"],
  ["certificates", '<path d="M12 3 19 6v5c0 4.5-2.8 7.8-7 10-4.2-2.2-7-5.5-7-10V6l7-3Z"/><path d="m9 12 2 2 4-4"/>', "Society verification"],
];

document.getElementById("portalRoot").innerHTML = `
  <div class="app-shell">
    <aside class="sidebar">
      <a class="brand" href="requirements.html" aria-label="PlotAxis home">
        <span class="brand-mark"><span></span><span></span><span></span><span></span></span>
        <span class="brand-copy">
          <span class="brand-name">PlotAxis</span>
          <span class="brand-tagline">LAND & LIFESTYLE</span>
        </span>
      </a>
      <p class="side-label">YOUR SPACE</p>
      <nav class="side-nav" id="sideNav" aria-label="Customer portal">
        ${navigation.map(([page, icon, label]) => `
          <a class="nav-item ${page === currentPage ? "is-active" : ""}" data-view="${page}" href="${VIEW_META[page].file}" title="${label}" ${page === currentPage ? 'aria-current="page"' : ""}>
            <svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><span>${label}</span>
          </a>
        `).join("")}
      </nav>
    </aside>
    <main class="main">
      <header class="topbar">
        <div class="topbar-heading">
          <p class="topbar-eyebrow" id="topbarEyebrow"><span class="eyebrow-dot" aria-hidden="true"></span>${VIEW_META[currentPage].eyebrow}</p>
          <h2 id="topbarTitle">${VIEW_META[currentPage].title}</h2>
        </div>
        <div class="topbar-actions">
          <div class="topbar-user">
            <span class="avatar" id="userAvatar">C</span>
            <div class="user-details">
              <p class="user-name" id="userName">Customer</p>
              <p class="user-sub">Customer</p>
            </div>
          </div>
          <button class="topbar-logout" id="logoutBtn" type="button" aria-label="Log out" title="Log out">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>
            <span>Log out</span>
          </button>
        </div>
      </header>
      <div class="view-wrap" id="viewWrap"></div>
    </main>
  </div>
  <div id="modalLayer" class="modal-layer is-hidden"><div class="modal-card" id="modalCard"></div></div>
  <div id="toast" class="toast is-hidden"></div>
`;

document.title = `PlotAxis — ${VIEW_META[currentPage].title}`;
})();
