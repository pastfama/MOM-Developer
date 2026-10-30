import { execSync } from 'child_process';

function az(args, opts = {}) {
  const subscription = opts.subscription ? `--subscription ${opts.subscription}` : '';
  const cmd = `az ${args} ${subscription}`.trim();
  try {
    const out = execSync(cmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(out);
  } catch (e) {
    const errMsg = e.stderr ? e.stderr.toString() : e.message;
    throw new Error(`Azure CLI failed: ${cmd}\n${errMsg}`);
  }
}

export async function rgList(subscription) {
  const groups = az('group list --output json', { subscription });
  console.log('\nResource Groups:');
  console.log('─────────────────────────────────────────────────────────────');
  for (const g of groups) {
    console.log(`  ${g.name.padEnd(30)} ${g.location.padEnd(12)} ${g.provisioningState}`);
  }
  console.log(`\nTotal: ${groups.length} resource group(s)\n`);
}

export async function rgCreate(name, location, subscription) {
  console.log(`Creating resource group "${name}" in ${location}...`);
  const result = az(`group create --name "${name}" --location "${location}" --output json`, { subscription });
  console.log(`✓ Created: ${result.name} (${result.id})\n`);
}

export async function rgDelete(name, subscription) {
  console.log(`Deleting resource group "${name}" and all resources...`);
  az(`group delete --name "${name}" --yes --output json`, { subscription });
  console.log(`✓ Deleted: ${name}\n`);
}