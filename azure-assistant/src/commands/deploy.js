import { execSync } from 'child_process';
import * as path from 'path';

export async function deploy(source, user, host, targetDir, opts = {}) {
  const key = opts.key.replace('~', process.env.HOME || process.env.USERPROFILE);
  const port = opts.port || 22;

  console.log(`Deploying "${source}" → ${user}@${host}:${targetDir}`);
  console.log(`SSH key: ${key}, Port: ${port}`);

  // 1. Create target directory on VM
  const mkdirCmd = `ssh -i "${key}" -p ${port} -o StrictHostKeyChecking=no ${user}@${host} "mkdir -p ${targetDir}"`;
  execSync(mkdirCmd, { stdio: 'inherit' });

  // 2. rsync files to VM
  const rsyncCmd = `rsync -avz -e "ssh -i ${key} -p ${port} -o StrictHostKeyChecking=no" --exclude='.git' --exclude='.data' --exclude='node_modules' ${source}/ ${user}@${host}:${targetDir}/`;
  console.log('\nSyncing files...');
  execSync(rsyncCmd, { stdio: 'inherit' });

  // 3. Run post-deploy command if provided
  if (opts.command) {
    console.log(`\nRunning: ${opts.command}`);
    const cmd = `ssh -i "${key}" -p ${port} -o StrictHostKeyChecking=no ${user}@${host} "${opts.command}"`;
    execSync(cmd, { stdio: 'inherit' });
    console.log(`✓ Post-deploy command completed\n`);
  } else {
    console.log(`\n✓ Deployed to ${user}@${host}:${targetDir}\n`);
  }
}