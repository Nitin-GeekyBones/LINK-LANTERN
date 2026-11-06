// Subscription plans. Prices are display-only; with BILLING_MODE=demo users can
// switch plans freely. Limits are enforced by the scan manager and scheduler.
// `checklist`: the content checklist (text search) on every scan type.
export const PLANS = {
  free: {
    id: 'free', name: 'Free', tagline: 'Manual checks, any time',
    priceMonthly: 0, priceYearly: 0,
    autoSites: 0, monthlyLinks: 0, checklist: false,
  },
  starter: {
    id: 'starter', name: 'Starter', tagline: 'For a handful of sites',
    priceMonthly: 8, priceYearly: 80,
    autoSites: 5, monthlyLinks: 50000, checklist: true,
  },
  team: {
    id: 'team', name: 'Team', tagline: 'For busy content teams', popular: true,
    priceMonthly: 35, priceYearly: 350,
    autoSites: 100, monthlyLinks: 500000, checklist: true,
  },
  agency: {
    id: 'agency', name: 'Agency', tagline: 'For client portfolios',
    priceMonthly: 75, priceYearly: 750,
    autoSites: 200, monthlyLinks: 1000000, checklist: true,
  },
};

export function getPlan(id) {
  return PLANS[id] || PLANS.free;
}
