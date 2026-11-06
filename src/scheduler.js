// Auto check scheduler: every 30 s, start any schedule whose next run is due,
// subject to the owner's plan (number of sites, monthly link quota).
import { getPlan } from './plans.js';

export function advance(date, frequency) {
  const d = new Date(date);
  if (frequency === 'daily') d.setUTCDate(d.getUTCDate() + 1);
  else if (frequency === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

export function nextAfterNow(nextRun, frequency) {
  let d = new Date(nextRun);
  const now = Date.now();
  while (d.getTime() <= now) d = advance(d, frequency);
  return d.toISOString();
}

export function startSchedule({ store, scans, config }, sched, { manual = false } = {}) {
  const owner = store.getUser(sched.owner);
  if (!owner) return { error: 'Owner not found' };
  const plan = getPlan(owner.plan);
  if (!plan.autoSites) return { error: 'Your plan does not include Auto check. Upgrade to run scheduled scans.' };
  if (scans.activeForSchedule(sched.id)) return { error: 'This site is already being scanned.' };
  const remaining = plan.monthlyLinks - store.getUsage(owner.id);
  if (remaining <= 0) return { error: 'Your monthly link quota is used up. It resets on the 1st of the month.' };
  const report = scans.createScan({
    owner: owner.id, type: 'auto', url: sched.url, mode: 'site', scheduleId: sched.id, skipActiveCheck: true,
    checklist: sched.checklist || null, slack: !!(sched.notifySlack && owner.slackWebhookUrl),
    limits: {
      maxLinks: Math.min(remaining, config.scans.autoMaxLinksPerScan),
      maxPages: config.scans.autoMaxPages,
    },
    options: {
      depth: sched.depth, ignore: sched.ignore, timeoutMs: sched.timeoutMs, intervalMs: sched.intervalMs,
      overrideNofollow: sched.overrideNofollow, restrictToDir: sched.restrictToDir,
    },
  });
  store.updateSchedule(sched.id, { lastStartedAt: new Date().toISOString(), lastError: null, lastTrigger: manual ? 'manual' : 'schedule' });
  return { report };
}

export function startScheduler(ctx) {
  const { store } = ctx;
  const tick = () => {
    const now = Date.now();
    for (const s of store.allSchedules()) {
      if (!s.active || !s.nextRun || Date.parse(s.nextRun) > now) continue;
      const res = startSchedule(ctx, s);
      store.updateSchedule(s.id, {
        nextRun: nextAfterNow(s.nextRun, s.frequency),
        ...(res.error ? { lastError: res.error, lastRunAt: new Date().toISOString() } : {}),
      });
      if (res.error) console.log(`[scheduler] ${s.url}: ${res.error}`);
      else console.log(`[scheduler] started auto check of ${s.url} (report ${res.report.id})`);
    }
  };
  const timer = setInterval(tick, 30000);
  timer.unref();
  setTimeout(tick, 2000).unref();
  return { tick, stop: () => clearInterval(timer) };
}
