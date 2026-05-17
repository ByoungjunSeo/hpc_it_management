const { Client } = require('ssh2');
const appConfig = require('../config/app');

// SSH script: dcgmi first → nvidia-smi fallback → error if neither available
const GPU_MONITOR_SCRIPT = `
echo "===GPU_TOOL_START==="
if command -v dcgmi >/dev/null 2>&1; then
  echo "TOOL:dcgmi"
  echo "===DCGMI_START==="
  dcgmi dmon -e 150,155,203,204,1001,1002 -c 1 2>/dev/null
  echo "===DCGMI_END==="
  echo "===NVIDIA_NAME_START==="
  nvidia-smi --query-gpu=index,name,memory.total,memory.used,memory.free --format=csv,noheader,nounits 2>/dev/null
  echo "===NVIDIA_NAME_END==="
elif command -v nvidia-smi >/dev/null 2>&1; then
  echo "TOOL:nvidia-smi"
  echo "===NVIDIA_START==="
  nvidia-smi --query-gpu=index,name,temperature.gpu,utilization.gpu,utilization.memory,memory.total,memory.used,memory.free,power.draw,power.limit --format=csv,noheader,nounits 2>/dev/null
  echo "===NVIDIA_END==="
else
  echo "TOOL:none"
fi
echo "===GPU_TOOL_END==="
`;

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

function parseDcgmiOutput(output) {
  const gpus = [];
  const dcgmiBlock = extractBlock(output, '===DCGMI_START===', '===DCGMI_END===');
  const nameBlock = extractBlock(output, '===NVIDIA_NAME_START===', '===NVIDIA_NAME_END===');

  // Parse nvidia-smi name/memory info into a map by index
  const nameMap = {};
  if (nameBlock) {
    nameBlock.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const parts = trimmed.split(',').map(s => s.trim());
      if (parts.length >= 5) {
        nameMap[parts[0]] = {
          name: parts[1],
          memTotal: parseFloat(parts[2]) || 0,
          memUsed: parseFloat(parts[3]) || 0,
          memFree: parseFloat(parts[4]) || 0
        };
      }
    });
  }

  if (!dcgmiBlock) return gpus;

  // dcgmi dmon output: header line(s) starting with # then data lines
  // Fields for -e 150,155,203,204,1001,1002:
  //   Entity  SMTMP  MMTMP  GPUTL  MCUTL   POWER  PWRLM
  const lines = dcgmiBlock.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('Entity')) continue;

    const parts = trimmed.split(/\s+/);
    // Expect: GPU_ID  SMTMP  MMTMP  GPUTL  MCUTL  POWER  PWRLM
    if (parts.length < 7) continue;

    // Skip if first column is not a number (entity ID)
    const idx = parseInt(parts[0], 10);
    if (isNaN(idx)) continue;

    const info = nameMap[String(idx)] || {};
    const temp = parseFloatSafe(parts[1]);
    const memTemp = parseFloatSafe(parts[2]);
    const gpuUtil = parseFloatSafe(parts[3]);
    const memUtil = parseFloatSafe(parts[4]);
    const powerDraw = parseFloatSafe(parts[5]);
    const powerLimit = parseFloatSafe(parts[6]);

    gpus.push({
      index: idx,
      name: info.name || 'GPU ' + idx,
      temp,
      memTemp,
      gpuUtil,
      memUtil,
      memTotal: info.memTotal || 0,
      memUsed: info.memUsed || 0,
      memFree: info.memFree || 0,
      powerDraw,
      powerLimit
    });
  }

  return gpus;
}

function parseNvidiaSmiOutput(output) {
  const gpus = [];
  const block = extractBlock(output, '===NVIDIA_START===', '===NVIDIA_END===');
  if (!block) return gpus;

  block.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parts = trimmed.split(',').map(s => s.trim());
    // index,name,temperature.gpu,utilization.gpu,utilization.memory,memory.total,memory.used,memory.free,power.draw,power.limit
    if (parts.length < 10) return;

    gpus.push({
      index: parseInt(parts[0], 10) || 0,
      name: parts[1] || 'GPU',
      temp: parseFloatSafe(parts[2]),
      memTemp: null,
      gpuUtil: parseFloatSafe(parts[3]),
      memUtil: parseFloatSafe(parts[4]),
      memTotal: parseFloatSafe(parts[5]),
      memUsed: parseFloatSafe(parts[6]),
      memFree: parseFloatSafe(parts[7]),
      powerDraw: parseFloatSafe(parts[8]),
      powerLimit: parseFloatSafe(parts[9])
    });
  });

  return gpus;
}

function parseFloatSafe(val) {
  if (!val || val === 'N/A' || val === '-') return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

function extractBlock(output, startMarker, endMarker) {
  const startIdx = output.indexOf(startMarker);
  const endIdx = output.indexOf(endMarker);
  if (startIdx < 0 || endIdx < 0) return null;
  return output.substring(startIdx + startMarker.length, endIdx).trim();
}

function detectTool(output) {
  const block = extractBlock(output, '===GPU_TOOL_START===', '===GPU_TOOL_END===');
  if (!block) return 'none';
  if (block.includes('TOOL:dcgmi')) return 'dcgmi';
  if (block.includes('TOOL:nvidia-smi')) return 'nvidia-smi';
  return 'none';
}

function collectGpuMetrics(host, options = {}) {
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
      conn.exec(GPU_MONITOR_SCRIPT, (err, stream) => {
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

        stream.on('data', (data) => {
          output += data.toString();
        });

        stream.stderr.on('data', () => {
          // ignore stderr
        });

        stream.on('close', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            conn.end();
            semaphore.release();

            try {
              const tool = detectTool(output);
              if (tool === 'none') {
                return resolve({
                  ip: host,
                  status: 'no_gpu_tool',
                  tool: 'none',
                  error: 'dcgmi/nvidia-smi not found',
                  gpus: []
                });
              }

              let gpus;
              if (tool === 'dcgmi') {
                gpus = parseDcgmiOutput(output);
              } else {
                gpus = parseNvidiaSmiOutput(output);
              }

              resolve({
                ip: host,
                status: 'success',
                tool,
                gpus
              });
            } catch (parseErr) {
              resolve({
                ip: host,
                status: 'parse_error',
                error: 'Parse error: ' + parseErr.message,
                gpus: []
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
          status,
          error: err.message,
          gpus: []
        });
      }
    });

    conn.connect({
      host,
      port,
      username: user,
      password,
      readyTimeout: timeout,
      algorithms: {
        kex: ['diffie-hellman-group14-sha256', 'diffie-hellman-group14-sha1',
              'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521'],
      }
    });
  });
}

module.exports = { collectGpuMetrics };
