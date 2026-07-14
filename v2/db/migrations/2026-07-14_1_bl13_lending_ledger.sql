-- ============================================================
-- BL-13 마이그레이션: 대여 장부 보강
--   기한(due_date)·거래처 FK 보조·자산 연결·부분 반납 체계
-- 대상: v2.1.0 이하로 설치된 기존 DB
--   (신규 설치는 01_schema_base.sql / 03_schema_features.sql에 포함)
-- 실행: docker exec -i <db컨테이너> psql -U <유저> -d <DB> < 이 파일
-- 멱등: IF NOT EXISTS / 백필 WHERE 가드. 재실행 무해.
-- 참고: module_inventory_logs.event_type은 CHECK 제약이 없으므로
--   대여 전용 이벤트('lending_out'/'lending_return') 추가에 DDL 불요.
-- ============================================================

-- lendings.due_date: 반납 예정일 — 연체 판정 기준.
-- return_date는 이후 "실반납일" 전용(반납 처리 시각에만 기록).
ALTER TABLE lendings ADD COLUMN IF NOT EXISTS due_date DATE;

-- lendings.counterparty_vendor_id: 거래처 FK 보조.
-- counterparty 자유 텍스트가 본선(타 팀/개인 수용), vendor_name 정확 일치 시 자동 연결.
ALTER TABLE lendings ADD COLUMN IF NOT EXISTS counterparty_vendor_id INTEGER
    REFERENCES vendor_info(id) ON DELETE SET NULL ON UPDATE CASCADE;

-- lending_items.asset_id: 장비 품목의 자산 개체 연결
ALTER TABLE lending_items ADD COLUMN IF NOT EXISTS asset_id INTEGER
    REFERENCES assets(id) ON DELETE SET NULL ON UPDATE CASCADE;

-- lending_items 부분 반납: 누적 반납 수량 + 최종 반납 시각.
-- 불변식: 0 <= returned_quantity <= COALESCE(quantity,1) (모델 계층에서 보장),
--         전 품목 완납 <=> lendings.status='returned'
ALTER TABLE lending_items ADD COLUMN IF NOT EXISTS returned_quantity INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lending_items ADD COLUMN IF NOT EXISTS last_returned_at TIMESTAMPTZ;

-- lending_items.inventory_linked: 등록 시 module_inventory 차감이 실제 일어난 품목 표식.
-- 반납/수정/삭제 시 이 플래그가 참일 때만 재고 복귀 — 코드 재조회 추정 방식은
-- 등록 후 같은 item_code의 재고 행이 생긴 경우 무차감 복귀 오류가 나므로 영속화.
ALTER TABLE lending_items ADD COLUMN IF NOT EXISTS inventory_linked BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_lending_items_asset ON lending_items(asset_id);
CREATE INDEX IF NOT EXISTS idx_lendings_due ON lendings(due_date);

-- 백필 1: 기존 행의 counterparty가 vendor_name과 정확 일치하면 FK 연결
UPDATE lendings l SET counterparty_vendor_id = v.id
FROM vendor_info v
WHERE l.counterparty_vendor_id IS NULL AND v.vendor_name = l.counterparty;

-- 백필 2: 기존 반납완료 건의 품목은 전량 반납으로 간주(수명주기 불변식 정합).
-- active 건(예: 글루시스 차입)은 returned_quantity=0 기본값으로 무변경 — 깨지지 않음.
UPDATE lending_items li SET returned_quantity = COALESCE(li.quantity, 1)
FROM lendings l
WHERE l.id = li.lending_id AND l.status = 'returned' AND li.returned_quantity = 0;
