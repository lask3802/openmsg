#!/bin/sh
# Installs the relay on a Debian machine. create-lxc.sh runs this inside the
# container, and it also works on a plain Debian host.
#
# Usage: setup.sh <address> [port] [git-ref]
# <address> is the IP address that the gateways use. It goes in the certificate.
set -eu

ADDRESS=${1:?usage: setup.sh <address> [port] [git-ref]}
PORT=${2:-7800}
REF=${3:-main}
REPO=${OPENMSG_REPO:-https://github.com/marciob/openmsg.git}
# Debian 13 ships Node 20, and openmsg needs Node 22.
NODE_VERSION=${NODE_VERSION:-22.16.0}

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git openssl xz-utils >/dev/null

if [ "$(/usr/local/bin/node --version 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
  name="node-v$NODE_VERSION-linux-x64"
  work=$(mktemp -d)
  curl -fsSL -o "$work/$name.tar.xz" "https://nodejs.org/dist/v$NODE_VERSION/$name.tar.xz"
  curl -fsSL -o "$work/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  (cd "$work" && grep " $name.tar.xz\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$work/$name.tar.xz" -C /usr/local --strip-components=1 \
    "$name/bin/node"
  rm -rf "$work"
fi

id openmsg >/dev/null 2>&1 || useradd --system --home-dir /var/lib/openmsg-relay --shell /usr/sbin/nologin openmsg

if [ -d /opt/openmsg/.git ]; then
  git -C /opt/openmsg fetch --quiet origin
else
  git clone --quiet "$REPO" /opt/openmsg
fi
git -C /opt/openmsg checkout --quiet --detach "origin/$REF" 2>/dev/null || git -C /opt/openmsg checkout --quiet --detach "$REF"

install -d -o openmsg -g openmsg -m 700 /var/lib/openmsg-relay
install -d -o root -g openmsg -m 750 /etc/openmsg-relay

# A self-signed certificate. Each gateway pins it with `relay use --ca`, so no
# public authority is in the path. An existing certificate stays, because every
# gateway pins it.
if [ ! -f /etc/openmsg-relay/relay.crt ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
    -keyout /etc/openmsg-relay/relay.key -out /etc/openmsg-relay/relay.crt \
    -subj "/CN=openmsg-relay" -addext "subjectAltName=IP:$ADDRESS" 2>/dev/null
  chown root:openmsg /etc/openmsg-relay/relay.key /etc/openmsg-relay/relay.crt
  chmod 640 /etc/openmsg-relay/relay.key
  chmod 644 /etc/openmsg-relay/relay.crt
fi

printf 'RELAY_HOST=%s\nRELAY_PORT=%s\n' "$ADDRESS" "$PORT" >/etc/openmsg-relay.env
install -m 644 /opt/openmsg/deploy/relay/openmsg-relay.service /etc/systemd/system/openmsg-relay.service
systemctl daemon-reload
systemctl enable --now openmsg-relay >/dev/null
systemctl restart openmsg-relay

echo "relay: wss://$ADDRESS:$PORT"
echo "certificate: /etc/openmsg-relay/relay.crt"
