#!/bin/bash
# Example installer. Review paths and the service user before use.
# Does not install the Bark timer, does not copy secrets, and binds the app to 127.0.0.1.
# Refuses to run until you opt in: ELYSIUM_INSTALL=1 bash deploy_vps.sh
set -euo pipefail
if [ "${ELYSIUM_INSTALL:-}" != "1" ]; then
  echo "Refusing to install. This script replaces /opt/elysium-lp and restarts elysium-lp.service."
  echo "It does not install a Bark timer or copy an EnvironmentFile."
  echo "Review the script, then re-run with ELYSIUM_INSTALL=1."
  exit 1
fi
if [ ! -f /tmp/elysium-lp.zip ]; then
  echo "Expected /tmp/elysium-lp.zip built from this repository. Do not unpack a machine backup."
  exit 1
fi
apt-get -qq -y install unzip >/dev/null 2>&1 || true
rm -rf /opt/elysium-lp
mkdir -p /opt/elysium-lp
unzip -oq /tmp/elysium-lp.zip -d /opt/elysium-lp
if id ubuntu >/dev/null 2>&1; then
  SERVICE_USER=ubuntu
else
  SERVICE_USER="$(id -un)"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" /opt/elysium-lp
cat > /etc/systemd/system/elysium-lp.service <<EOF
[Unit]
Description=Elysium LP (KNTQ/HYPE Uniswap V4)
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=/opt/elysium-lp
ExecStart=/usr/bin/python3 /opt/elysium-lp/server.py --no-open --host 127.0.0.1 --port 8097
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable elysium-lp >/dev/null
systemctl restart elysium-lp
sleep 2
systemctl is-active elysium-lp
curl -sS http://127.0.0.1:8097/elysium-lp/api/status | head -c 500
echo
echo "Bark report timer was not installed. See deploy/elysium-lp-report.*.example and keep the device key outside git."
