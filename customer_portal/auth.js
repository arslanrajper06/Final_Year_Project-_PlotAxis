const { API_BASE, state, saveState, toast } = window.PlotAxisCore;
const page = document.body.dataset.page;

if (page === "login" && state.user && localStorage.getItem("plotaxis_token")) {
  window.location.replace("requirements.html");
}

const passwordRules = [
  { id: "length", label: "at least 8 characters", test: password => password.length >= 8 },
  { id: "uppercase", label: "one uppercase letter", test: password => /[A-Z]/.test(password) },
  { id: "lowercase", label: "one lowercase letter", test: password => /[a-z]/.test(password) },
  { id: "number", label: "one number", test: password => /\d/.test(password) },
  { id: "symbol", label: "one special character", test: password => /[^A-Za-z0-9\s]/.test(password) },
];

function missingPasswordRules(password) {
  return passwordRules.filter(rule => !rule.test(password));
}

function redirectToPortal(user, token) {
  const previousUserId = state.dataUserId ?? state.user?.id;
  if (user.id == null || previousUserId == null || String(previousUserId) !== String(user.id)) {
    state.requirements = null;
    state.bookings = [];
  }
  if (user.id != null) state.dataUserId = user.id;
  localStorage.setItem("plotaxis_token", token);
  state.user = user;
  saveState();
  window.location.replace("requirements.html");
}

if (page === "login") {
  document.getElementById("loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;
    const errorElement = document.getElementById("loginError");
    const button = document.getElementById("loginSubmitBtn");

    errorElement.textContent = "";
    button.disabled = true;
    button.textContent = "Checking...";

    try {
      const response = await fetch(`${API_BASE}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await response.json();

      if (!response.ok) {
        errorElement.textContent = data.message || "Login failed.";
        return;
      }
      if (!data.token || !data.user) {
        errorElement.textContent = "Login response was incomplete. Restart the backend and try again.";
        return;
      }

      redirectToPortal(data.user, data.token);
    } catch (error) {
      errorElement.textContent = "Cannot connect to server. Make sure backend (node server.js) is running.";
    } finally {
      button.disabled = false;
      button.textContent = "Continue";
    }
  });
}

if (page === "register") {
  const phoneInput = document.getElementById("regPhone");
  const passwordInput = document.getElementById("regPassword");
  const confirmInput = document.getElementById("regConfirmPassword");
  let passwordFocused = false;

  function updatePasswordFeedback() {
    const password = passwordInput.value;
    const missing = missingPasswordRules(password);
    const strength = document.getElementById("passwordStrength");
    const guidance = document.querySelector(".password-guidance");
    guidance.hidden = !passwordFocused && !password;

    passwordRules.forEach(rule => {
      const item = document.querySelector(`[data-password-rule="${rule.id}"]`);
      const met = rule.test(password);
      item.classList.toggle("is-met", met);
      item.hidden = met;
      item.querySelector("span").textContent = met ? "✓" : "○";
    });

    strength.classList.toggle("is-strong", password.length > 0 && missing.length === 0);
    strength.classList.toggle("is-weak", password.length > 0 && missing.length > 0);
    strength.textContent = !password
      ? "Create a password to see what is missing."
      : missing.length
        ? "Add the missing requirements above."
        : "✓ Strong password — all requirements met.";

    const confirmPassword = confirmInput.value;
    const matchMessage = document.getElementById("passwordMatchMessage");
    const matches = confirmPassword.length > 0 && confirmPassword === password;
    matchMessage.classList.toggle("is-match", matches);
    matchMessage.classList.toggle("is-mismatch", confirmPassword.length > 0 && !matches);
    matchMessage.textContent = confirmPassword
      ? matches ? "✓ Passwords match." : "Passwords do not match."
      : "";
  }

  phoneInput.addEventListener("input", () => {
    phoneInput.value = phoneInput.value.replace(/\D/g, "").slice(0, 11);
    phoneInput.setCustomValidity(
      !phoneInput.value || /^03\d{9}$/.test(phoneInput.value)
        ? ""
        : "Enter exactly 11 digits starting with 03."
    );
  });
  passwordInput.addEventListener("focus", () => {
    passwordFocused = true;
    updatePasswordFeedback();
  });
  passwordInput.addEventListener("blur", () => {
    passwordFocused = false;
    updatePasswordFeedback();
  });
  passwordInput.addEventListener("input", updatePasswordFeedback);
  confirmInput.addEventListener("input", updatePasswordFeedback);

  document.getElementById("registerForm").addEventListener("submit", async event => {
    event.preventDefault();
    const fullName = document.getElementById("regName").value.trim();
    const email = document.getElementById("regEmail").value.trim();
    const phone = phoneInput.value.trim();
    const password = passwordInput.value;
    const confirmPassword = confirmInput.value;
    const errorElement = document.getElementById("regError");
    const button = document.getElementById("regSubmitBtn");

    errorElement.textContent = "";
    if (!/^03\d{9}$/.test(phone)) {
      errorElement.textContent = "Phone number must be exactly 11 digits and start with 03.";
      return;
    }
    const missingRules = missingPasswordRules(password);
    updatePasswordFeedback();
    if (missingRules.length) {
      errorElement.textContent = `Password is missing: ${missingRules.map(rule => rule.label).join(", ")}.`;
      return;
    }
    if (password !== confirmPassword) {
      errorElement.textContent = "Passwords do not match.";
      return;
    }

    button.disabled = true;
    button.textContent = "Sending OTP...";
    try {
      const response = await fetch(`${API_BASE}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName, email, phone, password }),
      });
      const data = await response.json();
      if (!response.ok) {
        errorElement.textContent = data.message || "Registration failed.";
        return;
      }

      sessionStorage.setItem("plotaxis_pending_auth", JSON.stringify({ email, purpose: "register" }));
      window.location.assign("verify-otp.html");
    } catch (error) {
      errorElement.textContent = "Cannot connect to server. Make sure backend (node server.js) is running.";
    } finally {
      button.disabled = false;
      button.textContent = "Create account";
    }
  });
}

if (page === "verify-otp") {
  let pendingAuth;
  try {
    pendingAuth = JSON.parse(sessionStorage.getItem("plotaxis_pending_auth") || "null");
  } catch (error) {
    console.error("Could not read the pending registration state.", error);
  }

  if (!pendingAuth || pendingAuth.purpose !== "register" || !pendingAuth.email) {
    window.location.replace("register.html");
  } else {
    document.getElementById("otpSubtitle").textContent = `We sent a 6-digit code to ${pendingAuth.email}`;

    document.getElementById("otpForm").addEventListener("submit", async event => {
      event.preventDefault();
      const otp = document.getElementById("otpInput").value.trim();
      const errorElement = document.getElementById("otpError");
      const button = document.getElementById("otpSubmitBtn");

      errorElement.textContent = "";
      button.disabled = true;
      button.textContent = "Verifying...";
      try {
        const response = await fetch(`${API_BASE}/verify-otp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: pendingAuth.email, otp, purpose: pendingAuth.purpose }),
        });
        const data = await response.json();
        if (!response.ok) {
          errorElement.textContent = data.message || "Invalid OTP.";
          return;
        }
        if (!data.token || !data.user) {
          errorElement.textContent = "Verification response was incomplete. Please try again.";
          return;
        }
        sessionStorage.removeItem("plotaxis_pending_auth");
        redirectToPortal(data.user, data.token);
      } catch (error) {
        errorElement.textContent = "Server connection error.";
      } finally {
        button.disabled = false;
        button.textContent = "Verify & Proceed";
      }
    });

    document.getElementById("resendOtpBtn").addEventListener("click", async () => {
      const errorElement = document.getElementById("otpError");
      errorElement.textContent = "Sending new code...";
      try {
        const response = await fetch(`${API_BASE}/resend-otp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(pendingAuth),
        });
        const data = await response.json();
        if (!response.ok) {
          errorElement.textContent = data.message || "Could not resend OTP.";
          return;
        }
        errorElement.textContent = "";
        toast(data.message || "New OTP sent!");
      } catch (error) {
        errorElement.textContent = "Could not resend OTP.";
      }
    });
  }
}
