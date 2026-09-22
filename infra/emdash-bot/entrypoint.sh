#!/bin/sh
# Container entrypoint. Trusts the Cloudflare outbound-interception CA cert
# (if present) before exec'ing the sandbox process.
#
# When the parent Sandbox class sets `interceptHttps = true` AND registers
# an outbound handler, Cloudflare writes an ephemeral per-container CA to
# /etc/cloudflare/certs/cloudflare-containers-ca.crt. Without trust, TLS
# clients inside the container fail handshakes against the intercepting
# proxy, so handlers never see traffic.
set -e

CA_SRC=/etc/cloudflare/certs/cloudflare-containers-ca.crt
CA_DST=/usr/local/share/ca-certificates/cloudflare-containers-ca.crt

if [ -f "$CA_SRC" ]; then
	cp "$CA_SRC" "$CA_DST"
	update-ca-certificates >/dev/null 2>&1 || true
	echo "[entrypoint] trusted Cloudflare containers CA"
else
	echo "[entrypoint] no Cloudflare containers CA at $CA_SRC; skipping"
fi

exec /container-server/sandbox "$@"
