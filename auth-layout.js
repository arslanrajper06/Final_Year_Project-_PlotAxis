(() => {
  const visual = document.getElementById("authVisual");
  visual.innerHTML = `
  <div class="plot-grid" aria-hidden="true">
    <span></span><span></span><span></span><span></span>
    <span></span><span></span><span></span><span></span>
    <span></span><span></span><span></span><span></span>
  </div>
  <div class="auth-visual-copy">
    <p class="eyebrow">PlotAxis customer portal</p>
    <h1>Find your plot. Book it. Watch it come together.</h1>
    <p class="lede">Search live inventory across every society on the platform, get matches ranked for your budget and taste, and keep every installment in view — all from one account.</p>
  </div>
`;

  const toastElement = document.createElement("div");
  toastElement.id = "toast";
  toastElement.className = "toast is-hidden";
  document.body.appendChild(toastElement);
})();
