const adminKeyForm = document.getElementById("adminKeyForm");
const adminKeyInput = document.getElementById("adminKey");
const adminStatus = document.getElementById("adminStatus");
const reservationList = document.getElementById("reservationList");
const loadReservationsButton = document.getElementById("loadReservationsBtn");
const refreshReservationsButton = document.getElementById("refreshReservationsBtn");
const clearAdminKeyButton = document.getElementById("clearAdminKeyBtn");
const adminKeyCard = document.getElementById("adminKeyCard");
const pendingPaymentsQueue = document.getElementById("pendingPaymentsQueue");

let adminApiKey = "";

function setStatus(message, isError = false) {
  adminStatus.textContent = message;
  adminStatus.classList.toggle("admin-status--error", isError);
}

function formatPKR(amount) {
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    maximumFractionDigits: 0,
  }).format(amount);
}

async function adminApi(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      "x-admin-key": adminApiKey,
      ...(options.headers || {}),
    },
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || `Admin request failed (${response.status}).`);
  return data;
}

function createTextElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function renderReservations(reservations) {
  reservationList.replaceChildren();
  if (!reservations.length) {
    reservationList.appendChild(
      createTextElement("p", "admin-empty", "No pending down payments.")
    );
    return;
  }

  reservations.forEach(reservation => {
    const card = document.createElement("article");
    card.className = "admin-reservation-card";

    const details = document.createElement("div");
    details.className = "admin-reservation-details";
    details.append(
      createTextElement("h3", "", `${reservation.plotId} · ${reservation.customerName}`),
      createTextElement("p", "", `Down payment: ${formatPKR(reservation.downPaymentAmount)}`),
      createTextElement("p", "admin-reservation-meta", `Booking ID: ${reservation.bookingId}`),
      createTextElement("p", "admin-reservation-meta", `Reserved: ${new Date(reservation.reservedAt).toLocaleString()}`)
    );

    const confirmButton = document.createElement("button");
    confirmButton.type = "button";
    confirmButton.className = "btn btn-primary";
    confirmButton.textContent = "Confirm payment received";
    confirmButton.addEventListener("click", () => confirmPayment(reservation, confirmButton));

    card.append(details, confirmButton);
    reservationList.appendChild(card);
  });
}

async function loadReservations() {
  if (!adminApiKey) {
    setStatus("Enter the admin API key first.", true);
    return;
  }

  loadReservationsButton.disabled = true;
  refreshReservationsButton.disabled = true;
  setStatus("Loading pending reservations…");
  try {
    const data = await adminApi("/admin/reservations");
    if (!Array.isArray(data.reservations)) {
      throw new Error("The admin API returned an invalid reservations list.");
    }
    renderReservations(data.reservations);
    refreshReservationsButton.disabled = false;
    setStatus(`${data.reservations.length} pending down payment${data.reservations.length === 1 ? "" : "s"}.`);
  } catch (error) {
    console.error("Could not load admin reservations:", error);
    setStatus(error.message, true);
    reservationList.replaceChildren(
      createTextElement("p", "admin-empty admin-empty--error", error.message)
    );
  } finally {
    loadReservationsButton.disabled = false;
  }
}

async function confirmPayment(reservation, button) {
  const amount = formatPKR(reservation.downPaymentAmount);
  const confirmed = window.confirm(
    `Confirm that ${amount} has actually been received for ${reservation.plotId} (${reservation.customerName})? This records the payment and creates a downloadable receipt.`
  );
  if (!confirmed) return;

  button.disabled = true;
  setStatus(`Recording payment for ${reservation.plotId}…`);
  try {
    await adminApi(
      `/admin/reservations/${encodeURIComponent(reservation.bookingId)}/payment-verified`,
      { method: "POST" }
    );
    await loadReservations();
    setStatus(`Payment confirmed for ${reservation.plotId}. Customer can now view and download the receipt from Installments & payments.`);
  } catch (error) {
    console.error(`Could not confirm payment for ${reservation.bookingId}:`, error);
    setStatus(error.message, true);
    button.disabled = false;
  }
}

adminKeyForm.addEventListener("submit", event => {
  event.preventDefault();
  adminApiKey = adminKeyInput.value.trim();
  loadReservations();
});

refreshReservationsButton.addEventListener("click", loadReservations);
clearAdminKeyButton.addEventListener("click", () => {
  adminApiKey = "";
  adminKeyInput.value = "";
  refreshReservationsButton.disabled = true;
  reservationList.replaceChildren(
    createTextElement("p", "admin-empty", "Authenticate to load pending reservations.")
  );
  setStatus("Admin key cleared. Enter the key to continue.");
});

