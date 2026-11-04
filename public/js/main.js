// Entry point: run the controller for the current page.
const page = document.body.dataset.page;

const controllers = {
  home: () => import('./pages/checker.js'),
  'site-check': () => import('./pages/checker.js'),
  report: () => import('./pages/report.js'),
  'multi-check': () => import('./pages/multi.js'),
  'auto-check': () => import('./pages/auto.js'),
  reports: () => import('./pages/reports.js'),
  plans: () => import('./pages/plans.js'),
  login: () => import('./pages/auth.js'),
  signup: () => import('./pages/auth.js'),
  forgot: () => import('./pages/auth.js'),
  reset: () => import('./pages/auth.js'),
  account: () => import('./pages/auth.js'),
};

import('./common.js'); // header log-out handler etc.
if (controllers[page]) {
  controllers[page]().then((m) => m.init?.(page)).catch((err) => console.error(err));
}
