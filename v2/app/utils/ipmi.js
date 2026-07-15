// SUX-6: ipmitool 공통 호출 빌더 — SOL(스트리밍)·전원제어(일회성)가 동일 방식으로 쓴다.
// 비밀번호는 argv(-P)가 아니라 IPMI_PASSWORD env(-E)로만 전달해 ps/로그 노출을 없앤다.
//   (ipmitool 1.8.18 실측: -E + IPMI_PASSWORD env 설정 시 정상. env 미설정 시에만
//    "Unable to read password from environment"가 나므로 env를 반드시 채워 전달한다.)
const { spawn, execFile } = require('child_process');

const IPMITOOL = process.env.IPMITOOL_BIN || 'ipmitool'; // 격리 검증 시 mock 주입용

// 표준 인자: -I lanplus -H <host> -U <user> -E <...tail>  (비밀번호 argv 부재)
function ipmiArgs(host, user, tail) {
  return ['-I', 'lanplus', '-H', host, '-U', user, '-E', ...(tail || [])];
}

// 자식 프로세스 env: 부모 env + IPMI_PASSWORD(평문은 이 객체에만 존재).
function ipmiEnv(password) {
  return Object.assign({}, process.env, { IPMI_PASSWORD: password || '' });
}

// 스트리밍용(SOL): ChildProcess 반환.
function ipmiSpawn(host, user, password, tail) {
  return spawn(IPMITOOL, ipmiArgs(host, user, tail), { env: ipmiEnv(password) });
}

// 일회성(전원제어 등): Promise<{ err, stdout, stderr }> (거부하지 않음 — err를 함께 전달).
function ipmiExecFile(host, user, password, tail, opts) {
  return new Promise((resolve) => {
    execFile(IPMITOOL, ipmiArgs(host, user, tail), Object.assign({ env: ipmiEnv(password) }, opts || {}),
      (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' }));
  });
}

module.exports = { IPMITOOL, ipmiArgs, ipmiEnv, ipmiSpawn, ipmiExecFile };
