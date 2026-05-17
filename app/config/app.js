module.exports = {
  port: process.env.PORT || 3000,

  serverRooms: ['AIDC', 'HPC'],

  assetTypes: [
    { value: 'server', label: '서버' },
    { value: 'switch', label: '스위치' },
    { value: 'kvm', label: 'KVM' },
    { value: 'pdu', label: 'PDU' },
    { value: 'ups', label: 'UPS' },
    { value: 'storage', label: '스토리지' },
    { value: 'immersion_tank', label: '액침탱크' },
    { value: 'cdu', label: 'CDU' },
    { value: 'chiller', label: '칠러' },
    { value: 'other', label: '기타' }
  ],

  ownershipTypes: [
    { value: 'company', label: '자사' },
    { value: 'vendor', label: '업체' }
  ],

  assetStatuses: [
    { value: 'active', label: '운영중' },
    { value: 'inactive', label: '비활성' },
    { value: 'returned', label: '반납' },
    { value: 'maintenance', label: '점검중' },
    { value: 'decommissioned', label: '폐기' }
  ],

  moduleTypes: [
    { value: 'cpu', label: 'CPU' },
    { value: 'memory', label: '메모리' },
    { value: 'disk', label: '디스크' },
    { value: 'network', label: '네트워크' },
    { value: 'raid', label: 'RAID' },
    { value: 'gpu', label: 'GPU' },
    { value: 'npu', label: 'NPU' },
    { value: 'psu', label: 'PSU' },
    { value: 'cable', label: '케이블' }
  ],

  allIncomingTypes: [
    { value: 'server', label: '서버', category: 'equipment' },
    { value: 'switch', label: '스위치', category: 'equipment' },
    { value: 'pdu', label: 'PDU', category: 'equipment' },
    { value: 'ups', label: 'UPS', category: 'equipment' },
    { value: 'storage', label: '스토리지', category: 'equipment' },
    { value: 'kvm', label: 'KVM', category: 'equipment' },
    { value: 'immersion_tank', label: '액침탱크', category: 'equipment' },
    { value: 'cdu', label: 'CDU', category: 'equipment' },
    { value: 'chiller', label: '칠러', category: 'equipment' },
    { value: 'other', label: '기타', category: 'equipment' },
    { value: 'cpu', label: 'CPU', category: 'module' },
    { value: 'memory', label: '메모리', category: 'module' },
    { value: 'disk', label: '디스크', category: 'module' },
    { value: 'network', label: '네트워크', category: 'module' },
    { value: 'raid', label: 'RAID', category: 'module' },
    { value: 'gpu', label: 'GPU', category: 'module' },
    { value: 'npu', label: 'NPU', category: 'module' },
    { value: 'psu', label: 'PSU', category: 'module' },
    { value: 'cable', label: '케이블', category: 'module' }
  ],

  ipTypes: [
    { value: 'management', label: 'Management' },
    { value: 'bmc', label: 'BMC' },
    { value: 'ib', label: 'InfiniBand' },
    { value: 'data', label: 'Data' },
    { value: 'os', label: 'OS' },
    { value: 'other', label: '기타' }
  ],

  credentialTypes: [
    { value: 'root', label: 'Root' },
    { value: 'user', label: 'User' },
    { value: 'bmc', label: 'BMC' }
  ],

  locationTypes: [
    { value: 'server_room', label: '서버실' },
    { value: 'office', label: '사무실' },
    { value: 'storage', label: '장비실/보관' }
  ],

  networkZones: [
    { value: 'office', label: 'Office' },
    { value: 'hpc', label: 'HPC' },
    { value: 'aidc', label: 'AIDC' }
  ],

  subnets: [
    { subnet: '10.100.40.0/24', zone: 'office', label: 'Office-1' },
    { subnet: '10.100.50.0/24', zone: 'office', label: 'Office-2' },
    { subnet: '10.100.250.0/24', zone: 'hpc', label: 'HPC-1' },
    { subnet: '10.100.251.0/24', zone: 'hpc', label: 'HPC-2' },
    { subnet: '10.100.252.0/24', zone: 'hpc', label: 'HPC-3' },
    { subnet: '10.100.230.0/24', zone: 'aidc', label: 'AIDC-1' },
    { subnet: '10.100.231.0/24', zone: 'aidc', label: 'AIDC-2' },
    { subnet: '10.100.232.0/24', zone: 'aidc', label: 'AIDC-3' },
    { subnet: '10.100.233.0/24', zone: 'aidc', label: 'AIDC-4' }
  ],

  lendingDirections: [
    { value: 'outbound', label: 'TTA \u2192 \uc678\ubd80 (\ub300\uc5ec)' },
    { value: 'inbound', label: '\uc678\ubd80 \u2192 TTA (\ucc28\uc785)' }
  ],

  lendingStatuses: [
    { value: 'active', label: '\ub300\uc5ec\uc911' },
    { value: 'returned', label: '\ubc18\ub0a9\uc644\ub8cc' }
  ],

  powerNodeTypes: [
    { value: 'main_panel', label: '메인 분전반' },
    { value: 'sub_panel', label: '분전반' },
    { value: 'hvac', label: '항온항습기' },
    { value: 'pdu', label: 'PDU' },
    { value: 'ups', label: 'UPS' }
  ],

  cableTypes: [
    { value: 'fiber_sm', label: '광케이블 (싱글모드)' },
    { value: 'fiber_mm', label: '광케이블 (멀티모드)' },
    { value: 'cat6', label: 'Cat6 UTP' },
    { value: 'cat6a', label: 'Cat6a UTP' },
    { value: 'dac', label: 'DAC' },
    { value: 'aoc', label: 'AOC' },
    { value: 'infiniband', label: 'InfiniBand' },
    { value: 'other', label: '기타' }
  ],

  connectionStatuses: [
    { value: 'active', label: '사용중' },
    { value: 'inactive', label: '미사용' },
    { value: 'planned', label: '계획' }
  ],

  ssh: {
    defaultUser: 'root',
    defaultPassword: 'qwe123',
    defaultPort: 22,
    connectTimeout: 10000,
    maxConcurrent: 10
  }
};
