#!/bin/sh
# Starts Smokescreen with the private/reserved ranges denied, plus the server's own public IPs
# from SELF_IPS (comma-separated), so a fetched page can't reach Dokploy, SyllaCal or the host.
#
# No --egress-acl-file on purpose: without an ACL Smokescreen allows every public host, which is
# what capture needs (any customer website). The protection we want is IP-based, and Smokescreen
# already refuses private ranges by default; the explicit --deny-range list below is belt and
# braces in case that default ever changes. (There's no role to check either: clients are our own
# worker on the private mkt network, so a role/ACL would add nothing.)
set -eu

set -- --listen-ip 0.0.0.0 --listen-port 4750 --timeout 20s "$@"

for range in \
  0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 \
  192.0.0.0/24 192.0.2.0/24 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4 \
  ::1/128 fc00::/7 fe80::/10 ff00::/8 64:ff9b::/96; do
  set -- "$@" --deny-range "$range"
done

old_ifs=$IFS
IFS=','
for ip in ${SELF_IPS:-}; do
  ip=$(printf '%s' "$ip" | tr -d ' ')
  [ -n "$ip" ] || continue
  case "$ip" in
    */*) cidr="$ip" ;;
    *:*) cidr="$ip/128" ;;
    *) cidr="$ip/32" ;;
  esac
  set -- "$@" --deny-range "$cidr"
done
IFS=$old_ifs

exec /usr/local/bin/smokescreen "$@"
