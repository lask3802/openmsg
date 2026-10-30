#!/bin/sh
# Creates a small Proxmox container for the relay. Run it on the Proxmox host,
# from the directory that holds setup.sh.
#
# Usage: create-lxc.sh <vmid> <address> <gateway> [git-ref]
# Example: create-lxc.sh 209 192.168.1.241 192.168.1.1 main
#
# The ref must hold deploy/relay. OPENMSG_REPO names another repository, PREFIX
# names the network prefix (24 by default), and NODE_VERSION reaches setup.sh.
#
# The relay carries sealed bytes, and it learns who writes to whom. Keep it on a
# private network. Do not forward its port to the internet.
set -eu

VMID=${1:?usage: create-lxc.sh <vmid> <address> <gateway> [git-ref]}
ADDRESS=${2:?usage: create-lxc.sh <vmid> <address> <gateway> [git-ref]}
GATEWAY=${3:?usage: create-lxc.sh <vmid> <address> <gateway> [git-ref]}
REF=${4:-main}
HOST_NAME=${HOST_NAME:-openmsg-relay}
TEMPLATE=${TEMPLATE:-local:vztmpl/debian-13-standard_13.6-1_amd64.tar.zst}
STORAGE=${STORAGE:-local-lvm}
BRIDGE=${BRIDGE:-vmbr0}
NAMESERVER=${NAMESERVER:-1.1.1.1}
PREFIX=${PREFIX:-24}

# A run that fails leaves no half-built container, so the same id works again.
# Only a container that this run made goes away. When `pct create` fails, the id
# can belong to another operator.
built=
remove_failed() {
  code=$?
  if [ "$code" -ne 0 ] && [ -n "$built" ]; then
    echo "the setup failed, so the container $VMID goes away" >&2
    pct stop "$VMID" >/dev/null 2>&1 || true
    pct destroy "$VMID" --purge >/dev/null 2>&1 || true
  fi
}
trap remove_failed EXIT

if pct status "$VMID" >/dev/null 2>&1 || qm status "$VMID" >/dev/null 2>&1; then
  echo "the id $VMID is in use" >&2
  exit 1
fi
if ping -c 1 -W 1 "$ADDRESS" >/dev/null 2>&1; then
  echo "the address $ADDRESS answers. Choose a free address" >&2
  exit 1
fi

pct create "$VMID" "$TEMPLATE" \
  --hostname "$HOST_NAME" \
  --unprivileged 1 --features nesting=1 --onboot 1 \
  --cores 1 --memory 512 --swap 0 \
  --rootfs "$STORAGE:4" \
  --net0 "name=eth0,bridge=$BRIDGE,ip=$ADDRESS/$PREFIX,gw=$GATEWAY,type=veth" \
  --nameserver "$NAMESERVER"
built=yes
pct start "$VMID"

# The network of a new container needs a moment.
tries=0
until pct exec "$VMID" -- getent hosts deb.debian.org >/dev/null 2>&1; do
  tries=$((tries + 1))
  [ "$tries" -lt 30 ] || { echo "the container has no network" >&2; exit 1; }
  sleep 1
done

pct push "$VMID" setup.sh /root/setup.sh --perms 755
pct exec "$VMID" -- env OPENMSG_REPO="${OPENMSG_REPO:-https://github.com/marciob/openmsg.git}" \
  NODE_VERSION="${NODE_VERSION:-22.16.0}" \
  /root/setup.sh "$ADDRESS" 7800 "$REF"

mkdir -p /root/openmsg-relay
pct pull "$VMID" /etc/openmsg-relay/relay.crt "/root/openmsg-relay/relay-$VMID.crt"
built=
echo "Give this certificate to each gateway: /root/openmsg-relay/relay-$VMID.crt"
echo "Each gateway runs: openmsg relay use wss://$ADDRESS:7800 --ca <file>"
