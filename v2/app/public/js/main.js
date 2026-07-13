// Common utility functions

// Auto-dismiss alerts after 5 seconds
document.addEventListener('DOMContentLoaded', function() {
  const alerts = document.querySelectorAll('.alert');
  alerts.forEach(function(alert) {
    setTimeout(function() {
      alert.style.opacity = '0';
      alert.style.transition = 'opacity 0.3s';
      setTimeout(function() { alert.remove(); }, 300);
    }, 5000);
  });
});

// Confirm delete actions
function confirmDelete(message) {
  return confirm(message || '정말 삭제하시겠습니까?');
}

// Format date for display
function formatDate(dateStr) {
  if (!dateStr) return '-';
  var d = new Date(dateStr);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// Open/close modal
function openModal(id) {
  var modal = document.getElementById(id);
  if (modal) modal.classList.add('active');
}

function closeModal(id) {
  var modal = document.getElementById(id);
  if (modal) modal.classList.remove('active');
}

// Close modal on overlay click
document.addEventListener('click', function(e) {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('active');
  }
});

// ── BL-11 후속: 자격증명 [보기]/[복사] 공통 (팝업·상세·수정폼 3곳 공용) ──
// 원칙: 값은 기본 응답/렌더에 없음. [보기] 클릭 시에만 reveal API로 복호화 값을 가져온다.
// span 구조: <span class="cred-cell" data-asset="ID" data-cred="CID" data-has="1">
//              <code class="cred-mask">●●●●●●</code>
//              <button class="cred-reveal">보기</button> <button class="cred-copy" hidden>복사</button>
//            </span>
function revealCredential(btn) {
  var cell = btn.closest('.cred-cell');
  if (!cell) return;
  var code = cell.querySelector('.cred-mask');
  var copyBtn = cell.querySelector('.cred-copy');
  // 이미 표시 중이면 다시 마스킹(토글)
  if (cell.dataset.shown === '1') {
    code.textContent = '●●●●●●';
    cell.dataset.shown = '0';
    cell.removeAttribute('data-value');
    btn.textContent = '보기';
    if (copyBtn) copyBtn.hidden = true;
    return;
  }
  var assetId = cell.dataset.asset, credId = cell.dataset.cred;
  fetch('/assets/' + assetId + '/credential/' + credId + '/reveal')
    .then(function(r) { if (!r.ok) throw new Error('권한 또는 조회 실패'); return r.json(); })
    .then(function(d) {
      code.textContent = d.password || '(빈 값)';
      cell.dataset.shown = '1';
      cell.dataset.value = d.password || '';
      btn.textContent = '숨기기';
      if (copyBtn) copyBtn.hidden = false;
    })
    .catch(function() { code.textContent = '조회 실패'; });
}

// 복사: [보기]로 이미 조회된 값 재사용(추가 API·audit 없음).
// ★ 운영은 http(비-localhost)라 navigator.clipboard 사용 불가 —
//   textarea + execCommand('copy') 폴백. 임시 요소는 즉시 제거해 DOM 잔존 방지.
function copyCredential(btn) {
  var cell = btn.closest('.cred-cell');
  if (!cell || cell.dataset.shown !== '1') return;
  var val = cell.dataset.value || '';
  var ta = document.createElement('textarea');
  ta.value = val;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  var ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta); // 값이 DOM에 잔존하지 않도록 즉시 제거
  var orig = btn.textContent;
  btn.textContent = ok ? '복사됨' : '복사 실패';
  setTimeout(function() { btn.textContent = orig; }, 1500);
}

// Debounce function for search inputs
function debounce(fn, delay) {
  var timer;
  return function() {
    var args = arguments;
    var context = this;
    clearTimeout(timer);
    timer = setTimeout(function() { fn.apply(context, args); }, delay);
  };
}
