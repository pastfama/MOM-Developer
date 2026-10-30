import { execSync } from 'child_process';

function az(args, opts = {}) {
  const rg = opts.resourceGroup ? `--resource-group "${opts.resourceGroup}"` : '';
  const cmd = `az ${args} ${rg}`.trim();
  try {
    const out = execSync(cmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    return out.trim() ? JSON.parse(out) : null;
  } catch (e) {
    const errMsg = e.stderr ? e.stderr.toString() : e.message;
    throw new Error(`Azure CLI failed: ${cmd}\n${errMsg}`);
  }
}

export async function dnsList(zone, resourceGroup) {
  const rg = resourceGroup ? `--resource-group "${resourceGroup}"` : '';
  console.log(`\nDNS records in zone "${zone}":`);
  console.log('─────────────────────────────────────────────────────────────');

  const aRecords = az(`network dns record-set a list --zone-name "${zone}" ${rg} --output json`);
  for (const r of aRecords || []) {
    const ip = r.aRecords?.map(a => a.ipv4Address).join(', ') || '—';
    console.log(`  A    ${r.name.padEnd(20)} ${ip}`);
  }

  const cnameRecords = az(`network dns record-set cname list --zone-name "${zone}" ${rg} --output json`);
  for (const r of cnameRecords || []) {
    const target = r.cnameRecord?.cname || '—';
    console.log(`  CNAME ${r.name.padEnd(17)} ${target}`);
  }
  console.log('');
}

export async function dnsCreate(zone, name, type, ip, resourceGroup) {
  const rg = resourceGroup ? `--resource-group "${resourceGroup}"` : '';
  const recordSetName = name === '@' ? '@' : name;
  console.log(`Creating ${type} record "${name}" → ${ip} in zone "${zone}"...`);
  az(`network dns record-set ${type.toLowerCase()} add-record --resource-group "${resourceGroup || 'fameshire'}" --zone-name "${zone}" --name "${recordSetName}" --ipv4-address "${ip}" --output json`);
  console.log(`✓ ${type} record "${name}.${zone}" → ${ip}\n`);
}

export async function dnsDelete(zone, name, type, resourceGroup) {
  const rg = resourceGroup ? `--resource-group "${resourceGroup}"` : '';
  const recordSetName = name === '@' ? '@' : name;
  console.log(`Deleting ${type} record "${name}" from zone "${zone}"...`);
  az(`network dns record-set ${type.toLowerCase()} delete --resource-group "${resourceGroup || 'fameshire'}" --zone-name "${zone}" --name "${recordSetName}" --yes --output json`);
  console.log(`✓ Deleted ${type} record "${name}.${zone}"\n`);
}