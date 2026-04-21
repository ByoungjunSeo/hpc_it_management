// Parse hardware command outputs separated by delimiters

function parseSection(output, sectionName) {
  const startTag = '===' + sectionName + '_START===';
  const endTag = '===' + sectionName + '_END===';
  const startIdx = output.indexOf(startTag);
  const endIdx = output.indexOf(endTag);
  if (startIdx === -1 || endIdx === -1) return '';
  return output.substring(startIdx + startTag.length, endIdx).trim();
}

function parseCpu(output) {
  const section = parseSection(output, 'CPU');
  if (!section) return [];

  const modules = [];
  const lines = section.split('\n');
  const info = {};

  lines.forEach(line => {
    const parts = line.split(':');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const val = parts.slice(1).join(':').trim();
      info[key] = val;
    }
  });

  if (info['Model name']) {
    modules.push({
      module_type: 'cpu',
      model: info['Model name'],
      manufacturer: info['Vendor ID'] || '',
      capacity: (info['CPU(s)'] || '1') + ' cores',
      count: parseInt(info['Socket(s)'] || '1', 10),
      specification: [
        info['Thread(s) per core'] ? info['Thread(s) per core'] + ' threads/core' : '',
        info['Core(s) per socket'] ? info['Core(s) per socket'] + ' cores/socket' : '',
        info['CPU MHz'] ? info['CPU MHz'] + ' MHz' : ''
      ].filter(Boolean).join(', ')
    });
  }

  return modules;
}

function parseMemory(output) {
  const section = parseSection(output, 'MEMORY');
  if (!section) return [];

  const modules = [];
  const devices = section.split('Memory Device');

  devices.forEach(dev => {
    if (!dev.trim()) return;
    const info = {};
    dev.split('\n').forEach(line => {
      const parts = line.split(':');
      if (parts.length >= 2) {
        info[parts[0].trim()] = parts.slice(1).join(':').trim();
      }
    });

    const size = info['Size'];
    if (size && size !== 'No Module Installed' && size !== '0') {
      modules.push({
        module_type: 'memory',
        model: info['Part Number']?.trim() || '',
        manufacturer: info['Manufacturer']?.trim() || '',
        capacity: size,
        count: 1,
        specification: [
          info['Type'] || '',
          info['Speed'] || '',
          info['Configured Memory Speed'] ? 'Configured: ' + info['Configured Memory Speed'] : ''
        ].filter(Boolean).join(', '),
        slot_info: info['Locator'] || ''
      });
    }
  });

  // Consolidate by model + capacity
  const consolidated = {};
  modules.forEach(m => {
    const key = (m.model || '') + '|' + (m.capacity || '');
    if (consolidated[key]) {
      consolidated[key].count++;
    } else {
      consolidated[key] = { ...m };
    }
  });

  return Object.values(consolidated);
}

function parseMemoryFallback(output) {
  // Determine reason: dmidecode not installed vs permission denied
  const memSection = parseSection(output, 'MEMORY');
  const hasDmidecode = memSection && memSection.length > 10;
  const reason = hasDmidecode ? '권한 부족' : 'dmidecode 미설치';

  // Try /proc/meminfo from MEMORY_FALLBACK section
  const section = parseSection(output, 'MEMORY_FALLBACK');
  if (section) {
    const memMatch = section.match(/MemTotal:\s*([\d]+)\s*kB/);
    if (memMatch) {
      const totalGB = Math.round(parseInt(memMatch[1]) / 1024 / 1024);
      return [{
        module_type: 'memory',
        model: '(' + reason + ' - 상세정보 없음)',
        capacity: totalGB + ' GB (total)',
        count: 1,
        specification: '/proc/meminfo'
      }];
    }
  }

  // Last resort: free -h output
  const freeSection = parseSection(output, 'FREE');
  if (freeSection) {
    const freeMatch = freeSection.match(/Mem:\s+(\S+)/);
    if (freeMatch) {
      return [{
        module_type: 'memory',
        model: '(' + reason + ' - 상세정보 없음)',
        capacity: freeMatch[1] + ' (total)',
        count: 1,
        specification: 'free -h'
      }];
    }
  }

  return [];
}

function parseDisk(output, options = {}) {
  const section = parseSection(output, 'DISK');
  if (!section) return [];

  // Parse DISK_DETAIL section for full model names from smartctl
  const detailSection = parseSection(output, 'DISK_DETAIL');
  const fullModelMap = {};
  if (detailSection) {
    detailSection.split('\n').forEach(line => {
      const m = line.match(/^DISKDETAIL:\s*name=(\S+)\s+model=(.+)$/);
      if (m) {
        fullModelMap[m[1].trim()] = m[2].trim();
      }
    });
  }

  const modules = [];
  const lines = section.split('\n').filter(l => l.trim());
  const skipVirtualFilter = options.includeVirtual || false;

  // Skip header line
  lines.forEach((line, idx) => {
    if (idx === 0 && line.includes('NAME')) return;
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 4) {
      const name = parts[0];
      const size = parts[3];
      const type = parts[5] || '';
      let model = parts.slice(6).join(' ') || '';

      if (parts[5] === 'disk') {
        // Use full model name from smartctl if available
        if (fullModelMap[name]) {
          model = fullModelMap[name];
        }

        // Skip RAID/LVM virtual disks (model matches known virtual disk patterns)
        const isVirtualDisk = /^MR\d|^AVAGO|^LSI|^PERC|^Smart\s*Array|^arcconf|^mpt\d|^Logical[_\s]?Volume/i.test(model);
        if (skipVirtualFilter || !isVirtualDisk) {
          // Extract manufacturer from model string
          const mfgMatch = (model || '').match(/^(SEAGATE|TOSHIBA|WDC|Western Digital|Samsung|Micron|Intel|HGST|SanDisk|Crucial|Kingston|SK[_ ]?hynix|Lite-?On|ADATA|PNY|Transcend|KIOXIA|Hitachi|DAPUSTOR)(?=[\s_\-]|$)/i);
          modules.push({
            module_type: 'disk',
            model: model || name,
            manufacturer: mfgMatch ? mfgMatch[1] : '',
            capacity: size,
            count: 1,
            specification: isVirtualDisk ? 'RAID VD' : (type === '0' ? 'SSD' : type === '1' ? 'HDD' : '')
          });
        }
      }
    }
  });

  // Consolidate by model + capacity
  const consolidated = {};
  modules.forEach(m => {
    const key = (m.model || '') + '|' + (m.capacity || '');
    if (consolidated[key]) {
      consolidated[key].count++;
    } else {
      consolidated[key] = { ...m };
    }
  });

  return Object.values(consolidated);
}

function parseNetwork(output) {
  const section = parseSection(output, 'NETWORK');
  if (!section) return [];

  // Parse PCI address + model from lspci output
  // Format: "0000:01:00.0 Ethernet controller: Intel Corporation X550 (rev 01)"
  // [ONBOARD] tag is stripped — discovered modules don't distinguish onboard/add-in
  const entries = [];
  const lines = section.split('\n').filter(l => l.trim());

  lines.forEach(line => {
    const cleanLine = line.startsWith('[ONBOARD]') ? line.replace(/^\[ONBOARD\]\s*/, '') : line;
    const match = cleanLine.match(/^(\S+)\s+Ethernet controller:?\s*(.*)/i);
    if (match) {
      const pciAddr = match[1];
      const model = match[2].trim();
      const busDevice = pciAddr.replace(/\.\d+$/, '');
      entries.push({ pciAddr, busDevice, model });
    }
  });

  // Group by physical card (same bus:device) and model
  const cards = {};
  entries.forEach(e => {
    const key = e.busDevice + '|' + e.model;
    if (!cards[key]) cards[key] = { model: e.model, ports: 0 };
    cards[key].ports++;
  });
  const consolidated = {};
  Object.values(cards).forEach(card => {
    const key = card.model + '|' + card.ports;
    if (consolidated[key]) {
      consolidated[key].count++;
    } else {
      consolidated[key] = {
        module_type: 'network',
        model: card.model,
        count: 1,
        specification: card.ports + '포트'
      };
    }
  });

  return Object.values(consolidated);
}

function parseRaid(output) {
  const section = parseSection(output, 'RAID');
  if (!section) return [];

  const modules = [];
  const lines = section.split('\n').filter(l => l.trim());

  lines.forEach(line => {
    // New format: "RAID: 0000:a8:00.0 RAID bus controller: Broadcom ... [SUBSYS:MegaRAID 9560-8i]"
    // Use Subsystem model if available (more specific product name)
    let model = '';
    const subsysMatch = line.match(/\[SUBSYS:(.+)\]\s*$/);
    const baseLine = subsysMatch ? line.replace(/\s*\[SUBSYS:.+\]\s*$/, '') : line;

    // Extract base model from controller description
    const colonMatch = baseLine.match(/controller:\s*(.+)/i);
    if (colonMatch) {
      model = colonMatch[1].trim();
    } else {
      const raidMatch = baseLine.match(/RAID[^:]*:?\s*(.*)/i);
      if (raidMatch) {
        model = raidMatch[1].trim();
      }
    }

    // Prefer Subsystem name if it contains a meaningful product model
    if (subsysMatch) {
      const subsys = subsysMatch[1].trim();
      if (subsys) {
        // Extract vendor from base model for prefix (e.g. "Broadcom / LSI")
        const vendorMatch = model.match(/^(.+?)\s+(?:MegaRAID|PERC|SmartRAID|SmartArray)/i);
        const vendor = vendorMatch ? vendorMatch[1] : '';
        model = vendor ? vendor + ' ' + subsys : subsys;
      }
    }

    if (!model) return; // Skip RAID entries with empty model names
    // Skip Intel VMD — chipset-integrated NVMe manager, not a real RAID card
    if (/Volume Management Device/i.test(model)) return;
    modules.push({
      module_type: 'raid',
      model: model,
      count: 1
    });
  });

  return modules;
}

function parseSysfsDisks(section) {
  const modules = [];
  const lines = section.split('\n').filter(l => l.startsWith('DISK:'));
  lines.forEach(line => {
    const vendor = (line.match(/vendor=(\S*)/) || [])[1] || '';
    const model = (line.match(/model=(.+?)(?:\s+rev=)/) || [])[1]?.trim() || '';
    const size = (line.match(/size=([\d.]+\s*\w*)/) || [])[1] || '';
    // Filter out RAID controllers themselves (vendor LSI/AVAGO/DELL etc with MR/PERC pattern)
    if (/^MR\d|^PERC|^Logical|^AVAGO/i.test(model)) return;
    if (!model) return;
    const fullModel = vendor && !model.toUpperCase().startsWith(vendor.toUpperCase())
      ? vendor + ' ' + model : model;
    modules.push({
      module_type: 'disk',
      model: fullModel,
      manufacturer: vendor || '',
      capacity: size,
      count: 1,
      specification: ''
    });
  });
  // Consolidate
  const consolidated = {};
  modules.forEach(m => {
    const key = m.model + '|' + m.capacity;
    if (consolidated[key]) consolidated[key].count++;
    else consolidated[key] = { ...m };
  });
  return Object.values(consolidated);
}

function parseSmartctlDisks(section) {
  const smartSection = section.match(/===SMARTCTL_START===([\s\S]*?)===SMARTCTL_END===/);
  if (!smartSection) return [];
  const modules = [];
  const seenSerials = new Set();
  const devices = smartSection[1].split(/===DEV:[^=]+===/);
  devices.forEach(dev => {
    if (!dev.trim()) return;
    const info = {};
    dev.split('\n').forEach(line => {
      const parts = line.split(':');
      if (parts.length >= 2) {
        info[parts[0].trim()] = parts.slice(1).join(':').trim();
      }
    });
    const model = info['Device Model'] || info['Product'] || info['Model Number'] || '';
    let vendor = info['Vendor'] || '';
    // NVMe drives don't have Vendor field — extract from model name
    if (!vendor && model) {
      const mfgMatch = model.match(/^(SEAGATE|TOSHIBA|WDC|Western Digital|Samsung|Micron|Intel|HGST|SanDisk|Crucial|Kingston|SK[_ ]?hynix|Lite-?On|ADATA|PNY|Transcend|KIOXIA|Hitachi|DAPUSTOR)(?=[\s_\-]|$)/i);
      if (mfgMatch) vendor = mfgMatch[1];
    }
    const serial = (info['Serial number'] || info['Serial Number'] || '').trim();
    // NVMe uses 'Total NME Capacity' or 'Namespace 1 Size/Capacity' instead of 'User Capacity'
    const capacity = info['User Capacity'] || info['Total NME Capacity'] || info['Namespace 1 Size/Capacity'] || '';
    const sizeMatch = capacity.match(/([\d,]+)\s*bytes\s*\[([\d.]+\s*\w+)\]/);
    const size = sizeMatch ? sizeMatch[2] : capacity;
    const rpm = info['Rotation Rate'] || '';
    const isSSD = /Solid State/i.test(rpm) || rpm === '0';
    // Skip RAID virtual devices
    if (/^MR\d|^PERC|^Logical|^AVAGO/i.test(model)) return;
    if (!model) return;
    // Deduplicate by serial number (brute-force may re-discover same disk)
    if (serial) {
      if (seenSerials.has(serial)) return;
      seenSerials.add(serial);
    }
    const fullModel = vendor && !model.startsWith(vendor) ? vendor + ' ' + model : model;
    modules.push({
      module_type: 'disk',
      model: fullModel,
      manufacturer: vendor || '',
      capacity: size,
      count: 1,
      specification: isSSD ? 'SSD' : rpm ? 'HDD' : ''
    });
  });
  // Consolidate
  const consolidated = {};
  modules.forEach(m => {
    const key = m.model + '|' + m.capacity;
    if (consolidated[key]) consolidated[key].count++;
    else consolidated[key] = { ...m };
  });
  return Object.values(consolidated);
}

function parseRaidPhysicalDisks(output) {
  const section = parseSection(output, 'RAID_PD');
  if (!section) return [];

  // Detect which tool was used
  const toolMatch = section.match(/===TOOL:(\w+)===/);
  const tool = toolMatch ? toolMatch[1] : 'none';
  if (tool === 'sysfs' || tool === 'none') {
    // Prefer smartctl (full model names) over sysfs (truncated names)
    const smartModules = parseSmartctlDisks(section);
    if (smartModules.length > 0) return smartModules;
    // sysfs fallback
    const sysfsModules = parseSysfsDisks(section);
    if (sysfsModules.length > 0) return sysfsModules;
    return [];
  }

  const modules = [];

  if (tool === 'storcli64' || tool === 'storcli' || tool === 'perccli64' || tool === 'perccli') {
    // storcli/perccli output format:
    // EID:Slt DID State DG   Size Intf Med SED PI SeSz Model                  Sp Type
    //  252:0    6 Onln   0 278.464 GB SAS  HDD N   N  512B SEAGATE ST300MM0048  U  -
    // storcli/perccli table format - parse by splitting on whitespace
    // Header: EID:Slt DID State DG   Size Intf Med SED PI SeSz Model   Sp Type
    // Data:   252:0    6 Onln   0 278.464 GB SAS  HDD N   N  512B ST300MM0048  U  -
    const lines = section.split('\n');
    let headerFound = false;
    lines.forEach(line => {
      if (/EID:Slt/i.test(line)) { headerFound = true; return; }
      if (!headerFound) return;
      if (/^[-=]+$/.test(line.trim())) return; // separator line

      const m = line.match(/^\s*(\d+:\d+)\s+/);
      if (m) {
        const tokens = line.trim().split(/\s+/);
        // tokens: [EID:Slt, DID, State, DG, Size, Unit, Intf, Med, SED, PI, SeSz, ...Model..., Sp, Type]
        if (tokens.length >= 12) {
          const size = tokens[4] + ' ' + tokens[5]; // e.g. "278.464 GB"
          const intf = tokens[6]; // SAS, SATA
          const med = tokens[7];  // HDD, SSD
          // Model: from token 11 to (length-2), join with space
          const modelTokens = tokens.slice(11, tokens.length - 2);
          const model = modelTokens.join(' ').trim() || tokens[11] || '';
          // Extract manufacturer from model
          const storcliMfg = (model || '').match(/^(SEAGATE|TOSHIBA|WDC|Western Digital|Samsung|Micron|Intel|HGST|SanDisk|Crucial|Kingston|SK[_ ]?hynix|Lite-?On|ADATA|PNY|Transcend|KIOXIA|Hitachi|DAPUSTOR)(?=[\s_\-]|$)/i);
          modules.push({
            module_type: 'disk',
            model: model,
            manufacturer: storcliMfg ? storcliMfg[1] : '',
            capacity: size,
            count: 1,
            specification: [med, intf].filter(Boolean).join(' ')
          });
        }
      }
    });
  } else if (tool === 'MegaCli64' || tool === 'MegaCli' || tool === 'megacli') {
    // MegaCli -PDList output format:
    // Enclosure Device ID: 252
    // Slot Number: 0
    // Raw Size: 279.396 GB [0x22ecb25c Sectors]
    // Inquiry Data: SEAGATE ST300MM0048     0003S3Y...
    // Media Type: Hard Disk Device / Solid State Device
    // PD Type: SAS / SATA
    const devices = section.split(/Enclosure Device ID:/);
    devices.forEach(dev => {
      if (!dev.trim()) return;
      const info = {};
      dev.split('\n').forEach(line => {
        const parts = line.split(':');
        if (parts.length >= 2) {
          info[parts[0].trim()] = parts.slice(1).join(':').trim();
        }
      });

      const rawSize = info['Raw Size'] || info['Coerced Size'] || '';
      const sizeMatch = rawSize.match(/([\d.]+)\s*(TB|GB|MB)/);
      const size = sizeMatch ? sizeMatch[1] + ' ' + sizeMatch[2] : rawSize.split('[')[0].trim();

      // Get model from Inquiry Data
      // SAS format: "VENDOR   MODEL           SERIAL" (space-padded fields)
      // SATA format: "SERIALVendor_Model                FIRMWARE" (serial prepended)
      let model = '';
      const rawInquiry = (info['Inquiry Data'] || '').trim();
      if (rawInquiry) {
        // Split by 2+ spaces to separate fields
        const fields = rawInquiry.split(/\s{2,}/).filter(Boolean);
        const pdType = (info['PD Type'] || '').toUpperCase();

        if (pdType === 'SAS' || /^[A-Z]{2,}/.test(rawInquiry)) {
          // SAS: first fields are vendor+model, last is serial
          // e.g. "TOSHIBA AL14SEB060N     01039820A0TAFV7B"
          // e.g. "SEAGATE ST300MM0048     0003S3Y0JMA0"
          if (fields.length >= 2) {
            model = fields.slice(0, fields.length - 1).join(' ');
          } else {
            model = fields[0] || '';
          }
        } else {
          // SATA: serial often prepended to vendor_model
          // e.g. "18471F937FDFMicron_5200_MTFDDAK3T8TDC    D1MU404"
          // Try to find known vendor name in the string
          const vendorMatch = rawInquiry.match(/(Micron|Samsung|Intel|WDC|Western Digital|Crucial|Kingston|SK[_ ]?hynix|Seagate|TOSHIBA|HGST|SanDisk|Lite-?On|ADATA|PNY|Transcend|KIOXIA|Hitachi|DAPUSTOR)[_\s\-]?[\w\-_]+/i);
          if (vendorMatch) {
            model = vendorMatch[0].trim();
          } else if (fields.length >= 2) {
            model = fields.slice(0, fields.length - 1).join(' ');
          } else {
            model = fields[0] || '';
          }
        }
      }

      const mediaType = info['Media Type'] || '';
      const pdType = info['PD Type'] || '';
      const isSSD = /solid\s*state/i.test(mediaType) || /SSD/i.test(mediaType);
      const isHDD = /hard\s*disk/i.test(mediaType) || /HDD/i.test(mediaType);

      if (size || model) {
        // Extract manufacturer from model or raw inquiry
        const megaMfgMatch = (model || '').match(/^(SEAGATE|TOSHIBA|WDC|Western Digital|Samsung|Micron|Intel|HGST|SanDisk|Crucial|Kingston|SK[_ ]?hynix|Lite-?On|ADATA|PNY|Transcend|KIOXIA|Hitachi|DAPUSTOR)(?=[\s_\-]|$)/i);
        modules.push({
          module_type: 'disk',
          model: model || 'Unknown',
          manufacturer: megaMfgMatch ? megaMfgMatch[1] : '',
          capacity: size || '',
          count: 1,
          specification: [isSSD ? 'SSD' : isHDD ? 'HDD' : '', pdType].filter(Boolean).join(' ')
        });
      }
    });
  } else if (tool === 'ssacli' || tool === 'hpssacli') {
    // ssacli output format:
    //    physicaldrive 1I:1:1
    //       Port: 1I
    //       Box: 1
    //       Bay: 1
    //       Status: OK
    //       Size: 300 GB
    //       Interface Type: SAS
    //       Rotational Speed: 10000
    //       Model: EG0300FCSPH
    const devices = section.split(/physicaldrive\s+/i);
    devices.forEach(dev => {
      if (!dev.trim()) return;
      const info = {};
      dev.split('\n').forEach(line => {
        const parts = line.split(':');
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const val = parts.slice(1).join(':').trim();
          if (key && val) info[key] = val;
        }
      });

      const size = info['Size'] || '';
      const model = info['Model'] || '';
      const intf = info['Interface Type'] || '';
      const rpm = info['Rotational Speed'] || '';
      const isSSD = rpm === '0' || /SSD|Solid/i.test(info['Drive Type'] || '');

      if (size || model) {
        const ssaMfg = (model || '').match(/^(SEAGATE|TOSHIBA|WDC|Western Digital|Samsung|Micron|Intel|HGST|SanDisk|Crucial|Kingston|SK[_ ]?hynix|Lite-?On|ADATA|PNY|Transcend|KIOXIA|Hitachi|DAPUSTOR)(?=[\s_\-]|$)/i);
        modules.push({
          module_type: 'disk',
          model: model || 'Unknown',
          manufacturer: ssaMfg ? ssaMfg[1] : '',
          capacity: size,
          count: 1,
          specification: [isSSD ? 'SSD' : rpm ? 'HDD' : '', intf].filter(Boolean).join(' ')
        });
      }
    });
  } else if (tool === 'arcconf') {
    // arcconf getconfig 1 pd output:
    //    Device #0
    //       Device is a Hard drive
    //       State                          : Online
    //       Size                           : 286102 MB
    //       Model                          : ST300MM0048
    //       Serial number                  : ...
    //       Transfer Speed                 : SAS 12.0 Gb/s
    const devices = section.split(/Device #\d+/);
    devices.forEach(dev => {
      if (!dev.trim()) return;
      const info = {};
      dev.split('\n').forEach(line => {
        const parts = line.split(':');
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const val = parts.slice(1).join(':').trim();
          if (key && val) info[key] = val;
        }
      });

      const rawSize = info['Size'] || '';
      let size = rawSize;
      // Convert MB to GB if needed
      const mbMatch = rawSize.match(/([\d.]+)\s*MB/i);
      if (mbMatch) {
        size = (parseFloat(mbMatch[1]) / 1024).toFixed(1) + ' GB';
      }

      const model = info['Model'] || '';
      const speed = info['Transfer Speed'] || '';
      const isHardDrive = /hard\s*drive/i.test(dev);
      const isSSD = /Solid/i.test(dev) || /SSD/i.test(dev);

      if (size || model) {
        const arcMfg = (model || '').match(/^(SEAGATE|TOSHIBA|WDC|Western Digital|Samsung|Micron|Intel|HGST|SanDisk|Crucial|Kingston|SK[_ ]?hynix|Lite-?On|ADATA|PNY|Transcend|KIOXIA|Hitachi|DAPUSTOR)(?=[\s_\-]|$)/i);
        modules.push({
          module_type: 'disk',
          model: model.trim() || 'Unknown',
          manufacturer: arcMfg ? arcMfg[1] : '',
          capacity: size,
          count: 1,
          specification: [isSSD ? 'SSD' : isHardDrive ? 'HDD' : '', speed].filter(Boolean).join(' ')
        });
      }
    });
  }

  // Enrich with smartctl data if available (provides full vendor+model names)
  if (modules.length > 0) {
    const smartModules = parseSmartctlDisks(section);
    if (smartModules.length > 0) {
      modules.forEach(m => {
        if (m.manufacturer) return; // Already has manufacturer
        // Try to find matching smartctl module by model substring
        const match = smartModules.find(sm =>
          sm.model && m.model && (
            sm.model.toLowerCase().includes(m.model.toLowerCase()) ||
            m.model.toLowerCase().includes((sm.model || '').split(' ').pop().toLowerCase())
          )
        );
        if (match) {
          if (match.manufacturer && !m.manufacturer) m.manufacturer = match.manufacturer;
          // If smartctl has a fuller model name, use it
          if (match.model && match.model.length > (m.model || '').length) {
            m.model = match.model;
          }
        }
      });
    }
  }

  // Consolidate by model + capacity
  const consolidated = {};
  modules.forEach(m => {
    const key = (m.model || '') + '|' + (m.capacity || '');
    if (consolidated[key]) {
      consolidated[key].count++;
    } else {
      consolidated[key] = { ...m };
    }
  });

  return Object.values(consolidated);
}

function parseGpu(output) {
  const section = parseSection(output, 'GPU');
  if (!section) return [];

  const modules = [];

  // Try lspci format first — more accurate chipset model names
  // (filter out BMC/management VGA like ASPEED, Matrox)
  const allLines = section.split('\n').filter(l => l.trim());
  allLines.forEach(line => {
    if (/ASPEED|Matrox|ServerEngines|iBMC|Hi171x|iLO|IPMI|BMC/i.test(line)) return;
    const match = line.match(/(?:VGA|3D|Display).*?:\s*(.*)/i);
    if (match) {
      modules.push({
        module_type: 'gpu',
        model: match[1].trim(),
        count: 1
      });
    }
  });

  // Fallback to nvidia-smi if lspci found nothing
  if (modules.length === 0) {
    const isNvidiaSmiError = /NVIDIA-SMI has failed|driver.*not.*install|driver.*not.*running|Make sure that|Failed to initialize|No devices were found/i.test(section);
    if (!isNvidiaSmiError) {
      allLines.forEach(line => {
        const m = line.match(/^GPU\s+\d+:\s+(.+?)(?:\s*\(UUID:.*\))?$/);
        if (m) {
          modules.push({
            module_type: 'gpu',
            model: m[1].trim(),
            manufacturer: m[1].includes('NVIDIA') ? 'NVIDIA' : m[1].includes('AMD') ? 'AMD' : '',
            count: 1
          });
        }
      });
    }
  }

  // Consolidate
  const consolidated = {};
  modules.forEach(m => {
    if (consolidated[m.model]) {
      consolidated[m.model].count++;
    } else {
      consolidated[m.model] = { ...m };
    }
  });

  return Object.values(consolidated);
}

function parseHostname(output) {
  const section = parseSection(output, 'HOSTNAME');
  return section.split('\n')[0]?.trim() || '';
}

function parseFreeMemory(output) {
  const section = parseSection(output, 'FREE');
  if (!section) return '';
  const match = section.match(/Mem:\s+(\S+)/);
  return match ? match[1] : '';
}

function parseAll(output) {
  const raidModules = parseRaid(output);
  // Only consider RAID present if lspci actually detected a RAID controller
  // (RAID_PD section always has content from sysfs/smartctl fallback even without RAID)
  const hasRaid = raidModules.length > 0;

  // If RAID controller detected, try RAID tool physical disks first
  let diskModules;
  if (hasRaid) {
    const raidPdModules = parseRaidPhysicalDisks(output);
    if (raidPdModules.length > 0) {
      diskModules = raidPdModules;
    } else {
      // Try lsblk with virtual disk filter
      diskModules = parseDisk(output);
      // If still nothing (all disks were RAID virtual), show virtual disks as fallback
      if (diskModules.length === 0) {
        diskModules = parseDisk(output, { includeVirtual: true });
      }
    }
  } else {
    diskModules = parseDisk(output);
  }

  // Memory: try dmidecode first, then fallback
  let memoryModules = parseMemory(output);
  if (memoryModules.length === 0) {
    memoryModules = parseMemoryFallback(output);
  }

  return {
    hostname: parseHostname(output),
    totalMemory: parseFreeMemory(output),
    modules: [
      ...parseCpu(output),
      ...memoryModules,
      ...diskModules,
      ...parseNetwork(output),
      ...raidModules,
      ...parseGpu(output)
    ]
  };
}

module.exports = {
  parseAll,
  parseCpu,
  parseMemory,
  parseMemoryFallback,
  parseDisk,
  parseSysfsDisks,
  parseSmartctlDisks,
  parseRaidPhysicalDisks,
  parseNetwork,
  parseRaid,
  parseGpu,
  parseHostname,
  parseFreeMemory
};
