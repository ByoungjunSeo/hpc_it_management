#!/usr/bin/env python3
"""Capture screenshots of all major pages for the user guide.
Includes step-by-step annotated screenshots with numbered markers."""
import os
import sys
import time
import math
import geckodriver_autoinstaller

geckodriver_autoinstaller.install()

from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import Select
from PIL import Image, ImageDraw, ImageFont

BASE = "http://localhost:3000"
OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'screenshots')
os.makedirs(OUT, exist_ok=True)

opts = Options()
opts.add_argument('--headless')
opts.add_argument('--width=1400')
opts.add_argument('--height=900')

driver = webdriver.Firefox(options=opts)
driver.set_window_size(1400, 900)

# ──────────────────────────────────────────────
# Annotation helpers using PIL
# ──────────────────────────────────────────────
RED = (239, 68, 68)
RED_FILL = (239, 68, 68, 60)
WHITE_C = (255, 255, 255)
MARKER_RADIUS = 18

def get_font(size=20):
    """Get a font, falling back to default if not found."""
    for fp in ['/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
               '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
               '/usr/share/fonts/liberation/LiberationSans-Bold.ttf',
               '/usr/share/fonts/google-drosans/DroidSans-Bold.ttf']:
        if os.path.exists(fp):
            return ImageFont.truetype(fp, size)
    try:
        return ImageFont.truetype("DejaVuSans-Bold.ttf", size)
    except:
        return ImageFont.load_default()

FONT_NUM = get_font(22)
FONT_NUM_SM = get_font(18)


def draw_marker(draw, x, y, number, radius=MARKER_RADIUS):
    """Draw a red circle with a white number at (x, y)."""
    draw.ellipse([x - radius, y - radius, x + radius, y + radius],
                 fill=RED, outline=(180, 30, 30), width=2)
    text = str(number)
    font = FONT_NUM if len(text) == 1 else FONT_NUM_SM
    bbox = font.getbbox(text)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text((x - tw / 2, y - th / 2 - 2), text, fill=WHITE_C, font=font)


def draw_rect_outline(draw, x, y, w, h, color=RED, width=3):
    """Draw a rectangle outline."""
    draw.rectangle([x, y, x + w, y + h], outline=color, width=width)


def annotate_screenshot(img_path, annotations, output_path=None):
    """Add numbered markers and rectangles to a screenshot.

    annotations: list of dicts with:
      - num: int (marker number)
      - element: Selenium element (for auto position) or None
      - x, y, w, h: manual position/size
      - marker_pos: 'top-left'(default), 'top-right', 'center', 'left', 'right'
      - rect: bool (draw rectangle outline, default True)
    """
    if not output_path:
        output_path = img_path

    img = Image.open(img_path).convert('RGBA')
    overlay = Image.new('RGBA', img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    for ann in annotations:
        x = ann.get('x', 0)
        y = ann.get('y', 0)
        w = ann.get('w', 0)
        h = ann.get('h', 0)

        # Draw semi-transparent filled rectangle
        if ann.get('rect', True) and w > 0 and h > 0:
            draw.rectangle([x, y, x + w, y + h], fill=(239, 68, 68, 25),
                           outline=RED, width=3)

        # Determine marker position
        mp = ann.get('marker_pos', 'top-left')
        r = MARKER_RADIUS
        if mp == 'top-left':
            mx, my = x - r, y - r
        elif mp == 'top-right':
            mx, my = x + w + r, y - r
        elif mp == 'left':
            mx, my = x - r * 2 - 4, y + h / 2
        elif mp == 'right':
            mx, my = x + w + r + 4, y + h / 2
        elif mp == 'center':
            mx, my = x + w / 2, y + h / 2
        else:
            mx, my = x - r, y - r

        # Ensure marker stays in bounds
        mx = max(r + 2, min(mx, img.width - r - 2))
        my = max(r + 2, min(my, img.height - r - 2))

        draw_marker(draw, mx, my, ann['num'])

    result = Image.alpha_composite(img, overlay).convert('RGB')
    result.save(output_path)
    return output_path


def get_elem_rect(element):
    """Get element position and size accounting for page scroll."""
    rect = driver.execute_script("""
        var r = arguments[0].getBoundingClientRect();
        return {x: r.x, y: r.y, w: r.width, h: r.height};
    """, element)
    return rect


def screenshot(name, url=None, sleep=1.5, full=False):
    if url:
        driver.get(url)
        time.sleep(sleep)
    path = os.path.join(OUT, name + '.png')
    if full:
        body = driver.find_element(By.TAG_NAME, 'body')
        h = driver.execute_script("return document.body.scrollHeight")
        driver.set_window_size(1400, min(h + 100, 5000))
        time.sleep(0.5)
    driver.save_screenshot(path)
    if full:
        driver.set_window_size(1400, 900)
    print(f"  Captured: {name}.png")
    return path


def screenshot_viewport(name, sleep=0):
    """Take screenshot of current viewport (no resize)."""
    time.sleep(sleep)
    path = os.path.join(OUT, name + '.png')
    driver.save_screenshot(path)
    print(f"  Captured: {name}.png")
    return path


def scroll_to(element):
    """Scroll element into view at top."""
    driver.execute_script("arguments[0].scrollIntoView({block:'start', behavior:'instant'});", element)
    time.sleep(0.3)


def scroll_top():
    """Scroll to top of page."""
    driver.execute_script("window.scrollTo(0,0);")
    time.sleep(0.3)


# ═══════════════════════════════════════════════
# LOGIN
# ═══════════════════════════════════════════════
print("Logging in...")
driver.get(BASE + "/login")
time.sleep(1)
screenshot("01_login")

try:
    driver.find_element(By.NAME, 'username').send_keys('screenshot_temp')
    driver.find_element(By.NAME, 'password').send_keys('screenshot123')
    driver.find_element(By.CSS_SELECTOR, 'button[type="submit"], input[type="submit"]').click()
    time.sleep(1.5)
except Exception as e:
    print(f"Login form error: {e}")

current = driver.current_url
print(f"After login: {current}")

# ═══════════════════════════════════════════════
# MAIN PAGES
# ═══════════════════════════════════════════════
pages = [
    ("02_dashboard",      "/",                "대시보드"),
    ("03_inventory",      "/inventory",       "입출고 관리"),
    ("04_requests",       "/requests",        "신청서 관리"),
    ("05_assets",         "/assets",          "자산 현황"),
    ("06_modules",        "/module-inventory", "부품 현황"),
    ("07_rooms",          "/rooms",           "서버실 관리"),
    ("08_offices",        "/offices",         "사무실 관리"),
    ("09_storage",        "/storage",         "장비실 관리"),
    ("10_power_panel",    "/power-panel",     "전력 분전반"),
    ("11_network",        "/network-layout",  "네트워크 레이아웃"),
    ("12_ip_management",  "/ip-management",   "IP 관리"),
    ("13_discovery",      "/discovery",       "자산 매칭"),
    ("14_gpu_monitoring", "/gpu-monitoring",  "GPU 모니터링"),
    ("15_audit_log",      "/audit-log",       "이력 관리"),
]

for name, path, label in pages:
    print(f"Capturing {label} ({path})...")
    if name == "07_rooms":
        driver.get(BASE + path)
        time.sleep(2)
        try:
            pwr_btns = driver.find_elements(By.CSS_SELECTOR, '.power-check-btn')
            print(f"  Found {len(pwr_btns)} power check buttons, clicking...")
            for btn in pwr_btns:
                try:
                    driver.execute_script("arguments[0].scrollIntoView(true);", btn)
                    time.sleep(0.3)
                    btn.click()
                except Exception:
                    pass
            time.sleep(15)
        except Exception as e:
            print(f"  Power check error: {e}")
        screenshot(name, sleep=0, full=True)
    else:
        screenshot(name, BASE + path, sleep=2, full=True)


# ═══════════════════════════════════════════════
# STEP-BY-STEP: 입고 등록 (Incoming Registration)
# ═══════════════════════════════════════════════
print("\n=== STEP-BY-STEP: 입고 등록 ===")

# --- Step A: 입출고 목록에서 입고 등록 버튼 클릭 위치 표시 ---
print("Step A: 입출고 목록 - 입고등록 버튼 표시")
driver.get(BASE + "/inventory")
time.sleep(2)
scroll_top()
path = screenshot_viewport("step_in_01_list", sleep=0.5)
try:
    # Find the green 입고 등록 button
    btns = driver.find_elements(By.CSS_SELECTOR, 'a.btn-success, a.btn.btn-success')
    incoming_btn = None
    for b in btns:
        if '입고' in b.text:
            incoming_btn = b
            break
    if incoming_btn:
        r = get_elem_rect(incoming_btn)
        annotate_screenshot(path, [
            {'num': 1, 'x': r['x'], 'y': r['y'], 'w': r['w'], 'h': r['h'],
             'marker_pos': 'top-right'}
        ])
        print("  Annotated step_in_01")
except Exception as e:
    print(f"  Step A annotation error: {e}")

# --- Step B: 입고 등록 폼 - 자산유형/소유 선택 ---
print("Step B: 입고 등록 폼 - 자산유형 선택")
driver.get(BASE + "/inventory/incoming")
time.sleep(1.5)
# 1) Select 자산유형 = 서버
sel = Select(driver.find_element(By.ID, 'incomingType'))
sel.select_by_value('server')
time.sleep(0.5)
# 2) 소유구분 = 자사 (default)
scroll_top()
path = screenshot_viewport("step_in_02_type", sleep=0.5)
try:
    el_type = driver.find_element(By.ID, 'incomingType')
    el_own = driver.find_element(By.ID, 'incomingOwnership')
    r1 = get_elem_rect(el_type)
    r2 = get_elem_rect(el_own)
    annotate_screenshot(path, [
        {'num': 1, 'x': r1['x'], 'y': r1['y'], 'w': r1['w'], 'h': r1['h'],
         'marker_pos': 'left'},
        {'num': 2, 'x': r2['x'], 'y': r2['y'], 'w': r2['w'], 'h': r2['h'],
         'marker_pos': 'left'},
    ])
    print("  Annotated step_in_02")
except Exception as e:
    print(f"  Step B annotation error: {e}")

# --- Step C: 기본 정보 입력 (관리번호, 자산번호, 모델 등) ---
print("Step C: 입고 등록 - 기본 정보 입력")
driver.get(BASE + "/inventory/incoming")
time.sleep(1.5)
sel = Select(driver.find_element(By.ID, 'incomingType'))
sel.select_by_value('server')
time.sleep(0.8)

# Fill in test data
try:
    mgmt = driver.find_element(By.ID, 'incomingMgmtInput')
    mgmt.clear()
    mgmt.send_keys('TPC-SV-2U-99')
    time.sleep(0.3)

    asset_num = driver.find_element(By.ID, 'incomingAssetNumber')
    asset_num.clear()
    asset_num.send_keys('AS-2026-0099')

    mfr = driver.find_element(By.ID, 'incomingManufacturer')
    mfr.clear()
    mfr.send_keys('UNIWIDE')

    model = driver.find_element(By.ID, 'incomingModelName')
    model.clear()
    model.send_keys('RB128 범용서버')

    serial = driver.find_element(By.NAME, 'serial_number')
    serial.clear()
    serial.send_keys('SN-UNI-2026-00099')

    # U size
    u_size = driver.find_element(By.ID, 'uSizeInput')
    if u_size.is_displayed():
        u_size.clear()
        u_size.send_keys('2')

    # Set incoming date
    incoming_date = driver.find_element(By.NAME, 'incoming_date')
    driver.execute_script("arguments[0].value = '2026-04-01';", incoming_date)

    time.sleep(0.3)
except Exception as e:
    print(f"  Fill data error: {e}")

scroll_top()
time.sleep(0.3)

# Full page screenshot for annotating
h = driver.execute_script("return document.body.scrollHeight")
driver.set_window_size(1400, min(h + 100, 3000))
time.sleep(0.5)
path = screenshot_viewport("step_in_03_fill", sleep=0.3)
driver.set_window_size(1400, 900)

try:
    el_mgmt = driver.find_element(By.ID, 'incomingMgmtInput')
    el_asset = driver.find_element(By.ID, 'incomingAssetNumber')
    el_mfr = driver.find_element(By.ID, 'incomingManufacturer')
    el_model = driver.find_element(By.ID, 'incomingModelName')
    el_serial = driver.find_element(By.NAME, 'serial_number')
    el_usize = driver.find_element(By.ID, 'uSizeInput')
    el_submit = driver.find_element(By.CSS_SELECTOR, 'button[type="submit"]')

    rects = {}
    for name_key, el in [('mgmt', el_mgmt), ('asset', el_asset), ('mfr', el_mfr),
                    ('model', el_model), ('serial', el_serial), ('usize', el_usize),
                    ('submit', el_submit)]:
        rects[name_key] = get_elem_rect(el)

    annotations = [
        {'num': 1, 'x': rects['mgmt']['x'], 'y': rects['mgmt']['y'],
         'w': rects['mgmt']['w'], 'h': rects['mgmt']['h'], 'marker_pos': 'left'},
        {'num': 2, 'x': rects['asset']['x'], 'y': rects['asset']['y'],
         'w': rects['asset']['w'], 'h': rects['asset']['h'], 'marker_pos': 'left'},
        {'num': 3, 'x': rects['mfr']['x'], 'y': rects['mfr']['y'],
         'w': rects['mfr']['w'], 'h': rects['mfr']['h'], 'marker_pos': 'left'},
        {'num': 4, 'x': rects['model']['x'], 'y': rects['model']['y'],
         'w': rects['model']['w'], 'h': rects['model']['h'], 'marker_pos': 'left'},
        {'num': 5, 'x': rects['serial']['x'], 'y': rects['serial']['y'],
         'w': rects['serial']['w'], 'h': rects['serial']['h'], 'marker_pos': 'left'},
    ]
    if rects['usize']['h'] > 0:
        annotations.append(
            {'num': 6, 'x': rects['usize']['x'], 'y': rects['usize']['y'],
             'w': rects['usize']['w'], 'h': rects['usize']['h'], 'marker_pos': 'left'})
    annotations.append(
        {'num': 7, 'x': rects['submit']['x'], 'y': rects['submit']['y'],
         'w': rects['submit']['w'], 'h': rects['submit']['h'], 'marker_pos': 'left'})

    annotate_screenshot(path, annotations)
    print("  Annotated step_in_03")
except Exception as e:
    print(f"  Step C annotation error: {e}")

# --- Step D: 업체 장비 입고 선택 화면 ---
print("Step D: 업체 장비 입고 등록")
driver.get(BASE + "/inventory/incoming")
time.sleep(1.5)
sel = Select(driver.find_element(By.ID, 'incomingType'))
sel.select_by_value('server')
time.sleep(0.5)
own = Select(driver.find_element(By.ID, 'incomingOwnership'))
own.select_by_value('vendor')
time.sleep(0.8)

# Select a vendor
try:
    vendor_sel = Select(driver.find_element(By.ID, 'vendorSelect'))
    # Pick first vendor (not empty, not __new__)
    options = vendor_sel.options
    for opt in options:
        val = opt.get_attribute('value')
        if val and val != '' and val != '__new__':
            vendor_sel.select_by_value(val)
            break
    time.sleep(0.5)
except Exception as e:
    print(f"  Vendor select error: {e}")

scroll_top()
path = screenshot_viewport("step_in_04_vendor", sleep=0.5)
try:
    el_own = driver.find_element(By.ID, 'incomingOwnership')
    el_vendor = driver.find_element(By.ID, 'vendorSelect')
    r1 = get_elem_rect(el_own)
    r2 = get_elem_rect(el_vendor)
    annotate_screenshot(path, [
        {'num': 1, 'x': r1['x'], 'y': r1['y'], 'w': r1['w'], 'h': r1['h'],
         'marker_pos': 'left'},
        {'num': 2, 'x': r2['x'], 'y': r2['y'], 'w': r2['w'], 'h': r2['h'],
         'marker_pos': 'left'},
    ])
    print("  Annotated step_in_04")
except Exception as e:
    print(f"  Step D annotation error: {e}")


# ═══════════════════════════════════════════════
# STEP-BY-STEP: 사용 등록 (Usage Registration)
# ═══════════════════════════════════════════════
print("\n=== STEP-BY-STEP: 사용 등록 ===")

# --- Step U1: 입출고 목록에서 사용 등록 버튼 ---
print("Step U1: 사용 등록 버튼 위치 표시")
driver.get(BASE + "/inventory")
time.sleep(2)
scroll_top()
path = screenshot_viewport("step_use_01_list", sleep=0.5)
try:
    btns = driver.find_elements(By.CSS_SELECTOR, 'a.btn-primary, a.btn.btn-primary')
    usage_btn = None
    for b in btns:
        if '사용' in b.text:
            usage_btn = b
            break
    if usage_btn:
        r = get_elem_rect(usage_btn)
        annotate_screenshot(path, [
            {'num': 1, 'x': r['x'], 'y': r['y'], 'w': r['w'], 'h': r['h'],
             'marker_pos': 'top-right'}
        ])
        print("  Annotated step_use_01")
except Exception as e:
    print(f"  Step U1 annotation error: {e}")

# --- Step U2: 사용 등록 폼 - 관리번호 입력으로 기존 자산 로딩 ---
print("Step U2: 관리번호 입력하여 기존 자산 로딩")
driver.get(BASE + "/inventory/new")
time.sleep(2)

try:
    # Type a known management number to trigger auto-fill
    mgmt_input = driver.find_element(By.ID, 'invMgmtInput')
    mgmt_input.clear()
    mgmt_input.send_keys('TPC-SV-1U-01')
    time.sleep(1)

    # Try to select from datalist by dispatching events
    driver.execute_script("""
        var input = arguments[0];
        input.dispatchEvent(new Event('input', {bubbles: true}));
        input.dispatchEvent(new Event('change', {bubbles: true}));
    """, mgmt_input)
    time.sleep(1)
except Exception as e:
    print(f"  Mgmt input error: {e}")

scroll_top()
path = screenshot_viewport("step_use_02_mgmt", sleep=0.5)
try:
    el_mgmt = driver.find_element(By.ID, 'invMgmtInput')
    r = get_elem_rect(el_mgmt)
    annotate_screenshot(path, [
        {'num': 1, 'x': r['x'], 'y': r['y'], 'w': r['w'], 'h': r['h'],
         'marker_pos': 'left'},
    ])
    print("  Annotated step_use_02")
except Exception as e:
    print(f"  Step U2 annotation error: {e}")

# --- Step U3: 사용 등록 - 하드웨어 섹션 ---
print("Step U3: 하드웨어 정보 입력")
driver.get(BASE + "/inventory/new")
time.sleep(2)

# Add some hardware rows
try:
    # Click + CPU button
    driver.execute_script("""
        if(typeof addHwRow === 'function') addHwRow('cpu');
    """)
    time.sleep(0.3)

    # Click + 메모리 button
    driver.execute_script("""
        if(typeof addHwRow === 'function') addHwRow('memory');
    """)
    time.sleep(0.3)

    # Click + 디스크 button
    driver.execute_script("""
        if(typeof addHwRow === 'function') addHwRow('disk');
    """)
    time.sleep(0.3)

    # Click + PSU button
    driver.execute_script("""
        if(typeof addHwRow === 'function') addHwRow('psu');
    """)
    time.sleep(0.3)

    # Fill in hw rows
    hw_code_inputs = driver.find_elements(By.NAME, 'hw_codes[]')
    hw_num_inputs = driver.find_elements(By.NAME, 'hw_nums[]')

    test_hw = [
        ('CPU-A', '2'),
        ('mem-32-A', '16'),
        ('ssd-1T-A', '4'),
        ('PSU 800W', '1'),
    ]

    for i, (code, num) in enumerate(test_hw):
        if i < len(hw_code_inputs):
            hw_code_inputs[i].clear()
            hw_code_inputs[i].send_keys(code)
        if i < len(hw_num_inputs):
            hw_num_inputs[i].clear()
            hw_num_inputs[i].send_keys(num)

    time.sleep(0.3)
except Exception as e:
    print(f"  HW fill error: {e}")

# Scroll to hardware section
try:
    hw_section = driver.find_element(By.ID, 'hardwareSection')
    scroll_to(hw_section)
    time.sleep(0.5)
except:
    pass

path = screenshot_viewport("step_use_03_hardware", sleep=0.5)
try:
    # Find add buttons for annotation
    hw_btns = driver.find_elements(By.CSS_SELECTOR, '#hardwareSection button.btn-outline')
    hw_rows = driver.find_elements(By.CSS_SELECTOR, '.inv-hw-row')

    annotations = []
    # Mark the add buttons area
    if hw_btns:
        first_btn = hw_btns[0]
        last_btn = hw_btns[-1]
        r1 = get_elem_rect(first_btn)
        r2 = get_elem_rect(last_btn)
        annotations.append({
            'num': 1, 'x': r1['x'], 'y': r1['y'],
            'w': r2['x'] + r2['w'] - r1['x'], 'h': r1['h'],
            'marker_pos': 'left'
        })

    # Mark the hardware rows
    if hw_rows:
        first_row = hw_rows[0]
        last_row = hw_rows[-1]
        r1 = get_elem_rect(first_row)
        r2 = get_elem_rect(last_row)
        annotations.append({
            'num': 2, 'x': r1['x'], 'y': r1['y'],
            'w': r1['w'], 'h': r2['y'] + r2['h'] - r1['y'],
            'marker_pos': 'right'
        })

    annotate_screenshot(path, annotations)
    print("  Annotated step_use_03")
except Exception as e:
    print(f"  Step U3 annotation error: {e}")

# --- Step U4: IP / 접속정보 입력 ---
print("Step U4: IP 및 접속정보 입력")
driver.get(BASE + "/inventory/new")
time.sleep(2)

# Add credential rows
try:
    driver.execute_script("if(typeof addCredRow === 'function') addCredRow('root');")
    time.sleep(0.3)
    driver.execute_script("if(typeof addCredRow === 'function') addCredRow('bmc');")
    time.sleep(0.3)

    # Fill credential data
    cred_users = driver.find_elements(By.NAME, 'cred_usernames[]')
    cred_pwds = driver.find_elements(By.NAME, 'cred_passwords[]')

    if len(cred_users) >= 2:
        cred_users[0].clear()
        cred_users[0].send_keys('root')
        cred_pwds[0].clear()
        cred_pwds[0].send_keys('password')
        cred_users[1].clear()
        cred_users[1].send_keys('ADMIN')
        cred_pwds[1].clear()
        cred_pwds[1].send_keys('ADMIN')

    # Add IP row
    driver.execute_script("if(typeof addInvIpRow === 'function') addInvIpRow();")
    time.sleep(0.3)
    driver.execute_script("if(typeof addInvIpRow === 'function') addInvIpRow();")
    time.sleep(0.3)

    # Fill IP data
    ip_vals = driver.find_elements(By.NAME, 'ip_values[]')
    if len(ip_vals) >= 2:
        ip_vals[0].clear()
        ip_vals[0].send_keys('10.100.230.50')
        ip_vals[1].clear()
        ip_vals[1].send_keys('10.100.230.51')

    # Set IP purposes via JS
    ip_purpose_hiddens = driver.find_elements(By.NAME, 'ip_purposes[]')
    if len(ip_purpose_hiddens) >= 2:
        driver.execute_script("arguments[0].value = 'Management';", ip_purpose_hiddens[0])
        driver.execute_script("arguments[0].value = 'BMC';", ip_purpose_hiddens[1])

    time.sleep(0.3)
except Exception as e:
    print(f"  IP/Cred fill error: {e}")

# Scroll to credential/IP section
try:
    cred_section = driver.find_element(By.ID, 'credRows')
    scroll_to(cred_section)
    time.sleep(0.5)
except:
    pass

path = screenshot_viewport("step_use_04_ip_cred", sleep=0.5)
try:
    cred_rows = driver.find_elements(By.CSS_SELECTOR, '.inv-cred-row')
    ip_rows = driver.find_elements(By.CSS_SELECTOR, '.inv-ip-row')

    annotations = []
    if cred_rows:
        r1 = get_elem_rect(cred_rows[0])
        r2 = get_elem_rect(cred_rows[-1])
        annotations.append({
            'num': 1, 'x': r1['x'], 'y': r1['y'],
            'w': r1['w'], 'h': r2['y'] + r2['h'] - r1['y'],
            'marker_pos': 'left'
        })
    if ip_rows:
        r1 = get_elem_rect(ip_rows[0])
        r2 = get_elem_rect(ip_rows[-1])
        annotations.append({
            'num': 2, 'x': r1['x'], 'y': r1['y'],
            'w': r1['w'], 'h': r2['y'] + r2['h'] - r1['y'],
            'marker_pos': 'left'
        })

    annotate_screenshot(path, annotations)
    print("  Annotated step_use_04")
except Exception as e:
    print(f"  Step U4 annotation error: {e}")

# --- Step U5: 위치 배정 (서버실/랙 선택 + 미리보기) ---
print("Step U5: 위치 배정 - 서버실/랙 선택")
driver.get(BASE + "/inventory/new")
time.sleep(2)

try:
    # Select server room
    room_sel = Select(driver.find_element(By.ID, 'invRoomSelect'))
    # Choose HPC (room 60) or first available
    for opt in room_sel.options:
        val = opt.get_attribute('value')
        if val and val != '' and val != '__manual__':
            room_sel.select_by_value(val)
            break
    time.sleep(1)

    # Trigger room change
    driver.execute_script("""
        var sel = document.getElementById('invRoomSelect');
        sel.dispatchEvent(new Event('change', {bubbles:true}));
    """)
    time.sleep(1)

    # Select rack
    rack_sel = Select(driver.find_element(By.ID, 'invRackSelect'))
    for opt in rack_sel.options:
        val = opt.get_attribute('value')
        if val and val != '' and val != '__manual__':
            rack_sel.select_by_value(val)
            break
    time.sleep(0.5)

    driver.execute_script("""
        var sel = document.getElementById('invRackSelect');
        sel.dispatchEvent(new Event('change', {bubbles:true}));
    """)
    time.sleep(2)
except Exception as e:
    print(f"  Location select error: {e}")

# Scroll to location section
try:
    loc_section = driver.find_element(By.ID, 'locationEquipment')
    scroll_to(loc_section)
    time.sleep(1)
except:
    pass

path = screenshot_viewport("step_use_05_location", sleep=0.5)
try:
    el_room = driver.find_element(By.ID, 'invRoomSelect')
    el_rack = driver.find_element(By.ID, 'invRackSelect')
    r1 = get_elem_rect(el_room)
    r2 = get_elem_rect(el_rack)

    annotations = [
        {'num': 1, 'x': r1['x'], 'y': r1['y'], 'w': r1['w'], 'h': r1['h'],
         'marker_pos': 'left'},
        {'num': 2, 'x': r2['x'], 'y': r2['y'], 'w': r2['w'], 'h': r2['h'],
         'marker_pos': 'left'},
    ]

    # Check for rack preview
    preview = driver.find_elements(By.ID, 'invRackPreviewContainer')
    if preview and preview[0].is_displayed():
        rp = get_elem_rect(preview[0])
        if rp['h'] > 10:
            annotations.append({
                'num': 3, 'x': rp['x'], 'y': rp['y'], 'w': rp['w'], 'h': min(rp['h'], 400),
                'marker_pos': 'right'
            })

    annotate_screenshot(path, annotations)
    print("  Annotated step_use_05")
except Exception as e:
    print(f"  Step U5 annotation error: {e}")

# --- Step U6: 등록 버튼 ---
print("Step U6: 등록 버튼 클릭")
driver.get(BASE + "/inventory/new")
time.sleep(2)

# Scroll to bottom to see submit button
driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
time.sleep(0.5)
path = screenshot_viewport("step_use_06_submit", sleep=0.3)
try:
    submit_btn = driver.find_element(By.CSS_SELECTOR, 'button[type="submit"].btn-primary')
    r = get_elem_rect(submit_btn)
    annotate_screenshot(path, [
        {'num': 1, 'x': r['x'], 'y': r['y'], 'w': r['w'], 'h': r['h'],
         'marker_pos': 'left'}
    ])
    print("  Annotated step_use_06")
except Exception as e:
    print(f"  Step U6 annotation error: {e}")


# ═══════════════════════════════════════════════
# EXTRA: Asset detail, Equipment detail, Rack room
# ═══════════════════════════════════════════════
print("\n=== EXTRA SCREENSHOTS ===")

# Equipment detail
print("Capturing equipment detail...")
try:
    driver.get(BASE + "/inventory")
    time.sleep(1.5)
    links = driver.find_elements(By.CSS_SELECTOR, 'a[href*="/inventory/equipment/"]')
    if links:
        links[0].click()
        time.sleep(1.5)
        screenshot("03e_equip_detail", full=True)
        print("  Captured equipment detail")
except Exception as e:
    print(f"  Equipment detail skip: {e}")

# Asset detail page
try:
    driver.get(BASE + "/assets")
    time.sleep(1.5)
    links = driver.find_elements(By.CSS_SELECTOR, 'a[href^="/assets/"]')
    detail_links = [l for l in links if l.get_attribute('href').split('/assets/')[-1].isdigit()]
    if detail_links:
        detail_links[0].click()
        time.sleep(1.5)
        screenshot("16_asset_detail", full=True)
        print("  Captured asset detail")
except Exception as e:
    print(f"  Asset detail skip: {e}")

# Rack detail page
try:
    driver.get(BASE + "/rooms")
    time.sleep(1.5)
    room_links = driver.find_elements(By.CSS_SELECTOR, 'a[href^="/racks/room/"]')
    if room_links:
        room_links[0].click()
        time.sleep(1.5)
        screenshot("17_rack_room", full=True)
        print("  Captured rack room view")
except Exception as e:
    print(f"  Rack room skip: {e}")


driver.quit()
print("\nAll screenshots captured!")
print(f"Output directory: {OUT}")
