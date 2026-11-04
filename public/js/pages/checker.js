// Home page and Site check page: the URL form + inline live results.
import { $, api, handleForm, isUser } from '../common.js';
import { ScanView } from '../scan-view.js';

let current = null;

export async function init() {
  const form = $('#checker');
  const scanEl = $('#scan');
  const captchaBox = $('.captcha', form);
  const captchaImg = $('img', captchaBox);
  const captchaInput = $('input', captchaBox);
  let captchaId = null;

  async function newCaptcha() {
    if (isUser()) return;
    try {
      const c = await api('/api/captcha');
      captchaBox.hidden = !c.required;
      captchaId = c.id || null;
      if (c.required) { captchaImg.src = c.image; captchaInput.value = ''; }
    } catch { /* captcha endpoint unavailable; server will report */ }
  }
  $('[data-new-captcha]', form).addEventListener('click', newCaptcha);
  newCaptcha();

  function show(id) {
    current?.stop();
    current = new ScanView(scanEl, id, {
      onFinish: () => { newCaptcha(); $('button[type=submit]', form).disabled = false; },
    });
    current.start();
    scanEl.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  handleForm(form, async (data) => {
    if (!data.url.trim()) { $('#checker-url').focus(); throw new Error('Enter the address of the site or page to check.'); }
    let res;
    try {
      res = await api('/api/scans', {
        method: 'POST',
        body: { url: data.url, mode: data.mode, captchaId, captchaAnswer: data.captchaAnswer, emailWhenDone: !!data.emailWhenDone },
      });
    } catch (err) {
      newCaptcha(); // codes are single-use
      if (err.data?.field === 'captcha') captchaInput.focus();
      throw err;
    }
    const url = new URL(location.href);
    url.searchParams.set('scan', res.id);
    history.replaceState(null, '', url);
    show(res.id);
  });

  // resume a scan after a refresh (?scan=<id>)
  const resume = new URLSearchParams(location.search).get('scan');
  if (resume) show(resume);
  // prefill from ?url=
  const pre = new URLSearchParams(location.search).get('url');
  if (pre) $('#checker-url').value = pre;
}
