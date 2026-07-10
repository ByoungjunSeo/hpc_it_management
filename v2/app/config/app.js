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

  // B-5b \ubc30\ud3ec \uc124\uc815\ud654: \uc0ac\uc774\ud2b8\ubcc4 IP \ub300\uc5ed\uc740 .env\uc758 SUBNETS_JSON\uc5d0\uc11c \ub85c\ub4dc.
  // \ubbf8\uc124\uc815 \uc2dc \ube48 \ubc30\uc5f4 \u2014 ip_addresses \uc790\ub3d9 \uc2dc\ub4dc\uac00 skip\ub418\uc5b4 \ub370\uc774\ud130 0 \uc0c1\ud0dc\ub85c \uae30\ub3d9.
  // \ud615\uc2dd: [{"subnet":"10.100.40.0/24","zone":"office","label":"Office-1"}, ...]
  subnets: (() => {
    if (!process.env.SUBNETS_JSON) return [];
    try {
      const parsed = JSON.parse(process.env.SUBNETS_JSON);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.error('[config] SUBNETS_JSON \ud30c\uc2f1 \uc2e4\ud328 \u2014 \ube48 \uc11c\ube0c\ub137\uc73c\ub85c \uae30\ub3d9:', e.message);
      return [];
    }
  })(),

  // B-5b \ubc30\ud3ec \uc124\uc815\ud654: \uae30\uad00\uba85 \ub77c\ubca8 (\uae30\ubcf8 TTA \u2014 \uc6b0\ub9ac \uc778\uc2a4\ud134\uc2a4 \ubb34\uc601\ud5a5)
  lendingDirections: (() => {
    const org = process.env.LENDING_ORG_LABEL || 'TTA';
    return [
      { value: 'outbound', label: org + ' \u2192 \uc678\ubd80 (\ub300\uc5ec)' },
      { value: 'inbound', label: '\uc678\ubd80 \u2192 ' + org + ' (\ucc28\uc785)' }
    ];
  })(),

  lendingStatuses: [
    { value: 'active', label: '\ub300\uc5ec\uc911' },
    { value: 'returned', label: '\ubc18\ub0a9\uc644\ub8cc' }
  ],

  // FIX-B: \uac10\uc0ac\ub85c\uadf8 \ub300\uc0c1\uc720\ud615 \ud45c\uc2dc \ub77c\ubca8 (DB\uac12 \ubd88\ubcc0 \u2014 \ud45c\uc2dc \uacc4\uce35 \ubcc0\ud658\ub9cc)
  // \ucf54\ub4dc \uc804\uc218 \uc870\uc0ac \uae30\uc900 14\uc885. \ubbf8\ub798 \uac12\uc740 raw fallback.
  auditTargetTypeLabels: {
    asset: '\uc790\uc0b0',
    asset_incoming: '\uc7a5\ube44\uc785\uace0',
    equipment_usage: '\uc0ac\uc6a9\ub4f1\ub85d',
    computing_module: '\ucef4\ud4e8\ud305\ubaa8\ub4c8',
    module_inventory: '\ubd80\ud488\uc7ac\uace0',
    module_incoming: '\ubd80\ud488\uc785\uace0',
    module_usage: '\ubd80\ud488\uc0ac\uc6a9',
    lending: '\ub300\uc5ec',
    rack: '\ub799',
    room: '\uc11c\ubc84\uc2e4',
    ip: 'IP',
    photo: '\uc0ac\uc9c4',
    user: '\uc0ac\uc6a9\uc790',
    vendor_intake: '\uc5c5\uccb4\uc785\uace0\uc2e0\uccad'
  },

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
    defaultUser: process.env.SSH_DEFAULT_USER || 'root',
    // 하드코딩 제거(B-4d-7a): 자격증명 없는 자산의 SSH 스캔 fallback — .env의 SSH_DEFAULT_PASSWORD
    defaultPassword: process.env.SSH_DEFAULT_PASSWORD || '',
    defaultPort: 22,
    connectTimeout: 10000,
    maxConcurrent: 10
  }
};
