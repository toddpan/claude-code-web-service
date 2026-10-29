// netinfo.mjs — 机器网络指纹（对齐 dsh-web-service GET /ping）。
import os from 'node:os'

const ZERO_MAC = '00:00:00:00:00:00'

export function collectMachineIdentity() {
  const ips = new Set()
  const macs = new Set()
  const interfaces = []
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (!addrs || addrs.length === 0) continue
    for (const addr of addrs) {
      if (!addr.internal) {
        ips.add(addr.address)
        const addrMac = (addr.mac || '').toLowerCase()
        if (addrMac && addrMac !== ZERO_MAC) macs.add(addrMac)
      }
    }
    interfaces.push({
      name,
      mac: (addrs[0]?.mac || '').toLowerCase(),
      addresses: addrs.map(addr => ({ address: addr.address, family: String(addr.family), internal: addr.internal })),
    })
  }
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    ips: [...ips],
    macs: [...macs],
    interfaces,
  }
}

/** 本机局域网 IPv4 列表（非回环、去重，按网卡枚举顺序）；供服务地址列表（bindIp=0.0.0.0 时）生成。 */
export function collectLanIpv4() {
  return collectMachineIdentity().ips.filter(ip => !ip.includes(':'))
}
