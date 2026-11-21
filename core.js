(() => {
  const STORAGE_KEY = "plotaxis_customer_session";
  const API_BASE = "http://localhost:5000/api/auth";
  const API_ROOT = API_BASE.replace(/\/auth$/, "");

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const state = loadState() || {
  user: null,
  requirements: null,
  bookings: [],
};

let bookingIdsChanged = false;
state.bookings.forEach((booking, index) => {
  if (!booking.bookingId) {
    booking.bookingId = `legacy-${booking.plotId}-${booking.bookedOn}-${index}`;
    bookingIdsChanged = true;
  }
});

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

if (bookingIdsChanged) saveState();

function toast(message) {
  const element = document.getElementById("toast");
  if (!element) return;
  element.textContent = message;
  element.classList.remove("is-hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add("is-hidden"), 2600);
}

function togglePassword(button, input) {
  const isVisible = input.type === "password";
  input.type = isVisible ? "text" : "password";
  button.setAttribute("aria-pressed", String(isVisible));
  button.setAttribute("aria-label", isVisible ? "Hide password" : "Show password");
  button.title = isVisible ? "Hide password" : "Show password";
  button.querySelector(".password-toggle-show").classList.toggle("is-hidden", isVisible);
  button.querySelector(".password-toggle-hide").classList.toggle("is-hidden", !isVisible);
}

const passwordToggleMarkup = `
  <svg class="password-toggle-icon password-toggle-show" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>
  <svg class="password-toggle-icon password-toggle-hide is-hidden" viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 5.2A10.7 10.7 0 0 1 12 5c6.4 0 10 7 10 7a14.8 14.8 0 0 1-3.1 3.8M6.2 6.2C3.5 8 2 12 2 12s3.6 7 10 7a10.7 10.7 0 0 0 3-.4"/></svg>
`;

document.querySelectorAll('input[type="password"][data-toggle-password]').forEach(input => {
  let wrapper = input.parentElement;
  if (!wrapper.classList.contains("password-field")) {
    wrapper = document.createElement("span");
    wrapper.className = "password-field";
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "password-toggle";
  button.setAttribute("aria-label", "Show password");
  button.setAttribute("aria-controls", input.id);
  button.setAttribute("aria-pressed", "false");
  button.title = "Show password";
  button.innerHTML = passwordToggleMarkup;
  button.addEventListener("click", () => togglePassword(button, input));
  wrapper.appendChild(button);
});

  window.PlotAxisCore = { STORAGE_KEY, API_BASE, API_ROOT, state, saveState, toast };
})();
