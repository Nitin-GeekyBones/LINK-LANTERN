import { $, $$, api, meta, toast } from '../common.js';

export async function init() {
  const m = await meta();
  const note = $('[data-demo-billing]');
  if (note) note.hidden = m.billingMode !== 'demo';
  if (m.user) {
    const cycle = $(`#cycle input[value="${m.user.billingCycle || 'monthly'}"]`);
    if (cycle) cycle.checked = true;
  }
  $$('[data-choose-plan]').forEach((btn) => btn.addEventListener('click', async () => {
    const err = $('#plan-error');
    err.textContent = '';
    btn.disabled = true;
    const cycle = $('#cycle input:checked')?.value || 'monthly';
    try {
      await api('/api/account/plan', { method: 'POST', body: { plan: btn.dataset.choosePlan, cycle } });
      toast('Plan updated.');
      setTimeout(() => location.reload(), 600);
    } catch (e) {
      err.textContent = e.message;
      btn.disabled = false;
    }
  }));
}
