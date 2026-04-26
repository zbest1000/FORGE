# FORGE — Installation guide

FORGE is a Node 20+ Fastify server with a static SPA client built by
Vite. It runs on the four installation targets it was designed for:

- [Linux server](#linux-server)
- [macOS server](#macos-server)
- [Windows server](#windows-server)
- [Container / cloud](#container--cloud)

A full feature description is in `README.md` and `docs/SERVER.md`. The
licensing model is documented in `docs/LICENSING.md`. The release flow
that produces these archives is documented in `docs/RELEASE.md`.

---

## Linux server

Tested on Ubuntu 22.04 LTS, Ubuntu 24.04 LTS, RHEL 9, and Debian 12.

### Prerequisites

- Node.js **20.x or 22.x** (LTS).
- `tini` (only for systemd-supervised PID-1 isolation; optional).
- Sufficient privileges to bind the listen port (default 3000).

### From the release archive

```bash
# Replace VERSION with the release tag.
curl -L https://github.com/zbest1000/FORGE/releases/download/vVERSION/forge-VERSION-linux-x64.tar.gz \
  | tar -xz
cd forge-VERSION-linux-x64

# Verify the archive
sha256sum -c forge-VERSION-linux-x64.tar.gz.sha256

# First boot — env vars + seed.
export FORGE_JWT_SECRET="$(openssl rand -hex 32)"
export FORGE_TENANT_KEY="$(openssl rand -hex 32)"
export FORGE_DATA_DIR=/var/lib/forge
export FORGE_CORS_ORIGIN=https://forge.example.com

mkdir -p "$FORGE_DATA_DIR"
node server/seed.js
./start.sh
```

### As a systemd service

```ini
# /etc/systemd/system/forge.service
[Unit]
Description=FORGE
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=forge
Group=forge
WorkingDirectory=/opt/forge
EnvironmentFile=/etc/forge/forge.env
ExecStart=/usr/bin/node /opt/forge/server/main.js
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/forge
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
```

```bash
# /etc/forge/forge.env  (chmod 600 root:forge)
FORGE_JWT_SECRET=…             # 32+ chars
FORGE_TENANT_KEY=…             # 32+ chars
FORGE_DATA_DIR=/var/lib/forge
FORGE_CORS_ORIGIN=https://forge.example.com
FORGE_LICENSE=forge1.…
NODE_ENV=production
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now forge
sudo systemctl status forge
journalctl -u forge -f
```

### Reverse proxy (nginx)

```nginx
server {
  listen 443 ssl http2;
  server_name forge.example.com;

  ssl_certificate     /etc/letsencrypt/live/forge.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/forge.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;     # SSE
    proxy_read_timeout 1h;
  }
}
```

---

## macOS server

Tested on macOS 13 (Intel) and macOS 14+ (Apple Silicon). Releases ship
both `macos-x64` and `macos-arm64` archives — pick the one matching the
host architecture.

```bash
# Install Node 20 (Homebrew)
brew install node@20
echo 'export PATH="/opt/homebrew/opt/node@20/bin:$PATH"' >> ~/.zshrc

# Download + verify
curl -LO https://github.com/zbest1000/FORGE/releases/download/vVERSION/forge-VERSION-macos-arm64.tar.gz
shasum -a 256 -c forge-VERSION-macos-arm64.tar.gz.sha256
tar -xzf forge-VERSION-macos-arm64.tar.gz
cd forge-VERSION-macos-arm64

# Run interactively
export FORGE_JWT_SECRET="$(openssl rand -hex 32)"
export FORGE_TENANT_KEY="$(openssl rand -hex 32)"
./start.sh
```

### As a launchd service

```xml
<!-- ~/Library/LaunchAgents/local.forge.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.forge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/Shared/forge/server/main.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>FORGE_JWT_SECRET</key><string>…</string>
    <key>FORGE_TENANT_KEY</key><string>…</string>
    <key>FORGE_DATA_DIR</key><string>/Users/Shared/forge/data</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>WorkingDirectory</key><string>/Users/Shared/forge</string>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/Users/Shared/forge/logs/out.log</string>
  <key>StandardErrorPath</key><string>/Users/Shared/forge/logs/err.log</string>
</dict></plist>
```

```bash
launchctl load   ~/Library/LaunchAgents/local.forge.plist
launchctl start  local.forge
launchctl unload ~/Library/LaunchAgents/local.forge.plist
```

---

## Windows server

Tested on Windows Server 2019, 2022, and Windows 11.

### Prerequisites

- Node.js **20.x or 22.x** LTS (the official MSI installer adds Node to
  `PATH` and registers it as a system component).
- PowerShell 5.1+ (built-in) or PowerShell 7+.
- An empty data directory writable by the FORGE service account.

### Installation

```powershell
# 1. Download and verify
Invoke-WebRequest `
  -Uri "https://github.com/zbest1000/FORGE/releases/download/vVERSION/forge-VERSION-windows-x64.zip" `
  -OutFile "forge.zip"

(Get-FileHash forge.zip -Algorithm SHA256).Hash
# Compare against the .sha256 manifest from the release page.

Expand-Archive -Path forge.zip -DestinationPath C:\forge
Set-Location C:\forge\forge-VERSION-windows-x64
```

Set environment variables persistently (run as Administrator):

```powershell
[Environment]::SetEnvironmentVariable("FORGE_JWT_SECRET", "…32+ chars…", "Machine")
[Environment]::SetEnvironmentVariable("FORGE_TENANT_KEY", "…32+ chars…", "Machine")
[Environment]::SetEnvironmentVariable("FORGE_DATA_DIR",   "C:\forge\data", "Machine")
[Environment]::SetEnvironmentVariable("NODE_ENV",         "production", "Machine")
```

### Run interactively

```powershell
# From an elevated PowerShell window
.\start.cmd
```

### Run as a Windows Service

The cleanest path is the [WinSW](https://github.com/winsw/winsw)
service shim — a small standalone .exe that supervises a child
process. Drop the following next to `WinSW.exe` (downloaded from the
WinSW releases page) and rename it to `forge-service.xml`:

```xml
<service>
  <id>forge</id>
  <name>FORGE</name>
  <description>FORGE engineering collaboration platform</description>
  <executable>C:\Program Files\nodejs\node.exe</executable>
  <arguments>C:\forge\forge-VERSION-windows-x64\server\main.js</arguments>
  <workingdirectory>C:\forge\forge-VERSION-windows-x64</workingdirectory>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold></log>
  <onfailure action="restart" delay="2 sec"/>
  <env name="NODE_ENV" value="production"/>
  <env name="FORGE_DATA_DIR" value="C:\forge\data"/>
  <!-- Prefer a Windows credential store / Group Policy for secrets;
       hard-coded examples shown only for clarity. -->
  <env name="FORGE_JWT_SECRET" value="…"/>
  <env name="FORGE_TENANT_KEY" value="…"/>
</service>
```

```powershell
.\WinSW.exe install   forge-service.xml
.\WinSW.exe start     forge-service.xml
.\WinSW.exe status    forge-service.xml
```

### Firewall

```powershell
New-NetFirewallRule -DisplayName "FORGE" `
  -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
```

### Reverse proxy (IIS, ARR)

If IIS is the public-facing edge, install Application Request Routing
+ URL Rewrite and forward `/` → `http://localhost:3000` with
`Disable Response Buffering = true` (so SSE works) and `Time-out =
3600` (so long-running streams don't get killed).

---

## Container / cloud

The `Dockerfile` produces an ~80 MB image with `tini` as PID 1, runs
as the `node` user, and exposes a `/api/health` HEALTHCHECK.

### Single host (Docker)

```bash
docker run -d --name forge \
  -p 3000:3000 \
  -v forge-data:/app/data \
  -e FORGE_JWT_SECRET="$(openssl rand -hex 32)" \
  -e FORGE_TENANT_KEY="$(openssl rand -hex 32)" \
  -e FORGE_CORS_ORIGIN="https://forge.example.com" \
  -e FORGE_LICENSE="forge1.…" \
  ghcr.io/zbest1000/forge:VERSION
```

Verify the image signature before deployment:

```bash
cosign verify ghcr.io/zbest1000/forge:VERSION \
  --certificate-identity-regexp 'https://github\.com/zbest1000/FORGE/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

### docker-compose

```yaml
services:
  forge:
    image: ghcr.io/zbest1000/forge:VERSION
    restart: unless-stopped
    ports: ["3000:3000"]
    volumes: ["forge-data:/app/data"]
    environment:
      FORGE_JWT_SECRET: "${FORGE_JWT_SECRET}"
      FORGE_TENANT_KEY: "${FORGE_TENANT_KEY}"
      FORGE_CORS_ORIGIN: "${FORGE_CORS_ORIGIN}"
      FORGE_LICENSE:    "${FORGE_LICENSE}"
      NODE_ENV: "production"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>r.ok?process.exit(0):process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
volumes:
  forge-data:
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: forge
spec:
  replicas: 1                     # SQLite + in-process bridges = single replica today
  strategy: { type: Recreate }
  selector: { matchLabels: { app: forge } }
  template:
    metadata: { labels: { app: forge } }
    spec:
      containers:
        - name: forge
          image: ghcr.io/zbest1000/forge:VERSION
          ports: [{ containerPort: 3000 }]
          envFrom:
            - secretRef:    { name: forge-secrets }
            - configMapRef: { name: forge-env }
          readinessProbe:
            httpGet: { path: /api/health, port: 3000 }
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: /api/health, port: 3000 }
            initialDelaySeconds: 10
            periodSeconds: 15
          volumeMounts:
            - name: data
              mountPath: /app/data
          securityContext:
            runAsNonRoot: true
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities: { drop: ["ALL"] }
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: forge-data }
---
apiVersion: v1
kind: Secret
metadata: { name: forge-secrets }
type: Opaque
stringData:
  FORGE_JWT_SECRET: "…32+ chars…"
  FORGE_TENANT_KEY: "…32+ chars…"
  FORGE_LICENSE:    "forge1.…"
---
apiVersion: v1
kind: ConfigMap
metadata: { name: forge-env }
data:
  FORGE_CORS_ORIGIN: "https://forge.example.com"
  NODE_ENV: "production"
```

Single-replica today is intentional: SQLite + in-process MQTT/OPC UA
bridges are the persistence/messaging layers. The HA story is tracked
in the **distributed deployment profile** (`docker-compose.yml`
`distributed` profile + `ops.ha` license feature) and uses Postgres /
NATS / replicated workers; see `docs/SERVER.md`.

---

## Post-install checklist

1. Sign in as `admin@forge.local` (default seed) and **rotate the
   password** immediately.
2. Install your license token (Admin → License). Verify the banner shows
   the expected tier and customer.
3. Set `FORGE_CORS_ORIGIN` to your real origin (the strict-mode config
   loader refuses the `*` wildcard in production).
4. Provision an SSL/TLS reverse proxy. The server itself only listens
   plain HTTP — TLS termination is the proxy's job.
5. Configure backups: `npm run backup` or `node server/backup.js backup`
   produces a snapshot under `$FORGE_DATA_DIR/backups/`.
6. Run `npm test` (or just `node --test test/*.test.js`) on the install
   host once to confirm the binding architecture is healthy
   (`better-sqlite3` is platform-specific).
