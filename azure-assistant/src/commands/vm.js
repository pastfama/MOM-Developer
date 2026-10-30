import { execSync } from 'child_process';

function az(args, opts = {}) {
  const subscription = opts.subscription ? `--subscription ${opts.subscription}` : '';
  const rg = opts.resourceGroup ? `--resource-group "${opts.resourceGroup}"` : '';
  const cmd = `az ${args} ${rg} ${subscription}`.trim();
  try {
    const out = execSync(cmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    return out.trim() ? JSON.parse(out) : null;
  } catch (e) {
    const errMsg = e.stderr ? e.stderr.toString() : e.message;
    throw new Error(`Azure CLI failed: ${cmd}\n${errMsg}`);
  }
}

export async function vmStatus(name, resourceGroup, subscription) {
  const vm = az(`vm show --name "${name}" --resource-group "${resourceGroup || 'rg-mom-dev-vm'}" --show-details --output json`, { subscription });
  const powerState = vm.instanceView?.statuses?.find(s => s.code.startsWith('PowerState/'))?.code || 'unknown';
  const ip = vm.publicIps?.[0] || '—';
  console.log(`\nVM: ${name}`);
  console.log(`  Resource Group: ${resourceGroup || 'rg-mom-dev-vm'}`);
  console.log(`  Power State: ${powerState.replace('PowerState/', '')}`);
  console.log(`  Public IP: ${ip}`);
  console.log(`  Size: ${vm.hardwareProfile.vmSize}`);
  console.log(`  Location: ${vm.location}\n`);
}

export async function vmStart(name, resourceGroup, subscription) {
  console.log(`Starting VM "${name}"...`);
  az(`vm start --name "${name}" --resource-group "${resourceGroup || 'rg-mom-dev-vm'}" --output json`, { subscription });
  console.log(`✓ VM "${name}" started\n`);
}

export async function vmStop(name, resourceGroup, subscription) {
  console.log(`Stopping VM "${name}"...`);
  az(`vm deallocate --name "${name}" --resource-group "${resourceGroup || 'rg-mom-dev-vm'}" --output json`, { subscription });
  console.log(`✓ VM "${name}" deallocated\n`);
}

export async function vmRestart(name, resourceGroup, subscription) {
  console.log(`Restarting VM "${name}"...`);
  az(`vm restart --name "${name}" --resource-group "${resourceGroup || 'rg-mom-dev-vm'}" --output json`, { subscription });
  console.log(`✓ VM "${name}" restarted\n`);
}