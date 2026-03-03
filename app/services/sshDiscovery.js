const { Client } = require('ssh2');
const appConfig = require('../config/app');
const hardwareParser = require('./hardwareParser');

const DISCOVERY_SCRIPT = `
echo "===HOSTNAME_START==="
hostname
echo "===HOSTNAME_END==="
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
echo "===NETWORK_START==="
lspci -D 2>/dev/null | grep -i ethernet | while IFS= read -r line; do
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
lspci 2>/dev/null | grep -i raid
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
  # smartctl fallback (including MegaRAID physical disks via --scan-open)
  SMARTCTL=$(command -v smartctl 2>/dev/null)
  if [ -n "$SMARTCTL" ]; then
    echo "===SMARTCTL_START==="
    # Use --scan-open to detect RAID-behind disks (megaraid,N etc.)
    SCAN_RESULT=$(sudo $SMARTCTL --scan-open 2>/dev/null || $SMARTCTL --scan-open 2>/dev/null)
    if [ -n "$SCAN_RESULT" ]; then
      echo "$SCAN_RESULT" | while IFS= read -r line; do
        DEV_SPEC=$(echo "$line" | sed 's/#.*//' | xargs)
        if [ -n "$DEV_SPEC" ]; then
          echo "===DEV:$DEV_SPEC==="
          sudo $SMARTCTL -i $DEV_SPEC 2>/dev/null || $SMARTCTL -i $DEV_SPEC 2>/dev/null
        fi
      done
    else
      # Fallback: scan block devices directly
      for dev in $(lsblk -dn -o NAME,TYPE 2>/dev/null | awk '$2=="disk"{print "/dev/"$1}'); do
        echo "===DEV:$dev==="
        sudo $SMARTCTL -i "$dev" 2>/dev/null || $SMARTCTL -i "$dev" 2>/dev/null
      done
    fi
    echo "===SMARTCTL_END==="
  fi
fi
echo "===RAID_PD_END==="
echo "===GPU_START==="
nvidia-smi -L 2>/dev/null || lspci 2>/dev/null | grep -iE 'VGA compatible|3D controller|Display controller'
echo "===GPU_END==="
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

module.exports = { connectAndDiscover, discoverRange, generateIpRange };
