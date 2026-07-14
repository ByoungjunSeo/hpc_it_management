# v2 이식 버그 트래킹

작성: 2026-06-30
출처: 사용자 작성 버그이슈.xlsx (수정필요1~3) + audit_logs 화면 발견 건.

## 중요 전제
**이 버그들은 전부 v1에서 이미 존재하던 결함이다.** 마이그레이션이 만든 것이 아님.
따라서 v2로 "v1과 동등하게" 충실 복제하면 버그도 그대로 따라온다.

## 처리 방침: (나) 이식하며 수정
- 각 버그는 해당 라우트/모델을 v2로 이식할 때 **고친 버전으로** 이식한다.
- v1 동작을 그대로 옮기지 않는다. 버그 부분만 의도적으로 다르게 만든다.

## ★ 검증 시 주의 (중요)
- v2 이식 검증의 기본 기준은 "v1과 동등한가"지만,
  **이 문서에 등록된 버그 부분은 의도적으로 v1과 다르게 동작한다.**
- 따라서 검증 중 v1↔v2 차이가 나면, 먼저 이 문서를 확인:
  - 등록된 버그의 수정으로 인한 차이 → **정상(의도된 수정)**
  - 그 외 차이 → 마이그레이션 오류로 조사
- 버그 수정으로 인한 차이는 커밋 메시지/검증 보고에 "BUG-N 수정으로 인한 의도된 차이"로 명시.

## 사용 원칙
- 각 라우트/모델 이식 전 이 문서를 먼저 확인.
- 수정 후 이 문서에 [완료] + 커밋 해시 기록.

---

## BUG-1: 부품 수량 수정 시 사용자 비고 손실
- 상태: [완료] B-4d-5b | 방침: (나) 이식 시 수정 — update-storage 사용자 비고 보존
- 관련(v1): app/routes/moduleInventory.js, app/models/moduleInventory.js,
  app/models/moduleInventoryLog.js (변경 이력 기록 위치)

### 증상 (v1 기존 버그)
모듈 수정 화면 비고란에 사용자가 직접 입력
("2026.06.17 -> 김태훈 박사님이 메모리(HMCG88AHBRA478N) 1개 회수해감") 후 저장하면,
부품 변경 이력 비고에는 자동생성 메시지("수량 변경: 8개 -> 7개")만 남고
사용자 입력 텍스트가 사라짐.

### 기대 동작 (v2에서 고친 모습)
사용자 입력 비고 + 자동생성 메시지를 함께 보존.
예: "수량 변경: 8개 -> 7개 | 2026.06.17 김태훈 박사님이 메모리 1개 회수해감"
(결합 형식/구분자는 이식 시 결정)

### 이식 시 주의
- §5 moduleInventory 동기화 코드(syncModulesToUsageLog) 제거와 겹침.
  이력 기록 경로 재작성 시 사용자 비고 보존을 함께 반영.

---

## BUG-2: 일부 서버 전원 끄기 미동작 (BMC 전원제어)
- 상태: 미처리 | 방침: **확인필요 → 신기능 트랙(예외)** | 단계: 보류
- 관련(v1): 자산 상세 "전원" 탭 (전력분전반 powerPanel.js와 별개),
  BMC/IPMI 제어 로직 + asset_credentials

### 증상 (v1 기존)
AI 서버 3,4,5,6 선택 → 전원 탭 → 끄기 클릭 시 AI 3,4번이 안 꺼짐.
화면에 no_cred 배지 표시.

### 예외 사유 (다른 버그와 달리 (나) 미적용)
- no_cred = 자격증명(asset_credentials) 미등록 → BMC 인증 실패 가능성.
  코드 버그가 아니라 데이터 문제일 수 있음. → v1에서 먼저 확인 권장
  (AI 3,4번 자산에 BMC 자격증명 등록 여부). 데이터 문제면 v1에서 바로 해결 가능.
- BMC 전원제어는 신기능(④ SSH/BMC 팝업)과 같은 영역.
  마이그레이션 범위가 아니라 cutover 후 신기능 트랙에서 통합 설계.

### 결정
- v2 이식 시 전원제어는 "v1과 동등하게"만 옮김(이 버그는 (나) 적용 안 함).
- 기능 보완은 신기능 트랙(④)에서.

### B-4d-3 발견 (원인 추정 정정 단서)
- v1 racks.js power-control이 user/pass 미정의 변수 참조 → 실행 시 crash.
  기존 추정("no_cred=자격증명 데이터 문제")과 다를 수 있음: 일부 서버 전원 미동작이
  데이터가 아니라 이 코드 crash 때문일 가능성.
- B-4d-3b에서 power-control 503 스텁화(3b23c72 이식분 격리). power-status(읽기)는 유지.
- BUG-2 신기능 트랙 진입 시: bmcCred 참조 정정 + no_cred 데이터 양쪽 확인.

---

## BUG-3: 부품 이동 팝업 UI 깨짐
- 상태: [완료] B-4d-9 (v2 수정. 최종 UI 확인은 사용자 브라우저 몫)
  - 원인 확정: 모달 공통 CSS(.modal-overlay/.modal-content 등)가 index.ejs의
    `activeTab === 'inventory'` 분기(L28~810) 안에만 있어, installed 탭(transferModal)에선
    페이지 CSS가 통째로 미렌더 — main.css엔 .modal-overlay만 있고 .modal-content가 없어
    콘텐츠가 스타일 없이 인라인으로 풀림. (추정했던 display:none 누락/토글 불일치 아님)
  - 수정: 모달 CSS 블록을 탭 분기 밖 공통 위치로 이동. 검증: installed 탭 렌더에 CSS 1블록
    포함 + inventory 탭 중복 없음(각 1). 모달 4개(adjust/usage/photo/transfer) 일괄 해소.
- 방침: (나) 수정
- 관련(v1): app/routes/moduleInventory.js (/modules/:id/transfer),
  부품현황 > 설치현황 > 이동 뷰/JS

### 증상 (v1 기존 버그)
설치현황에서 "이동" 클릭 시 이동 팝업의 셀렉트박스/입력필드("선택","이동 사유" 등)가
제대로 렌더되지 않고 서로 겹쳐 보임. 레이아웃 깨짐.

### 기대 동작 (v2에서 고친 모습)
이동 팝업 정상 레이아웃 (대상 자산 선택 + 이동 사유 입력 + 이동 버튼).

### 이식 시 주의
- 이동 기능은 module_transfer_logs에 기록(B-2.8a에서 380행 이전됨).
- UI 깨짐이 단순 CSS/EJS면 이식 시 함께 수정. 큰 개편 필요 시 UI트랙(③)으로 분리 판단.

### B-4d-5c 화면 재현 + 원인 규명 (UI 일괄점검으로 미룸)
- 화면 재현 확인(2026-07-03): /module-inventory 설치현황 탭 "이동" 클릭 시
  모듈 이동 팝업이 모달로 안 뜨고 테이블 위에 인라인으로 풀림(배경 딤 없음).
- 구조는 정상: transferModal이 modal-overlay 클래스 + openModal() 사용(index.ejs L902,938).
  adjustModal/usageModal/modulePhotoModal도 동일 구조.
- 추정 원인: .modal-overlay 기본 display:none 누락 또는 openModal의 .active 토글 불일치
  (index.ejs L342-350 CSS). 공통 문제면 모달 4개 전부 해당 → CSS 1곳 수정으로 일괄 해결 가능.
- 처리: 순수 UI/CSS라 화면 확인 필요. B-4d 라우트 이식 완료 후 UI 일괄점검 세션에서 수정.

---

## BUG-4: audit_logs 변경 이력에 [object Object] 노출
- 상태: 종결(수정 불요, 73fcc83) | 사유: v2 스키마 구조적 소멸(details 단일 JSONB)
- 관련(v1): asset 수정 시 audit 기록 호출부, audit_logs 저장 로직, audit 뷰
- 관련(v2): app/models/auditLog.js, views/audit-log/index.ejs

### 증상 (v1 기존 버그)
이력 화면에서 asset 수정 행 상세가 "before: [object Object], after: [object Object]"로
표시됨. 변경 전/후 값이 객체째 문자열화되어 내용이 안 보임.

### 원인 (정정됨)
- ★ v1(SQLite)에서도 발생하던 버그이므로, **pg 직렬화 문제가 아니다.**
  (앞서 'B-4b Date->ISO 버그 계열'로 추정했으나, v1에서도 보였다는 사용자 확인으로 정정.)
- v1 코드가 before/after 객체를 문자열화 없이 그대로 저장/출력하는 것이 원인으로 추정.
  → 이식 시 audit_logs의 before/after가 실제로 어떻게 저장돼 있는지 먼저 확인(\d + 샘플).

### 기대 동작 (v2에서 고친 모습)
before/after를 사람이 읽게 표시. 예: 변경된 필드만 "필드명: 이전값 -> 이후값",
또는 JSON 보기 좋게 직렬화. (형식은 이식 시 결정)

### 이식 시 주의
- 저장 시점 직렬화(기록부)냐 표시 시점 직렬화(뷰/모델)냐 결정.
- 기존 이전된 audit_logs 데이터에 이미 [object Object] 문자열로 박혀있을 수 있음 →
  과거 데이터는 보정 어려울 수 있고(이미 손실), 신규 기록부터 올바르게 남기는 것이 현실적.
  과거 데이터 보정 여부는 이식 시 별도 판단.

BUG-4 (audit [object Object]) → 종결(수정 불요, ad36abc에서 확인)
사유: v2 audit_logs가 before_value/after_value 2컬럼 → details 단일 JSONB로
재설계됨(B-2.8a). before/after가 details 안에 valid JSON으로 저장되어
[object Object] 발생 물리적 불가. 라우트는 충실이식했으나 v2 스키마상 재현 불가.

---

## BUG-5: 선반 미포함으로 수정했으나 랙 배치도에 선반이 남음
- 상태: 원인규명완료·미룸(B-4d 후반) | 방침: (나) 수정 | 조건부 잠복(영향 0건), 렌더이중화+표기정규화 동반
- 관련(v1): app/routes/assets.js (위치 정보 저장), app/routes/racks.js / serverRooms.js
  (랙 배치도 렌더링), app/models/asset.js, rack.js
- 관련 자산: 글루시스-007 (블레이드 서버, SC6100). 기존 메모의 blade_slot 일관성 이슈와 연관.

### 증상 (v1 기존 버그)
글루시스-007을 Rack#3 → Rack#4로 이동하면서 자산 수정 폼에서 "선반 포함" 체크박스를
해제(선반 없음)하고 저장했으나, 변경 후 랙 배치도(상세)에는 U33에 "선반" 블록이 그대로 표시됨.
저장한 값(선반 없음)과 화면 표시(선반 있음)가 불일치.

### 규명 필요 (이식 시)
- DB에 글루시스-007의 선반 관련 값(blade_slot / 선반 플래그 / 추가 슬롯)이 실제로
  어떻게 저장됐는지 확인. 저장이 잘못된 건지(폼 처리), 렌더링이 옛 값을 그리는 건지 구분.
- 단서: 수정 폼에서 "추가 칸 0", "선반 포함 해제"인데 "총 슬롯 크기 6"으로 표시됨.
  슬롯 계산 로직과 선반 플래그가 따로 노는지 확인.
- 블레이드 서버 특유의 슬롯/선반 처리(글루시스-007 좌측/우측 vs 008 left/right 표기
  불일치, 기존 메모 참조)가 얽혀 있을 수 있음.

### 기대 동작 (v2에서 고친 모습)
"선반 포함" 해제로 저장하면 랙 배치도에도 선반이 표시되지 않음. 저장값과 표시 일치.

### 이식 시 주의
- 랙 배치도 렌더링은 B-4b에서 rooms로 일부 이식됨 → v2 rooms 화면에서도 이 버그가
  재현되는지 먼저 확인 가능. 자산 수정(쓰기)은 B-4d.
- blade_slot 표기 일관성 정리(기존 운영 메모)와 함께 처리 검토.

### B-4d-3c 재현 결과 (원인 완전 규명, 조건부 잠복 — 미룸)
- 재현 안 됨(현재 v2): BUG-5 자산(server/storage/other/switch)은 저장측 클리어 대상
  (cdu/immersion_tank/chiller)이 아니라 위치 안 날아감. 운영 데이터에 발생 시나리오 0건.
- 재현 조건: "비인프라 자산을 인프라 타입(cdu 등)으로 변경" 시 blade_slot/rack_unit 클리어.

### B-4d-9 결정 자료 정리 → B-4d-10에서 미룸 확정
- 지금 고치면: 렌더이중화(rooms/racks 두 곳) + blade_slot 표기 정규화(좌측/우측 vs left/right)
  동반 수정 필요 — 국소 수정이 아님. 미루면: 발생 시나리오 0건 잠복 상태 유지(영향 없음).
- **확정: 미룸 — cutover 후 UI 트랙에서 렌더 이중화 해소와 합동 처리.**
  v1 원본 스크린샷은 이 조작을 실제 했을 때 발생.
- ★ 렌더 이중화: racks.js 라우트 uMap과 detail.ejs 뷰 slotMap이 독립 구축.
  수정 시 양쪽 정합 필요(한쪽만 고치면 불일치).
- ★ blade_slot 표기 불일치: 글루시스-007='좌측/우측'(한글) vs 008='left/right'(영문).
  수정 시 표기 정규화 동반 필요(§7 blade_slot 일관성과 연결).
- 마이그레이션 정합 확인(blade_slot/shelf_size v1==v2).
- 처리: 원인 규명 완료. 조건부 잠복이라 B-4d 후반 또는 블레이드슬롯 정리 트랙에서 수정.

---

## BUG-6: 디스커버리 스캔 적용 시 변동 없는 모듈도 전부 "설치" 기록 + apply_scan 이력 무정보
- 상태: [완료] B-4d-7c (v2 apply-asset 이식 시 수정, 합성 페이로드 S1~S4 검증 통과)
  - (A) diff 기반 유지 + (A′) diff 신규측을 modulesToApply(PSU/메모리 보존본)로 교체 — 무변동 적용 시
    이벤트 0건 + phantom PSU removed 0건 실증. fallback 메모리 경로의 PSU 보존 유실(v1 L393)도 함께 수정.
  - (B) mi_logs notes 합성: `apply_scan (디스크 24->48)` / `apply_scan (메모리 4->2)` 형식 실증.
  - 7e 실환경 실증(2026-07-08, 입회 실스캔 TPC-SV-2U-23): 드리프트 0 상태 apply → 신규 이벤트
    0건 + phantom PSU 0건 + EUL 불변 — 합성 검증(7c)에 실스캔 실증(7e) 추가 완료.
  - v1은 미수정(운영 보존) — v1 데이터의 기존 phantom 이력은 B-7 정리 후보.
- 방침: (나) 이식 시 수정 | 단계: B-4d (discovery — §5 핵심과 직결)
- 관련(v1): app/routes/discovery.js, app/models/computingModule.js,
  app/models/moduleTransferLog.js / inventoryLog 계열, 이력 기록부
- 관련 자산: 글루시스-008-N1/N2 스캔 사례

### 증상 (v1 기존 버그) — 두 결함 결합
(A) 스캔 후 "실제 모듈로 갱신" 시, 실제 변경된 모듈(스토리지-008 디스크 24->48,
    스토리지-007 디스크 2->4)뿐 아니라 변동 없는 모듈(네트워크-004/005/006, 메모리-002,
    CPU-004 등)까지 전부 "설치" 이벤트로 기록됨. 전부 수량변동 0, 비고 apply_scan.
    → 이력 노이즈, 설치 통계 부풀림.
(B) apply_scan 이력에 무엇이 어떻게 변했는지 정보 없음(비고 = "apply_scan"만).
    사용자 요청: apply_scan(24->48)처럼 괄호로 실제 변경 내용 표기.

### §5와의 관계 (중요)
- (A)는 §5 "디스커버리: eul 이중기록 → computing_modules에만 기록, 이력엔 변경 스냅샷"
  리팩토링과 동일 뿌리. v1의 전체 재기록 방식이 원인.
  → §5대로 "실제 변경분만 반영 + 이력은 변경된 모듈만" 재작성하면 해결.
- (B)는 BUG-1(비고 손실)/BUG-4(object Object)와 같은 "이력에 의미있는 정보 남기기" 계열.

### 기대 동작 (v2에서 고친 모습)
- 변경된 모듈만 이벤트 기록(수량변동 0 모듈은 이벤트 생성 안 함).
- 변경 이력 비고에 실제 변화 표기. 예: "apply_scan (디스크 24->48)".

### 이식 시 주의
- discovery 이식은 B-4d의 §5 핵심 작업. BUG-6은 그 작업의 일부로 함께 처리.
- 변경 감지(diff) 로직: 스캔 결과 vs 현재 computing_modules 비교 후, 차이나는 것만 반영.

### BUG-6 보강 (B-4d-7 정찰 발견, 2026-07-07)
- b8512cc 이후 diff 기반 기록으로 (A) 부분 완화 확인. 단 잔존 결함:
  diff 신규측이 modulesToApply(PSU/메모리 보존본)가 아닌 원본 modules(PSU 제거본)를
  사용(discovery.js L634, L670) → 보존되는 PSU가 매 적용마다 phantom removed로 기록되는
  비대칭. fallback 메모리 보존 경로(L389–402)도 동일. v1 데이터에 apply_scan PSU
  removed 6건/installed 8건 실존 — 정황 부합.
- v2 수정 방침(B-4d-7c에서 처리): (A′) diff 기준을 modulesToApply로 교체
  (B) notes에 `apply_scan (타입 old->new)` 합성 — L735 지점.

---

## BUG-7: 랙 미리보기 hover 잔상 (B-6c 윈도우 검증 발견)
- 상태: [완료] B-6c (FIX-A) + B-6e Part4 재발 전수 전환 | 방침: (나) 수정
- 관련(v2): app/views/inventory/form.ejs, app/views/assets/form.ejs

### 증상
사용 등록 화면의 랙 미리보기에서 빈 칸 위로 마우스를 올리면 흰색으로 바뀌고, mouseout
후에도 원복되지 않아 마우스가 지나간 자리가 전부 흰색으로 남음(TUI 다크 테마).

### 원인
빈 칸 `<td>`에 인라인 `onmouseenter="this.style.background='#f0f9ff'"
onmouseleave="this.style.background='#fff'"` — mouseout 복원이 **원래 색을 저장하지 않고
'#fff' 하드코딩**이라 테마 배경과 어긋나 흰색 잔상이 남음.

### 수정 (B-6c)
3곳의 인라인 JS hover 제거 → `class="inv-rack-empty"` + `<style>.inv-rack-empty:hover
{ background:#f0f9ff !important; }`. hover 해제 시 CSS 규칙이 사라져 원배경 자동 복귀
(JS가 style을 안 건드림 = 잔상 원천 제거). onclick(빈 칸 클릭 → Unit 자동입력)은 보존.

### 재발 (B-6e Part4) — 동일 패턴 4곳 추가 발견, 전수 전환 완료
B-6c에서 inventory/form.ejs만 고쳐 동종 패턴이 다른 화면에 잔존:
- inventory/form.ejs:1771 — 가용 IP 조회 모달 IP 버튼 (onmouseenter/leave, #fff 복원)
- assets/form.ejs:841/850/853 — 자산등록 랙 미리보기 빈 칸 (B-6c 당시 미수정분)
- assets/form.ejs:998 — 자산등록 가용 IP 버튼 (onmouseover/out, white 복원)
→ 전부 인라인 hover 제거 + 클래스(`.inv-rack-empty`/`.asset-rack-empty`/`.ip-pick-btn`) +
  `<style>` CSS :hover로 일괄 전환. 잔존 onmouse* 0.
**재발 방지 규약: 인라인 onmouse* / JS로 background 하드코딩 복원 금지 — hover는 CSS :hover만.**

---

## BUG-8: 랙 미리보기 선택 시 전체 백화 (윈도우 2.0.1 스모크 발견)
- 상태: [완료] B-6d 후속 | 방침: (나) 수정 | BUG-7 동일 계열(JS 배경 하드코딩)
- 관련(v2): app/views/inventory/form.ejs, app/views/assets/form.ejs (랙 미리보기)

### 증상
초기 렌더는 다크(정상)인데, 빈 칸 클릭(Unit 선택) 후 하이라이트가 갱신되면 빈 칸 전체가
흰색으로 백화(TUI 다크 테마).

### 원인
- `highlightInvSlots`/`highlightAssetSlots`가 선택 칸 배경을 `cells[c].style.background =
  '#fef3c7'/'#dbeafe'`로 직접 인라인 지정.
- `clearInvSlotHighlight`/`clearAssetSlotHighlight`가 원복을 `cells[c].style.background =
  '#fff'` 하드코딩 → 다크 테마 배경과 어긋나 전체 흰색.
- emptyCell도 인라인 `background:#fff`. (BUG-7과 동일 계열 — JS가 배경을 직접 칠함)

### 수정
- 선택 하이라이트를 클래스 토글로: `.inv-sel-shelf`/`.inv-sel-device`(inventory),
  `.asset-sel-device`(assets) + `<style>` CSS(배경·outline·태그색). 선택 칸(장비 파랑/
  선반 노랑) 유지.
- clear는 `classList.remove(...)`로 원배경 복귀(JS가 배경 직접 안 건드림).
- emptyCell 인라인 `background:#fff` 제거 → 배경은 `.inv-rack-empty`/`.asset-rack-empty`
  CSS가 담당(다크 테마는 tui-theme이 오버라이드). 렌더 JS 문법 파싱 통과.

---

## 조사 판정 기록 (B-6c 윈도우 검증 — 회귀 아님, 향후 재질문 방지)

### INV-1: 사용등록 IP가 IP 관리 화면에 미반영 → [v1 동일 — 회귀 아님]
- 사용등록 IP는 `asset_ips`에 정상 저장. IP 관리 화면은 `ip_addresses` 풀만 조회.
- `IpAddress.syncAssetIps`는 v1·v2 동일하게 `UPDATE ... WHERE ip_address=` — 풀에 있는
  IP만 assigned, 없으면 무효(INSERT 안 함). v1은 서브넷 2,304행 시딩이 전제라 안 드러남.
- 클린 설치(SUBNETS_JSON 미설정 → 풀 0)에선 v1이든 v2든 자산 IP가 화면에 안 뜸.
- 대응: v2/V2.1_BACKLOG.md **BL-5(→ B-6e 승격)** 서브넷 CRUD + 풀 자동생성 설계로 해소 예정.

### INV-2: 입고 직후 블레이드 섀시가 보관 장비 뷰 미표시 → [v1 동일 — 회귀 아님]
- 보관 장비 뷰는 v1·v2 동일 SQL `WHERE rack_id IS NULL AND status IN
  ('inactive','decommissioned')`. 입고는 status 기본 'active' → active 미배치 자산은 제외.
- 즉 입고 직후 섀시/노드는 v1에서도 이 뷰에 안 뜸(자산현황 /assets엔 뜸).
- 대응: v2/V2.1_BACKLOG.md **BL-3(시설 모델 재설계)** 에서 "미배치" 정의 재검토 범위 포함.

---

## 분류 요약

| 버그 | 방침 | 단계 | 비고 |
|------|------|------|------|
| BUG-1 비고 손실 | [완료] B-4d-5b | 사용자 비고+자동메시지 결합 보존 |
| BUG-2 전원 끄기 | 신기능(예외) | 보류 | no_cred 규명 → 신기능 트랙 |
| BUG-3 이동 UI | [완료] B-4d-9 | 모달 CSS 탭분기 밖 이동, 4모달 일괄 (UI 최종확인: 사용자) |
| BUG-4 object Object | 종결(불요) | — | v2 details 단일 JSONB로 구조적 소멸(73fcc83) |
| BUG-5 선반 잔존 | 미룸 확정 | cutover 후 UI 트랙 | 원인규명완료·영향0건, 렌더이중화 해소와 합동 |
| BUG-6 스캔 전체기록/이력무정보 | [완료] B-4d-7c | 변경분만 기록(A·A′) + 비고 합성(B) 실증 |
| BUG-7 랙 미리보기 hover 잔상 | [완료] B-6c | CSS :hover로 대체(FIX-A) |
| BUG-8 랙 미리보기 선택 백화 | [완료] B-6d후속 | 선택 하이라이트 클래스+CSS 전환 |

> **잔여 미해결 = BUG-2(신기능 트랙)·BUG-5(UI 트랙) 2건뿐.** BUG-1/3/4/6/7은 전부 [완료]/종결.
> INV-1/INV-2는 조사 결과 v1 동일(회귀 아님) — 각각 BL-5(→B-6e)/BL-3 백로그로.

## 기술부채 (버그 아님 — 트랙 분류 대기)
- discovery #11 GET /lookup-ip 응답에 자격증명 **평문 password 포함** (B-4d-7b 확인).
  v1 동작 보존으로 v2도 동일 반환 — 보안 트랙 분류 대상(마스킹/권한 분리 등은 cutover 후 결정).

## 마이그레이션 범위 밖 (cutover 후 별도 트랙)
- ③ UI 전반 개선
- ④ SSH/BMC 팝업 접속 신기능 (BUG-2 전원제어 통합)
- 메뉴 정리(가): 신청서/전력분전반(powerPanel)/네트워크(networkLayout) 이식 제외 + 메뉴 숨김

## 운영 인프라 메모 (버그 아님 — 서버 점검 창 대기)

### OPS-1: docker 데몬 libnetwork 스토어 손상 — [해소] 2026-07-12 점검 창 처리
- 증상: 기본 bridge 네트워크로 신규 컨테이너 기동 시
  `failed to update store for object type *libnetwork.endpointCnt: Key not found in store`
  로 실패. **기존 컨테이너(it-assets-db)는 무영향.**
- 당시 우회: 전용 네트워크 생성(`docker network create ...`) 후 그 네트워크로 기동 — 성공.
- 조치 필요: docker 데몬 재시작이 가능한 점검 창에서 정리(재시작 시 대개 스토어 재구축됨).
  **주의: 데몬 재시작은 it-assets-db(운영 v2 DB)를 함께 내리므로 반드시 v2 정지 공지 창에서.**
  it-assets-db는 restart 정책으로 자동 복귀하지만 v2 앱(it-assets-v2)의 PG 커넥션 풀 재확립
  확인까지 점검 항목에 포함할 것.
- **[해소] 2026-07-12 점검 창 실행 (역할 분담: sudo 3건 사용자 / 점검·검증 Claude)**:
  - 절차: 사전 백업(pg_dump 256KB) + 증상 재현 기록(대조군: 기본 bridge `run --rm` →
    `endpointCnt: Key not found in store` exit 125) → v2 정지(19:43) → `systemctl restart
    docker`(치료) → it-assets-db 자동 복귀(unless-stopped, healthy 19:45) → v2 재기동
    (19:50, /login 200).
  - 판정 근거: 치료 후 동일 조건 `docker run --rm postgres:16-alpine echo OPS1-OK` **성공
    (exit 0)** — 대조군과 동일 명령 대비. v1(:3000) 무영향, 테스트 잔재 0.
  - 실측 v2 순단: **약 7분**(정지 확인 19:43:14 → 복귀 확인 19:50:04, 확인 시각 기준 상한).
  - 상세 로그: /tmp/ops1_log_20260712.md.

## 배포 문서결함 (DOC) — 2.0.1 배포 검증 트랙

> DOC-1~5는 B-6c 윈도우 실검증, DOC-6은 down -v 경고(리줌 가이드 B-6 섹션에 기록,
> 전부 2.0.1에 반영 완료). 아래는 B-4 리눅스 설치 검증(2026-07-11)에서 발견된 신규 2건.

### DOC-7: docker-compose.prod.yml 헤더 주석 구버전 잔재 — [완료] 2.0.2 tar 반영
- 증상: 헤더 주석이 `*.tar.gz` + `gunzip -c … | docker load` 전달 방식 안내 — 실물은
  무압축 `.tar`, DEPLOY.md(DOC-2 수정분)는 `docker load -i` 기준. DOC-2 수정 당시 compose
  주석 누락 잔재. 심각도 경미(주석) — 설치 차단 없음.
- 조치: repo compose 주석 현행화 완료. **2.0.1 tar에는 미반영** — 배포 공지문
  (v2/RELEASE_NOTICE_2.0.1.md §5 정오표)으로 보완, 차기(2.0.2+) 패키징에 자동 반영.

### DOC-8: DEPLOY.md §5 cron 예시 경로 `/path/to/v2` 오해 소지 — [완료] 2.0.2 tar 반영
- 증상: 수령자 전개 디렉토리는 `it-assets-dist-2.0.1`이라 "v2" 경로명이 무의미.
  심각도 경미(예시 문구).
- 조치: `<설치 디렉토리>` 일반형 + 예시 경로로 수정 완료(repo). **2.0.1 tar 미반영** —
  공지문 §5 정오표로 보완, 차기 패키징에 자동 반영.

---

## BUG-9: 자식 노드 사용등록이 부모 섀시 위치를 덮어씀
- 상태: [수정 완료] 2026-07-15 (운영 반영 대기) | 방침: (나) 이식하며 수정 — 동기화 로직 전면 제거
- 관련: app/routes/inventory.js(사용등록 POST), app/models/asset.js(update/create),
  app/views/assets/form.ejs(자식 위치 입력 숨김)

### 증상 (조사 6cCB 확정)
입출고 **사용등록** 핸들러(inventory.js 구 847-858)의 "자식→부모 위치 동기화" 블록이
자식 노드의 신규 U 위치를 부모 섀시 행에 복사. 재현: test-001-N1(id 1196)을 U40에
등록 → 부모 test-001(1195)의 U36-U39가 U40으로 소실(두 행 updated_at 동일 초).
역방향 동기화는 없음. 랙 뷰의 "U36-U39 사라짐"은 렌더 버그가 아니라 실제 데이터 이동.

### 기대 동작 (수정된 모습)
- inventory.js 동기화 블록 **제거** — 자식 등록이 부모 위치를 건드리지 않는다.
- 블레이드 노드(parent_asset_id 있음)는 물리적으로 섀시를 벗어날 수 없으므로
  **독립 위치를 갖지 않는다**: Asset.update/create가 parent 있으면 room_id/rack_id/
  rack_unit_start를 강제 NULL(모델 가드). 자산 수정 폼은 자식이면 위치 섹션 숨김+안내.
- 오염 데이터 원복: 1195 → U36-U39(106/12), 자식(1188·1189·1196) 독립 위치 NULL
  (/tmp → db 게이트 SQL).

### 검증 (격리 HTTP 실경로)
섀시 U36-U39 등록 후 노드 N1 U40 등록 → **부모 위치 불변 + 자식 위치 미기록** 확인.
자식 수정 폼 위치 변경 시도 → 무시. 데이터 보정 리허설 PASS.

---

## BUG-10: 다노드 입고 노드의 blade_slot 미저장 + blade_slot 의미 충돌
- 상태: [수정 완료] 2026-07-15 (운영 반영 대기) | 방침: (나) 이식하며 수정 — node_index 분리
- 관련: app/routes/inventory.js(다노드 입고), app/routes/assets.js(BL-2), app/models/asset.js,
  app/views/assets/node-bulk.ejs, db/02_schema_assets.sql, db/migrations/2026-07-15_1_*.sql

### 증상 (조사 6cCB 확정)
다노드 입고(inventory.js 316-342)의 Asset.create에 blade_slot 키 부재 → 입고 노드
전부 NULL(1196~1199 등). 구 부분 유니크 인덱스(idx_assets_parent_slot_unique,
blade_slot 기반)는 NULL을 WHERE에서 제외 → 아무것도 막지 못함. 또한 blade_slot이
랙 렌더용(left/right/SW)과 BL-2 노드슬롯(숫자) 두 의미를 겸해 충돌. BL-2 라우트 자체는
정상이나 실사용 본선(입고)을 커버하는 검증 부재(6cCA는 모델 직접 호출).

### 기대 동작 (수정된 모습)
- **node_index INTEGER** 신설(블레이드 노드 번호 전용). blade_slot은 렌더용 의미로 원복.
- 부분 유니크 인덱스 교체: (parent_asset_id, node_index) WHERE 둘 다 NOT NULL.
- 다노드 입고·BL-2 양쪽에서 node_index 자동/입력 부여, 같은 부모 내 유일성 보장.
- 랙 노드 배지는 node_index 참조(없으면 순번 fallback).

### 검증 (격리 HTTP 실경로)
입고 4노드 → node_index 1~4 자동. BL-2 5·6 등록 → 저장·blade_slot NULL 유지. 같은
node_index 재시도 → 앱 거절 + 전체 롤백, DB 유니크 인덱스 위반도 backstop 확인.
신규설치/업그레이드(마이그레이션) 스키마 동등성 확인. blade_slot left/right 렌더 정상.
