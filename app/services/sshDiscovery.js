const { Client } = require('ssh2');
const { execFile } = require('child_process');
const appConfig = require('../config/app');
const hardwareParser = require('./hardwareParser');

const DISCOVERY_SCRIPT = `
# Auto-install essential tools if missing
if ! command -v lspci >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y pciutils >/dev/null 2>&1
  elif command -v yum >/dev/null 2>&1; then
    yum install -y pciutils >/dev/null 2>&1
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y pciutils >/dev/null 2>&1
  fi
fi
if ! command -v lsblk >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y util-linux >/dev/null 2>&1
  elif command -v yum >/dev/null 2>&1; then
    yum install -y util-linux >/dev/null 2>&1
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y util-linux >/dev/null 2>&1
  fi
fi
echo "===HOSTNAME_START==="
hostname
echo "===HOSTNAME_END==="
echo "===OSINFO_START==="
if [ -f /etc/os-release ]; then
  . /etc/os-release
  echo "NAME=$NAME"
  echo "VERSION=$VERSION"
  echo "ID=$ID"
fi
uname -r 2>/dev/null | sed 's/^/KERNEL=/'
echo "===OSINFO_END==="
echo "===SERIAL_START==="
if command -v dmidecode >/dev/null 2>&1; then
  sudo dmidecode -t 1 2>/dev/null | grep -iE 'Serial Number|Product Name|Manufacturer' || dmidecode -t 1 2>/dev/null | grep -iE 'Serial Number|Product Name|Manufacturer'
fi
echo "===SERIAL_END==="
echo "===CPU_START==="
lscpu 2>/dev/null
echo "===CPU_END==="
echo "===MEMORY_START==="
if ! command -v dmidecode >/dev/null 2>&1 && ! [ -f /usr/sbin/dmidecode ]; then
  if command -v yum >/dev/null 2>&1; then
    yum install -y dmidecode >/dev/null 2>&1
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y dmidecode >/dev/null 2>&1
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get install -y dmidecode >/dev/null 2>&1
  fi
fi
if command -v dmidecode >/dev/null 2>&1; then
  sudo dmidecode -t 17 2>/dev/null || dmidecode -t 17 2>/dev/null
elif [ -f /usr/sbin/dmidecode ]; then
  /usr/sbin/dmidecode -t 17 2>/dev/null
fi
echo "===MEMORY_END==="
echo "===MEMORY_FALLBACK_START==="
echo "===SOURCE:proc==="
cat /proc/meminfo 2>/dev/null | grep -E 'MemTotal|MemFree'
echo "===MEMORY_FALLBACK_END==="
echo "===DISK_START==="
lsblk -d -o NAME,MAJ:MIN,RM,SIZE,RO,TYPE,MODEL 2>/dev/null
echo "===DISK_END==="
echo "===DISK_DETAIL_START==="
SMARTCTL_D=$(command -v smartctl 2>/dev/null)
if [ -n "$SMARTCTL_D" ]; then
  for dev in $(lsblk -dn -o NAME,TYPE 2>/dev/null | awk '$2=="disk"{print $1}'); do
    INFO=$(sudo $SMARTCTL_D -i "/dev/$dev" 2>/dev/null || $SMARTCTL_D -i "/dev/$dev" 2>/dev/null)
    MODEL=$(echo "$INFO" | grep -E '^(Device Model|Product|Model Number):' | head -1 | sed 's/^[^:]*:\s*//')
    VENDOR=$(echo "$INFO" | grep -E '^Vendor:' | head -1 | sed 's/^[^:]*:\s*//')
    if [ -n "$MODEL" ]; then
      if [ -n "$VENDOR" ] && echo "$MODEL" | grep -qiv "^$VENDOR"; then
        echo "DISKDETAIL: name=$dev model=$VENDOR $MODEL"
      else
        echo "DISKDETAIL: name=$dev model=$MODEL"
      fi
    fi
  done
fi
echo "===DISK_DETAIL_END==="
echo "===NETWORK_START==="
lspci -D 2>/dev/null | grep -iE 'ethernet|infiniband' | while IFS= read -r line; do
  PCI=$(echo "$line" | awk '{print $1}')
  SDEV=$(lspci -vmms "$PCI" 2>/dev/null | awk -F':\t' '/^SDevice:/{print $2}')
  if echo "$SDEV" | grep -qE '^Device [0-9a-fA-F]{4}$'; then
    echo "[ONBOARD] $line"
  else
    echo "$line"
  fi
done
echo "===NETWORK_END==="
echo "===RAID_START==="
lspci -D 2>/dev/null | grep -i raid | while IFS= read -r line; do
  PCI=$(echo "$line" | awk '{print $1}')
  SUBSYS=$(lspci -vmms "$PCI" 2>/dev/null | awk -F':\t' '/^SDevice:/{print $2}')
  if [ -n "$SUBSYS" ] && echo "$SUBSYS" | grep -qivE '^Device [0-9a-fA-F]{4}$'; then
    echo "RAID: $line [SUBSYS:$SUBSYS]"
  else
    echo "RAID: $line"
  fi
done
echo "===RAID_END==="
echo "===RAID_PD_START==="
STORCLI=$(command -v storcli64 2>/dev/null || command -v storcli 2>/dev/null || command -v /opt/MegaRAID/storcli/storcli64 2>/dev/null)
MEGACLI=$(command -v MegaCli64 2>/dev/null || command -v MegaCli 2>/dev/null || command -v megacli 2>/dev/null || command -v /opt/MegaRAID/MegaCli/MegaCli64 2>/dev/null || command -v /opt/MegaRAID/MegaCli/MegaCli 2>/dev/null)
PERCCLI=$(command -v perccli64 2>/dev/null || command -v perccli 2>/dev/null)
SSACLI=$(command -v ssacli 2>/dev/null || command -v hpssacli 2>/dev/null)
ARCCONF=$(command -v arcconf 2>/dev/null)
if [ -z "$STORCLI" ] && [ -z "$MEGACLI" ] && [ -z "$PERCCLI" ] && [ -z "$SSACLI" ] && [ -z "$ARCCONF" ]; then
  if lspci 2>/dev/null | grep -qi raid; then
    if command -v yum >/dev/null 2>&1; then
      yum install -y storcli 2>/dev/null || yum install -y MegaCli 2>/dev/null
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y storcli 2>/dev/null || dnf install -y MegaCli 2>/dev/null
    elif command -v apt-get >/dev/null 2>&1; then
      apt-get install -y storcli 2>/dev/null || apt-get install -y megacli 2>/dev/null
    fi
    STORCLI=$(command -v storcli64 2>/dev/null || command -v storcli 2>/dev/null || command -v /opt/MegaRAID/storcli/storcli64 2>/dev/null)
    MEGACLI=$(command -v MegaCli64 2>/dev/null || command -v MegaCli 2>/dev/null || command -v megacli 2>/dev/null || command -v /opt/MegaRAID/MegaCli/MegaCli64 2>/dev/null || command -v /opt/MegaRAID/MegaCli/MegaCli 2>/dev/null)
    PERCCLI=$(command -v perccli64 2>/dev/null || command -v perccli 2>/dev/null)
    SSACLI=$(command -v ssacli 2>/dev/null || command -v hpssacli 2>/dev/null)
    ARCCONF=$(command -v arcconf 2>/dev/null)
  fi
fi
if [ -n "$STORCLI" ]; then
  echo "===TOOL:storcli==="
  $STORCLI /c0 /eall /sall show 2>/dev/null
elif [ -n "$MEGACLI" ]; then
  echo "===TOOL:MegaCli==="
  $MEGACLI -PDList -a0 2>/dev/null
elif [ -n "$PERCCLI" ]; then
  echo "===TOOL:perccli==="
  $PERCCLI /c0 /eall /sall show 2>/dev/null
elif [ -n "$SSACLI" ]; then
  echo "===TOOL:ssacli==="
  $SSACLI ctrl slot=0 pd all show detail 2>/dev/null
elif [ -n "$ARCCONF" ]; then
  echo "===TOOL:arcconf==="
  $ARCCONF getconfig 1 pd 2>/dev/null
else
  echo "===TOOL:sysfs==="
  for d in /sys/class/scsi_device/*/device; do
    if [ -d "$d" ]; then
      VENDOR=$(cat "$d/vendor" 2>/dev/null | tr -d ' ')
      MODEL=$(cat "$d/model" 2>/dev/null | sed 's/^ *//;s/ *$//')
      REV=$(cat "$d/rev" 2>/dev/null | tr -d ' ')
      BLK=$(ls "$d/block/" 2>/dev/null | head -1)
      SIZE=""
      if [ -n "$BLK" ] && [ -f "/sys/block/$BLK/size" ]; then
        SECTORS=$(cat "/sys/block/$BLK/size" 2>/dev/null)
        if [ -n "$SECTORS" ] && [ "$SECTORS" -gt 0 ] 2>/dev/null; then
          SIZE=$(awk "BEGIN{printf \\"%.1f GB\\", $SECTORS * 512 / 1000000000}")
        fi
      fi
      TYPE=$(cat "$d/type" 2>/dev/null)
      if [ "$TYPE" = "0" ] && [ -n "$MODEL" ]; then
        echo "DISK: vendor=$VENDOR model=$MODEL rev=$REV size=$SIZE block=$BLK"
      fi
    fi
  done
fi
# smartctl fallback — always try if RAID detected and physical disks not yet found
SMARTCTL=$(command -v smartctl 2>/dev/null)
if [ -z "$SMARTCTL" ] && lspci 2>/dev/null | grep -qi raid; then
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y smartmontools >/dev/null 2>&1
  elif command -v yum >/dev/null 2>&1; then
    yum install -y smartmontools >/dev/null 2>&1
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y smartmontools >/dev/null 2>&1
  fi
  SMARTCTL=$(command -v smartctl 2>/dev/null)
fi
if [ -n "$SMARTCTL" ]; then
  echo "===SMARTCTL_START==="
  SCAN_RESULT=$(sudo $SMARTCTL --scan-open 2>/dev/null || $SMARTCTL --scan-open 2>/dev/null)
  if [ -n "$SCAN_RESULT" ]; then
    echo "$SCAN_RESULT" | while IFS= read -r line; do
      DEV_SPEC=$(echo "$line" | sed 's/#.*//' | xargs)
      if [ -n "$DEV_SPEC" ]; then
        echo "===DEV:$DEV_SPEC==="
        sudo $SMARTCTL -i $DEV_SPEC 2>/dev/null || $SMARTCTL -i $DEV_SPEC 2>/dev/null
      fi
    done
    # Brute-force scan for additional RAID disks that --scan-open missed
    HAS_MEGARAID=$(echo "$SCAN_RESULT" | grep -c megaraid)
    if [ "$HAS_MEGARAID" -gt 0 ]; then
      RAID_DEV=$(echo "$SCAN_RESULT" | grep megaraid | head -1 | awk '{print $1}')
      FOUND_SLOTS=$(echo "$SCAN_RESULT" | grep -oP 'megaraid,\K[0-9]+')
      for slot in $(seq 0 63); do
        if echo "$FOUND_SLOTS" | grep -qx "$slot"; then continue; fi
        RES=$(sudo $SMARTCTL -i "$RAID_DEV" -d megaraid,"$slot" 2>&1 || $SMARTCTL -i "$RAID_DEV" -d megaraid,"$slot" 2>&1)
        if echo "$RES" | grep -qE '^(Vendor|Product|Model Family|Device Model):'; then
          echo "===DEV:$RAID_DEV -d megaraid,$slot==="
          echo "$RES"
        fi
      done
    fi
  else
    for dev in $(lsblk -dn -o NAME,TYPE 2>/dev/null | awk '$2=="disk"{print "/dev/"$1}'); do
      echo "===DEV:$dev==="
      sudo $SMARTCTL -i "$dev" 2>/dev/null || $SMARTCTL -i "$dev" 2>/dev/null
    done
  fi
  echo "===SMARTCTL_END==="
fi
echo "===RAID_PD_END==="
echo "===NVME_START==="
NVME_CLI=$(command -v nvme 2>/dev/null)
if [ -z "$NVME_CLI" ]; then
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y nvme-cli >/dev/null 2>&1
  elif command -v yum >/dev/null 2>&1; then
    yum install -y nvme-cli >/dev/null 2>&1
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y nvme-cli >/dev/null 2>&1
  fi
  NVME_CLI=$(command -v nvme 2>/dev/null)
fi
if [ -n "$NVME_CLI" ]; then
  sudo $NVME_CLI list 2>/dev/null || $NVME_CLI list 2>/dev/null
fi
echo "===NVME_LSPCI==="
lspci 2>/dev/null | grep -i "Non-Volatile memory"
echo "===NVME_END==="
echo "===GPU_START==="
lspci 2>/dev/null | grep -iE 'VGA compatible|3D controller|Display controller'
nvidia-smi -L 2>/dev/null
echo "===GPU_END==="
echo "===NPU_START==="
lspci 2>/dev/null | grep -iE 'rebellions|furiosa|npu|neural|processing accelerator|AI accelerator|ATOM|RNGD|WARBOY' | while IFS= read -r line; do
  PCI=$(echo "$line" | awk '{print $1}')
  echo "===NPU_DEV:$PCI==="
  echo "$line"
  lspci -vv -s "$PCI" 2>/dev/null
done
echo "===NPU_END==="
echo "===FREE_START==="
free -h 2>/dev/null
echo "===FREE_END==="
`;

// Semaphore for concurrent connection limiting
class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise(resolve => {
      this.queue.push(resolve);
    });
  }

  release() {
    this.current--;
    if (this.queue.length > 0) {
      this.current++;
      const next = this.queue.shift();
      next();
    }
  }
}

const semaphore = new Semaphore(appConfig.ssh.maxConcurrent);

function connectAndDiscover(host, options = {}) {
  const user = options.user || appConfig.ssh.defaultUser;
  const password = options.password || appConfig.ssh.defaultPassword;
  const port = options.port || appConfig.ssh.defaultPort;
  const timeout = options.timeout || appConfig.ssh.connectTimeout;

  return new Promise(async (resolve) => {
    await semaphore.acquire();

    const conn = new Client();
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        conn.end();
        semaphore.release();
        resolve({
          ip: host,
          status: 'unreachable',
          error: 'Connection timeout'
        });
      }
    }, timeout + 5000);

    conn.on('ready', () => {
      conn.exec(DISCOVERY_SCRIPT, (err, stream) => {
        if (err) {
          settled = true;
          clearTimeout(timer);
          conn.end();
          semaphore.release();
          return resolve({
            ip: host,
            status: 'error',
            error: 'Exec error: ' + err.message
          });
        }

        let output = '';
        let stderr = '';

        stream.on('data', (data) => {
          output += data.toString();
        });

        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        stream.on('close', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            conn.end();
            semaphore.release();

            try {
              const parsed = hardwareParser.parseAll(output);
              resolve({
                ip: host,
                status: 'success',
                hostname: parsed.hostname,
                totalMemory: parsed.totalMemory,
                osInfo: parsed.osInfo,
                serial: parsed.serial,
                modules: parsed.modules,
                rawOutput: output
              });
            } catch (parseErr) {
              resolve({
                ip: host,
                status: 'parse_error',
                error: 'Parse error: ' + parseErr.message,
                rawOutput: output
              });
            }
          }
        });
      });
    });

    conn.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        semaphore.release();

        let status = 'error';
        if (err.message.includes('Authentication') || err.level === 'client-authentication') {
          status = 'auth_failed';
        } else if (err.message.includes('ECONNREFUSED') || err.message.includes('ETIMEDOUT')) {
          status = 'unreachable';
        }

        resolve({
          ip: host,
          status: status,
          error: err.message
        });
      }
    });

    conn.connect({
      host: host,
      port: port,
      username: user,
      password: password,
      readyTimeout: timeout,
      algorithms: {
        kex: ['diffie-hellman-group14-sha256', 'diffie-hellman-group14-sha1',
              'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521'],
      }
    });
  });
}

function generateIpRange(startIp, endIp) {
  const start = startIp.split('.').map(Number);
  const end = endIp.split('.').map(Number);
  const ips = [];

  const startNum = (start[0] << 24) + (start[1] << 16) + (start[2] << 8) + start[3];
  const endNum = (end[0] << 24) + (end[1] << 16) + (end[2] << 8) + end[3];

  for (let i = startNum; i <= endNum; i++) {
    ips.push(
      ((i >> 24) & 255) + '.' +
      ((i >> 16) & 255) + '.' +
      ((i >> 8) & 255) + '.' +
      (i & 255)
    );
  }

  return ips;
}

async function discoverRange(startIp, endIp, options = {}) {
  const ips = generateIpRange(startIp, endIp);
  const results = await Promise.all(
    ips.map(ip => connectAndDiscover(ip, options))
  );
  return results;
}

// ── IPMI PSU detection via BMC ──

function runIpmiCommand(bmcIp, bmcUser, bmcPass, args, timeout = 8000) {
  return new Promise((resolve) => {
    const fullArgs = ['-I', 'lanplus', '-H', bmcIp, '-U', bmcUser, '-P', bmcPass, ...args];
    execFile('ipmitool', fullArgs, { timeout }, (err, stdout) => {
      resolve(err ? '' : (stdout || ''));
    });
  });
}

// Extract rated wattage from PSU model name
// e.g. TDPS2400HB→2400, DPS-800AB→800, PWS-2K04A→2000, PWS-1K28P→1280
function extractWattFromModel(model) {
  if (!model) return 0;
  // "2K04" style → 2040W, "1K28" → 1280W
  const kMatch = model.match(/(\d)K(\d{2})/i);
  if (kMatch) return parseInt(kMatch[1]) * 1000 + parseInt(kMatch[2]) * 10;
  // 3-4 digit number likely to be wattage (200~3600W range)
  const nums = model.match(/(\d{3,4})/g);
  if (nums) {
    for (const n of nums) {
      const v = parseInt(n);
      if (v >= 200 && v <= 3600) return v;
    }
  }
  return 0;
}

async function detectPsuViaIpmi(bmcIp, bmcUser, bmcPass) {
  try {
    // 4 IPMI commands sequentially (each 8s timeout)
    const sdrOutput = await runIpmiCommand(bmcIp, bmcUser, bmcPass, ['sdr', 'type', 'Power Supply']);
    const sensorOutput = await runIpmiCommand(bmcIp, bmcUser, bmcPass, ['sensor', 'list']);
    const dcmiOutput = await runIpmiCommand(bmcIp, bmcUser, bmcPass, ['dcmi', 'power', 'reading']);
    const fruOutput = await runIpmiCommand(bmcIp, bmcUser, bmcPass, ['fru', 'print']);

    // 1) PSU count from SDR ("Presence detected" lines)
    let psuCount = 0;
    const presenceLines = sdrOutput.split('\n').filter(l => /Presence detected/i.test(l));
    psuCount = presenceLines.length;

    // 2) PSU info from sensor list
    const sensorLines = sensorOutput.split('\n');

    // Helper: extract PSU slot number from sensor name
    // PSU1, PS2 → number; PSU_A, PSU_B → A=1, B=2, ...
    function psuSlotNum(name) {
      const numMatch = name.match(/^(?:PSU|PS)[\s_]*(\d+)/i);
      if (numMatch) return parseInt(numMatch[1]);
      const letterMatch = name.match(/^(?:PSU|PS)[\s_]*([A-Z])/i);
      if (letterMatch) return letterMatch[1].toUpperCase().charCodeAt(0) - 64; // A=1, B=2
      return 0;
    }

    // Match various PSU power sensor names:
    //   "PSU1 Input PWR", "PSU1 In Power", "PSU_A_PowerIn", "PSU_B_PowerOut" etc.
    const psuPwrLines = sensorLines.filter(l => {
      const t = l.trim();
      return /^(PSU|PS)[\s_]*(\d+|[A-Z])[\s_].*(In|Input|Out|Output)[\s_]*(Power|PWR)/i.test(t) ||
             /^(PSU|PS)[\s_]*(\d+|[A-Z])[\s_]*(Power|PWR)[\s_]*(In|Out)/i.test(t);
    });

    // Unique PSU slot numbers from sensor output (fallback count)
    const psuNumbers = new Set();
    for (const line of sensorLines) {
      const n = psuSlotNum(line.trim());
      if (n > 0) psuNumbers.add(n);
    }
    if (psuCount === 0 && psuNumbers.size > 0) {
      psuCount = psuNumbers.size;
    }

    // Also check FRU for PSU count (PSU1_FRU, PSU2_FRU, etc.)
    const fruPsuIds = new Set();
    const fruEntries = fruOutput.split('FRU Device Description');
    for (const entry of fruEntries) {
      const pm = entry.match(/:\s*PSU\s*(\d+)/i);
      if (pm) fruPsuIds.add(parseInt(pm[1]));
    }
    if (psuCount === 0 && fruPsuIds.size > 0) {
      psuCount = fruPsuIds.size;
    }

    if (psuCount === 0) return [];

    // 3) Watt per PSU from sensor
    const psuRatedWatts = {};   // rated capacity (upper thresholds)
    const psuCurrentWatts = {}; // current reading (value field)
    for (const line of psuPwrLines) {
      const num = psuSlotNum(line.trim());
      if (num === 0) continue;
      const fields = line.split('|').map(f => f.trim());
      // Fields: name | value | unit | status | lnr | lcr | lnc | unc | ucr | unr

      // Rated capacity: Upper Critical (8) > Upper Non-Critical (7)
      if (fields.length >= 9) {
        const ucr = parseFloat(fields[8]);
        const unc = parseFloat(fields[7]);
        const rated = (!isNaN(ucr) && ucr > 0) ? ucr : (!isNaN(unc) && unc > 0) ? unc : 0;
        if (rated > 0 && (!psuRatedWatts[num] || rated > psuRatedWatts[num])) {
          psuRatedWatts[num] = rated;
        }
      }

      // Current reading: value field (index 1), prefer Input over Output
      const current = parseFloat(fields[1]);
      if (!isNaN(current) && current > 0) {
        const isInput = /In/i.test(fields[0]);
        if (isInput || !psuCurrentWatts[num]) {
          psuCurrentWatts[num] = current;
        }
      }
    }

    // System total power from sensor (SYS_POWER, Total_Power, total_power, etc.)
    let sysPower = 0;
    for (const line of sensorLines) {
      if (/^(SYS_POWER|total_power|Total.?Power|System.?Power)/i.test(line.trim())) {
        const fields = line.split('|').map(f => f.trim());
        const val = parseFloat(fields[1]);
        if (!isNaN(val) && val > 0) sysPower = val;
      }
    }

    // 4) DCMI power
    let dcmiMax = 0, dcmiCurrent = 0;
    const dcmiMaxMatch = dcmiOutput.match(/Maximum during sampling period:\s*(\d+)\s*Watts/i);
    if (dcmiMaxMatch) dcmiMax = parseInt(dcmiMaxMatch[1]);
    const dcmiCurMatch = dcmiOutput.match(/Instantaneous power reading:\s*(\d+)\s*Watts/i);
    if (dcmiCurMatch) dcmiCurrent = parseInt(dcmiCurMatch[1]);

    // 5) PSU FRU data (model, manufacturer, rated wattage from model name)
    const psuFru = {}; // { 1: { model, manufacturer, watt }, 2: ... }
    for (const entry of fruEntries) {
      // Match PSU FRU entries: "PSU1_FRU (ID 89)" or "PSU 1 (ID 2)"
      const psuMatch = entry.match(/:\s*PSU\s*(\d+)/i);
      if (!psuMatch) continue;
      const num = parseInt(psuMatch[1]);
      const info = {};
      entry.split('\n').forEach(line => {
        const parts = line.split(':');
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const val = parts.slice(1).join(':').trim();
          if (key && val) info[key] = val;
        }
      });
      const fruModel = (info['Product Name'] || info['Product Part Number'] || '').trim();
      const fruMfg = (info['Product Manufacturer'] || '').trim();
      if (fruModel && !/^0+$/.test(fruModel)) {
        const watt = extractWattFromModel(fruModel);
        psuFru[num] = { model: fruModel, manufacturer: fruMfg, watt };
      }
    }

    // Best current power reading for notes
    const totalCurrentPower = dcmiCurrent || sysPower ||
      Object.values(psuCurrentWatts).reduce((a, b) => a + b, 0);

    // Build PSU modules, consolidate by model + capacity
    const consolidated = {};
    for (let i = 1; i <= psuCount; i++) {
      const fru = psuFru[i] || {};
      const model = fru.model || 'PSU';
      const manufacturer = fru.manufacturer || '';
      const watt = psuRatedWatts[i] || fru.watt || 0;
      if (watt === 0) continue;
      const capacity = watt + 'W';
      const key = model + '|' + capacity;

      if (consolidated[key]) {
        consolidated[key].count++;
        consolidated[key].slots.push(i);
      } else {
        consolidated[key] = { model, manufacturer, capacity, count: 1, slots: [i] };
      }
    }

    const modules = [];
    for (const entry of Object.values(consolidated)) {
      const noteParts = ['IPMI 자동감지'];
      if (totalCurrentPower > 0) noteParts.push(`현재 총 ${totalCurrentPower}W`);

      modules.push({
        module_type: 'psu',
        model: entry.model,
        manufacturer: entry.manufacturer,
        capacity: entry.capacity,
        count: entry.count,
        slot_info: entry.slots.map(s => 'PSU' + s).join(', '),
        notes: noteParts.join(', ')
      });
    }
    return modules;
  } catch (err) {
    return [];
  }
}

module.exports = { connectAndDiscover, discoverRange, generateIpRange, detectPsuViaIpmi };
