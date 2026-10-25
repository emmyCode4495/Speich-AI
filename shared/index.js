/** Default minute packs (admin can override via DB later) */
const DEFAULT_PACKS = [
  { id: "p30", label: "Starter", minutes: 30, priceUsd: 5, sortOrder: 10 },
  { id: "p120", label: "Standard", minutes: 120, priceUsd: 15, sortOrder: 20 },
  { id: "p300", label: "Pro", minutes: 300, priceUsd: 30, sortOrder: 30 },
  { id: "p1000", label: "Studio", minutes: 1000, priceUsd: 80, sortOrder: 40 }
];

module.exports = { DEFAULT_PACKS };
