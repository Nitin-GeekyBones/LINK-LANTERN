// Log in, sign up, forgotten/reset password and account settings.
import { $, api, handleForm, nextParam, num, toast } from '../common.js';

export async function init(page) {
  // carry ?next= across the login <-> signup links
  const next = new URLSearchParams(location.search).get('next');
  if (next) document.querySelectorAll('[data-keep-next]').forEach((a) => { a.href += `?next=${encodeURIComponent(next)}`; });

  if (page === 'login') {
    handleForm($('#login-form'), async (d) => {
      await api('/api/auth/login', { method: 'POST', body: d });
      location.href = nextParam('/site-check');
    });
  }

  if (page === 'signup') {
    const plan = new URLSearchParams(location.search).get('plan');
    handleForm($('#signup-form'), async (d) => {
      await api('/api/auth/signup', { method: 'POST', body: d });
      location.href = plan ? '/plans' : nextParam('/multi-check');
    });
  }

  if (page === 'forgot') {
    handleForm($('#forgot-form'), async (d, form) => {
      const r = await api('/api/auth/forgot', { method: 'POST', body: d });
      const ok = $('.form-ok', form);
      ok.hidden = false;
      ok.textContent = r.outbox
        ? 'If that address has an account, a reset email is on its way. (This server has no SMTP configured, so the email was saved in data/outbox.)'
        : 'If that address has an account, a reset email is on its way. The link works for one hour.';
    });
  }

  if (page === 'reset') {
    const token = new URLSearchParams(location.search).get('token');
    handleForm($('#reset-form'), async (d) => {
      if (!token) throw new Error('This page needs the link from your reset email.');
      await api('/api/auth/reset', { method: 'POST', body: { token, password: d.password } });
      toast('Password saved. You are logged in.');
      setTimeout(() => { location.href = '/'; }, 800);
    });
  }

  if (page === 'account') {
    const me = await api('/api/me');
    const L = me.limits;
    const planName = me.user.plan.charAt(0).toUpperCase() + me.user.plan.slice(1);
    $('#plan-summary').textContent = L.autoSites
      ? `${planName} plan (billed ${me.user.billingCycle}). Up to ${L.autoSites} scheduled sites and ${num(L.monthlyLinks)} links a month; ${num(L.usedThisMonth)} used so far this month.`
      : `Free plan. Site check and Multi check are included; choose a paid plan to schedule automatic checks. Links checked this month: ${num(L.usedThisMonth)}.`;
    $('#a-email').value = me.user.email;

    handleForm($('#email-form'), async (d, form) => {
      await api('/api/account/email', { method: 'PUT', body: d });
      form.password.value = '';
      toast('Email updated.');
      setTimeout(() => location.reload(), 700);
    });
    handleForm($('#password-form'), async (d, form) => {
      await api('/api/account/password', { method: 'PUT', body: d });
      form.reset();
      toast('Password changed.');
    });
    handleForm($('#delete-form'), async (d) => {
      if (!confirm('Delete your account, reports and schedules permanently?')) return;
      await api('/api/account', { method: 'DELETE', body: d });
      location.href = '/';
    });
  }
}
