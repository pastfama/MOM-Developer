# Azure Management Assistant

A CLI tool that actually manages Azure — create/delete resource groups, networking, DNS, VMs, and deploy code. No more "I can't do that."

## Install

```bash
cd azure-assistant
npm install
```

Make it executable (Linux/macOS):
```bash
chmod +x src/index.js
```

## Prerequisites

- Azure CLI installed (`az`)
- Logged in (`az login`)
- Appropriate RBAC (Contributor on subscription or resource groups)

---

## Usage

### Resource Groups

```bash
# List all RGs
node src/index.js rg:list

# Create an RG
node src/index.js rg:create rg-mom-network eastus

# Delete an RG (with confirmation)
node src/index.js rg:delete rg-mom-network

# Skip confirmation
node src/index.js rg:delete rg-mom-network --yes
```

### Networking (VNet + NSG + Public IP)

```bash
# Create full networking stack in an RG
node src/index.js net:create rg-mom-network mom-network eastus

# List networking in an RG
node src/index.js net:list rg-mom-network

# Delete networking stack
node src/index.js net:delete rg-mom-network mom-network
```

### DNS Records (fameshire.com zone)

```bash
# List A and CNAME records
node src/index.js dns:list fameshire.com -g fameshire

# Create A record: fameshire.com → 20.127.56.148
node src/index.js dns:a fameshire.com @ 20.127.56.148 -g fameshire

# Create A record: dev.fameshire.com → 20.127.56.148
node src/index.js dns:a fameshire.com dev 20.127.56.148 -g fameshire

# Delete a record
node src/index.js dns:delete fameshire.com dev -g fameshire
```

### VM Management

```bash
# Check VM status
node src/index.js vm:status mom-dev-vm -g RG-MOM-DEV-VM

# Start VM
node src/index.js vm:start mom-dev-vm -g RG-MOM-DEV-VM

# Stop (deallocate) VM
node src/index.js vm:stop mom-dev-vm -g RG-MOM-DEV-VM

# Restart VM
node src/index.js vm:restart mom-dev-vm -g RG-MOM-DEV-VM
```

### Deploy Code to VM

```bash
# Deploy local folder to VM via SSH, then restart service
node src/index.js deploy /home/user/mom-dev azureuser 20.127.56.148 \
  -k ~/.ssh/id_rsa \
  -c "sudo systemctl restart dev-agent"
```

---

## Examples: Full Workflow

```bash
# 1. Create everything from scratch
az login
node src/index.js rg:create rg-mom-network eastus
node src/index.js net:create rg-mom-network mom-network eastus

# 2. Point your domain at the new IP
node src/index.js dns:a fameshire.com @ 20.127.56.148 -g fameshire
node src/index.js dns:a fameshire.com dev 20.127.56.148 -g fameshire

# 3. Deploy your app
node src/index.js deploy ./dev-portal azureuser 20.127.56.148 \
  -c "sudo systemctl restart dev-agent"

# 4. Check it's running
node src/index.js vm:status mom-dev-vm -g RG-MOM-DEV-VM
```
