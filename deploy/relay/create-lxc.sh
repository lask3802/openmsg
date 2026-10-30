#!/bin/sh
# Creates a small Proxmox container for the relay. Run it on the Proxmox host,
# from the directory that holds setup.sh.
#
# Usage: create-lxc.sh <vmid> <address> <gateway> [git-ref]
# Example: create-lxc.sh 209 192.168.1.241 192.168.1.1 main
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
  --net0 "name=eth0,bridge=$BRIDGE,ip=$ADDRESS/24,gw=$GATEWAY,type=veth" \
  --nameserver "$NAMESERVER"
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
  /root/setup.sh "$ADDRESS" 7800 "$REF"

mkdir -p /root/openmsg-relay
pct pull "$VMID" /etc/openmsg-relay/relay.crt "/root/openmsg-relay/relay-$VMID.crt"
echo "Give this certificate to each gateway: /root/openmsg-relay/relay-$VMID.crt"
echo "Each gateway runs: openmsg relay use wss://$ADDRESS:7800 --ca <file>"
