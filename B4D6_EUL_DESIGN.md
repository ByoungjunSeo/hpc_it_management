# B-4d-6 EUL 이벤트소싱 매핑 설계 (확정: 2026-07-03)

## 1. 핵심 원리
- v1 EUL = status 컬럼 단일행 모델. v2 EUL = event_type 이벤트 시퀀스 모델.
- v1 입출고 화면 = 이벤트 행 나열(집계 아님). findAllEquipment=SELECT * 확인됨.
- 매핑 = status↔event_type 치환 + 55개별컬럼↔JSONB 3개.
- 읽기 보상층(EVENT_TYPE_LABEL, 가상 status 필드)은 B-4b에 이미 존재 → 재사용/확장.

## 2. status ↔ event_type 매핑
| v1 status | v2 event_type |
|-----------|---------------|
| 입고 | incoming |
| 사용중 | in_use |
| 반납완료 | returned |
- 읽기: status = EVENT_TYPE_LABEL[event_type] 가상필드 (이미 있음)
- 쓰기: event_type = STATUS_TO_EVENT[status] (역매핑, 신규)

## 3. 55개별컬럼 ↔ JSONB 3개
- hardware_snapshot: cpu_type,cpu_num,mem1_type~gpu2_num
- network_snapshot: ip1~ip4,bmc,ib1,ib2
- credentials_snapshot: credential_root,etc1,etc2
- 읽기(뷰 평탄화): row.cpu_type = hardware_snapshot?.cpu_type ... (뷰 안 고치게 모델이 펼침)
- 쓰기(입력→JSONB): 헬퍼가 data.cpu_type... → {cpu_type:...} 묶음
- v1 hardware_json/credentials_json/ips_json(이중저장)은 v2 JSONB로 대체(§5)

## 4. 날짜 매핑 (event_date NOT NULL)
- v1 usage_date/return_date(2개) → v2 event_date(1개, 이벤트별)
- 입고/사용: event_date=usage_date / 반납: event_date=return_date
- event_date NOT NULL → 쓰기 시 반드시 채움(없으면 CURRENT_DATE)

## 5. 쓰기 방침 (하이브리드) — 확정
| v1 메서드 | v1 동작 | v2 방식 |
|-----------|---------|---------|
| create | INSERT | INSERT event_type |
| markReturned | UPDATE status='반납완료' | append INSERT returned 이벤트 |
| returnActiveByManagement | UPDATE WHERE status='사용중' | append INSERT returned (mgmt별 최신 in_use 대상) |
| update | UPDATE 행 내용 | UPDATE (내용정정, 트리거제거로 가능) |
| delete | DELETE WHERE id | DELETE (v1대로 충실이식) |
- 원칙: 상태전이(반납)=append INSERT / 내용정정=UPDATE / 생성=INSERT / 삭제=DELETE
- 사유: v2 데이터가 append 시퀀스로 쌓여 있어 반납도 append여야 일관.

## 6. 읽기 메서드 (status→event_type 치환)
- findAllEquipment: SELECT * WHERE event_type=? [+필터], NOT EXISTS module_inventory 유지
- getLatestByManagement: mgmt별 최신 이벤트(ORDER BY id DESC LIMIT 1)
- getHistory: mgmt 전체 이벤트 시퀀스
- countByStatusEquipment: event_type GROUP BY (countByStatus 이미 있음, equipment판 추가)
- findById, getRoomsEquipment, getUsersEquipment

## 7. 성격 (방법론)
- 충실이식 아님. §5 이벤트소싱 실현(B-2.8b 데이터이전 + B-4d-2.5 트리거제거의 완성).
- 검증기준: 화면 상태표시가 v1과 같고 이력이 정확히 쌓이는가.

## 8. 하위단계
- 6a: EUL 모델 확장 (읽기 7 + 쓰기 4 + JSONB 헬퍼 + STATUS_TO_EVENT)
- 6b: 라우트 헬퍼 (입력→JSONB, mgmt번호 생성)
- 6c: 라우트 18EP (무접촉5/읽기5/쓰기5/migrate-psu)
- 6d: 뷰 4개 복사 + JSONB 평탄화 검증
