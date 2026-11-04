import { $ } from '../common.js';
import { ScanView } from '../scan-view.js';

export function init() {
  const id = decodeURIComponent(location.pathname.split('/').pop() || '');
  new ScanView($('#scan'), id).start();
}
