-- CDU-2: 칠러 → CDU 1:N 냉각 연결
-- 칠러가 여러 CDU에 공급하는 구조를 assets.cooling_source_asset_id(CDU→칠러)로 표현한다.
-- 기존 "칠러→탱크(parent_asset_id)" 연결을 "그 탱크의 CDU.cooling_source = 칠러"로 이전하고,
-- 칠러의 parent_asset_id는 NULL로 바꾼다. (parent_asset_id는 독립형 CDU→탱크 용도로만 유지)
--
-- 멱등: ADD COLUMN/CREATE INDEX IF NOT EXISTS. 데이터 이전 UPDATE도 재실행 시 변경 0건이 되도록 작성.
-- 안전: 한 탱크에 칠러 ≥2대면 CDU 귀속이 모호하므로 전체 트랜잭션 중단(RAISE EXCEPTION).
-- 운영 데이터 조치(랙 내장 TPC-CDU-02 수동 귀속)는 이 파일에 없음 — 별도 ops 파일(승인 후 실행).

BEGIN;

-- 1) 컬럼 + 인덱스 (여러 번 실행해도 안전)
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS cooling_source_asset_id INTEGER
  REFERENCES assets(id) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS idx_assets_cooling_source
  ON assets(cooling_source_asset_id);

-- 2) 가드: 한 탱크에 칠러 2대 이상이면 이전 귀속이 모호 → 전체 중단(롤백)
DO $$
DECLARE
  bad_tanks INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad_tanks FROM (
    SELECT parent_asset_id
    FROM assets
    WHERE asset_type = 'chiller' AND parent_asset_id IS NOT NULL
    GROUP BY parent_asset_id
    HAVING COUNT(*) > 1
  ) t;
  IF bad_tanks > 0 THEN
    RAISE EXCEPTION 'CDU-2 마이그레이션 중단: 칠러가 2대 이상 연결된 탱크 %건 — 수동 매핑 후 재적용', bad_tanks;
  END IF;
END $$;

-- 3) 칠러→탱크 연결을 "그 탱크의 CDU.cooling_source = 칠러"로 이전
--    (같은 탱크를 보던 CDU만. 이미 같은 값이면 UPDATE 생략 → 재실행 시 변경 0건)
UPDATE assets cdu
   SET cooling_source_asset_id = chi.id,
       updated_at = NOW()
  FROM assets chi
 WHERE chi.asset_type = 'chiller'
   AND chi.parent_asset_id IS NOT NULL
   AND cdu.asset_type = 'cdu'
   AND cdu.parent_asset_id = chi.parent_asset_id
   AND cdu.cooling_source_asset_id IS DISTINCT FROM chi.id;

-- 4) 칠러의 탱크 직결 해제 (같은 트랜잭션)
UPDATE assets
   SET parent_asset_id = NULL,
       updated_at = NOW()
 WHERE asset_type = 'chiller'
   AND parent_asset_id IS NOT NULL;

COMMIT;
