#!/usr/bin/env node
import { program } from 'commander';
import { rgCreate, rgDelete, rgList } from './commands/rg.js';
import { netCreate, netDelete, netList } from './commands/net.js';
import { dnsCreate, dnsDelete, dnsList } from './commands/dns.js';
import { vmStatus, vmStart, vmStop, vmRestart } from './commands/vm.js';
import { deploy } from './commands/deploy.js';

program
  .name('az-assistant')
  .description('Azure Management Assistant - create/delete RGs, manage networking, DNS, VMs, and deploy code')
  .version('1.0.0');

// ── Resource Groups ──
program
  .command('rg:list')
  .description('List all resource groups')
  .action(async () => {
    const subs = program.opts().subscription;
    await rgList(subs);
  });

program
  .command('rg:create <name> [location]')
  .description('Create a resource group')
  .option('-s, --subscription <id>', 'Subscription ID')
  .action(async (name, location, opts) => {
    await rgCreate(name, location || 'eastus', opts.subscription);
  });

program
  .command('rg:delete <name>')
  .description('Delete a resource group')
  .option('-y, --yes', 'Skip confirmation')
  .option('-s, --subscription <id>', 'Subscription ID')
  .action(async (name, opts) => {
    if (!opts.yes) {
      const { createPrompt } = await import('prompts');
      const response = await createPrompt({
        type: 'confirm',
        name: 'value',
        message: `Delete resource group "${name}" and ALL resources inside?`,
      });
      if (!response.value) {
        console.log('Aborted.');
        return;
      }
    }
    await rgDelete(name, opts.subscription);
  });

// ── Networking ──
program
  .command('net:list [rg]')
  .description('List networking resources in a resource group')
  .action(async (rg) => {
    await netList(rg);
  });

program
  .command('net:create <rg> <name> [location]')
  .description('Create VNet + NSG + Public IP in a resource group')
  .option('-s, --subscription <id>', 'Subscription ID')
  .action(async (rg, name, location, opts) => {
    await netCreate(rg, name, location || 'eastus', opts.subscription);
  });

program
  .command('net:delete <rg> <name>')
  .description('Delete networking resources (VNet, NSG, Public IP)')
  .option('-s, --subscription <id>', 'Subscription ID')
  .action(async (rg, name, opts) => {
    await netDelete(rg, name, opts.subscription);
  });

// ── DNS ──
program
  .command('dns:list <zone>')
  .description('List DNS records in a zone')
  .option('-g, --resource-group <rg>', 'Resource group containing the DNS zone')
  .action(async (zone, opts) => {
    await dnsList(zone, opts.resourceGroup);
  });

program
  .command('dns:a <zone> <name> <ip>')
  .description('Create or update an A record')
  .option('-g, --resource-group <rg>', 'Resource group containing the DNS zone')
  .action(async (zone, name, ip, opts) => {
    await dnsCreate(zone, name, 'A', ip, opts.resourceGroup);
  });

program
  .command('dns:delete <zone> <name>')
  .description('Delete a DNS record')
  .option('-g, --resource-group <rg>', 'Resource group containing the DNS zone')
  .option('-t, --type <type>', 'Record type (A, CNAME)', 'A')
  .action(async (zone, name, opts) => {
    await dnsDelete(zone, name, opts.type, opts.resourceGroup);
  });

// ── VM ──
program
  .command('vm:status <name> [rg]')
  .description('Check VM power state')
  .option('-s, --subscription <id>', 'Subscription ID')
  .action(async (name, rg, opts) => {
    await vmStatus(name, rg, opts.subscription);
  });

program
  .command('vm:start <name> [rg]')
  .description('Start a VM')
  .option('-s, --subscription <id>', 'Subscription ID')
  .action(async (name, rg, opts) => {
    await vmStart(name, rg, opts.subscription);
  });

program
  .command('vm:stop <name> [rg]')
  .description('Stop (deallocate) a VM')
  .option('-s, --subscription <id>', 'Subscription ID')
  .action(async (name, rg, opts) => {
    await vmStop(name, rg, opts.subscription);
  });

program
  .command('vm:restart <name> [rg]')
  .description('Restart a VM')
  .option('-s, --subscription <id>', 'Subscription ID')
  .action(async (name, rg, opts) => {
    await vmRestart(name, rg, opts.subscription);
  });

// ── Deploy ──
program
  .command('deploy <source> <vm-user> <vm-host> [target-dir]')
  .description('Deploy code to a VM via SSH and restart a service')
  .option('-k, --key <path>', 'SSH private key path', '~/.ssh/id_rsa')
  .option('-p, --port <n>', 'SSH port', '22')
  .option('-c, --command <cmd>', 'Command to run after deploy (e.g. systemctl restart dev-agent)')
  .action(async (source, user, host, targetDir, opts) => {
    await deploy(source, user, host, targetDir || '/opt/dev-agent/current', {
      key: opts.key,
      port: opts.port,
      command: opts.command,
    });
  });

program.parse();