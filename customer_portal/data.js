/* ---------------------------------------------------------------
   PlotAxis — mock data layer
   In the real system this is replaced by calls to the PlotAxis
   REST API (see Slide 11 of the proposal: FastAPI / Node backend).
   Everything here is in-memory + localStorage only.
----------------------------------------------------------------*/

const CATEGORIES = ["Residential", "Commercial", "Corner Plot", "Park Facing"];

const PLOTS = [
  { id: "SV-A-014", society: "Silver Valley", block: "A", size: 125, price: 2850000, category: "Residential", status: "Available", tags: ["Corner", "Main road"] },
  { id: "SV-B-002", society: "Silver Valley", block: "B", size: 200, price: 4650000, category: "Corner Plot", status: "Available", tags: ["Corner", "Park facing"] },
  { id: "SV-C-031", society: "Silver Valley", block: "C", size: 120, price: 2600000, category: "Residential", status: "Available", tags: ["Near mosque"] },
  { id: "GH-A-007", society: "Green Horizon", block: "A", size: 500, price: 15800000, category: "Commercial", status: "Available", tags: ["Main boulevard"] },
  { id: "GH-D-019", society: "Green Horizon", block: "D", size: 125, price: 3100000, category: "Park Facing", status: "Available", tags: ["Park facing", "Quiet street"] },
  { id: "GH-D-022", society: "Green Horizon", block: "D", size: 125, price: 3050000, category: "Residential", status: "Available", tags: ["Near park"] },
  { id: "RM-E-005", society: "Riverside Meadows", block: "E", size: 250, price: 5900000, category: "Residential", status: "Available", tags: ["Wide street"] },
  { id: "RM-F-011", society: "Riverside Meadows", block: "F", size: 1000, price: 31500000, category: "Commercial", status: "Available", tags: ["Highway facing"] },
  { id: "RM-G-040", society: "Riverside Meadows", block: "G", size: 120, price: 2450000, category: "Residential", status: "Available", tags: ["Near school"] },
  { id: "OE-B-003", society: "Orchard Estate", block: "B", size: 200, price: 4400000, category: "Corner Plot", status: "Available", tags: ["Corner", "Two side open"] },
  { id: "OE-C-018", society: "Orchard Estate", block: "C", size: 125, price: 2950000, category: "Residential", status: "Available", tags: ["Near club house"] },
  { id: "OE-C-027", society: "Orchard Estate", block: "C", size: 125, price: 2900000, category: "Residential", status: "Available", tags: ["Central location"] },
  { id: "LP-A-009", society: "Lakeview Phase 1", block: "A", size: 300, price: 7800000, category: "Park Facing", status: "Available", tags: ["Lake facing", "Park facing"] },
  { id: "LP-B-016", society: "Lakeview Phase 1", block: "B", size: 200, price: 4950000, category: "Residential", status: "Available", tags: ["Near entrance"] },
  { id: "LP-B-021", society: "Lakeview Phase 1", block: "B", size: 120, price: 2700000, category: "Residential", status: "Available", tags: [] },
  { id: "SV-D-044", society: "Silver Valley", block: "D", size: 500, price: 13200000, category: "Commercial", status: "Available", tags: ["Main market"] },
  { id: "GH-E-029", society: "Green Horizon", block: "E", size: 250, price: 5600000, category: "Corner Plot", status: "Available", tags: ["Corner", "Wide street"] },
  { id: "RM-H-052", society: "Riverside Meadows", block: "H", size: 125, price: 2500000, category: "Residential", status: "Available", tags: ["Affordable", "Near school"] },
];

const SOCIETIES = [...new Set(PLOTS.map(p => p.society))];

function formatPKR(n) {
  if (n >= 10000000) return "PKR " + (n / 10000000).toFixed(2).replace(/\.00$/, "") + " crore";
  if (n >= 100000) return "PKR " + (n / 100000).toFixed(2).replace(/\.00$/, "") + " lac";
  return "PKR " + n.toLocaleString();
}

  function scorePlot(plot, req) {
  if (!req) return 0;
  let score = 0;

  const over = plot.price > req.budgetMax ? (plot.price - req.budgetMax) / req.budgetMax : 0;
  const under = plot.price < req.budgetMin ? (req.budgetMin - plot.price) / req.budgetMin : 0;
  score += Math.max(0, 40 - (over + under) * 120);

  const sizeMid = (req.sizeMin + req.sizeMax) / 2;
  const sizeSpread = Math.max(1, (req.sizeMax - req.sizeMin) / 2);
  const sizeDelta = Math.abs(plot.size - sizeMid) / sizeSpread;
  score += Math.max(0, 25 - sizeDelta * 15);

  const selectedSocieties = Array.isArray(req.societies)
    ? req.societies
    : (req.society && req.society !== "Any" ? [req.society] : []);
  if (selectedSocieties.length === 0 || selectedSocieties.includes(plot.society)) {
    score += 20;
  }

  const selectedCategories = Array.isArray(req.categories)
    ? req.categories
    : (req.category && req.category !== "Any" ? [req.category] : []);
  if (selectedCategories.length === 0 || selectedCategories.includes(plot.category)) {
    score += 15;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

 function buildInstallmentPlan(plot, bookedOn) {
  const down = Math.round(plot.price * 0.2);
  const remaining = plot.price - down;
  const perInstallment = Math.round(remaining / 16);
  const items = [
    { id: "down", label: "Down payment", amount: down, dueDate: bookedOn, paid: false },
  ];
  const base = new Date(bookedOn);
  for (let i = 1; i <= 16; i++) {
    const due = new Date(base);
    due.setMonth(due.getMonth() + i * 3);
    items.push({
      id: `q-${i}`,
      label: `Installment ${i} of 16`,
      amount: perInstallment,
      dueDate: due.toISOString().slice(0, 10),
      paid: false,
    });
  }
  return items;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { PLOTS, buildInstallmentPlan };
}
