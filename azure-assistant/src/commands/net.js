import { execSync } from 'child_process';

function az(args, opts = {}) {
  const subscription = opts.subscription ? `--subscription ${opts.subscription}` : '';
  const cmd = `az ${args} ${subscription}`.trim();
  try {
    const out = execSync(cmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    return out.trim() ? JSON.parse(out) : null;
  } catch (e) {
    const errMsg = e.stderr ? e.stderr.toString() : e.message;
    throw new Error(`Azure CLI failed: ${cmd}\n${errMsg}`);
  }
}

export async function netList(rg) {
  const args = rg ? `--resource-group "${rg}"` : '';
  console.log(`\nVirtual Networks${rg ? ` in "${rg}"` : ''}:`);
  const vnets = az(`network vnet list ${args} --output json`);
  for (const v of vnets || []) {
    console.log(`  VNet: ${v.name} (${v.location})`);
  }

  console.log(`\nPublic IPs${rg ? ` in "${rg}"` : ''}:`);
  const pips = az(`network public-ip list ${args} --output json`);
  for (const p of pips || []) {
    console.log(`  IP: ${p.ipAddress} (${p.name})`);
  }

  console.log(`\nNetwork Security Groups${rg ? ` in "${rg}"` : ''}:`);
  const nsg = az(`network nsg list ${args} --output json`);
  for (const n of nsg || []) {
    console.log(`  NSG: ${n.name}`);
  }
  console.log('');
}

export async function netCreate(rg, name, location, subscription) {
  console.log(`Creating networking stack "${name}" in "${rg}"...`);

  // VNet
  console.log('  Creating VNet...');
  az(`network vnet create --resource-group "${rg}" --name "${name}-vnet" --address-prefix 10.0.0.0/16 --subnet-name default --subnet-prefix 10.0.0.0/24 --location "${location}" --output json`, { subscription });

  // Public IP
  console.log('  Creating Public IP...');
  const pip = az(`network public-ip create --resource-group "${rg}" --name "${name}-pip" --sku Standard --location "${location}" --output json`, { subscription });
  console.log(`  Public IP: ${pip.ipAddress}`);

  // NSG
  console.log('  Creating NSG...');
  az(`network nsg create --resource-group "${rg}" --name "${name}-nsg" --location "${location}" --output json`, { subscription });

  // NSG rules
  console.log('  Adding NSG rules (80/443/22)...');
  az(`network nsg rule create --resource-group "${rg}" --nsg-name "${name}-nsg" --name allow-http --protocol tcp --priority 100 --destination-port-range 80 --access Allow --output json`, { subscription });
  az(`network nsg rule create --resource-group "${rg}" --nsg-name "${name}-nsg" --name allow-https --protocol tcp --priority 110 --destination-port-range 443 --access Allow --output json`, { subscription });
  az(`network nsg rule create --resource-group "${rg}" --nsg-name "${name}-nsg" --name allow-ssh --protocol tcp --priority 120 --destination-port-range 22 --access Allow --output json`, { subscription });

  console.log(`\n✓ Networking stack "${name}" created in "${rg}"\n`);
}

export async function netDelete(rg, name, subscription) {
  console.log(`Deleting networking stack "${name}" from "${rg}"...`);
  az(`network vnet delete --resource-group "${rg}" --name "${name}-vnet" --output json`, { subscription });
  az(`network public-ip delete --resource-group "${rg}" --name "${name}-pip" --output json`, { subscription });
  az(`network nsg delete --resource-group "${rg}" --name "${name}-nsg" --output json`, { subscription });
  console.log(`✓ Deleted networking stack "${name}"\n`);
}