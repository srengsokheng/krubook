#!/usr/bin/env bash
# Probe TLS protocol and cipher support of a host. Usage: tlscheck.sh host
h=$1
probe() { if echo | timeout 8 openssl s_client -connect "$h:443" -servername "$h" "$@" </dev/null >/tmp/tls.out 2>&1 && grep -q "Cipher is" /tmp/tls.out && ! grep -q "Cipher is (NONE)" /tmp/tls.out; then echo "ACCEPTED  $(grep -m1 -oE 'Protocol *: *\S+|New, \S+, Cipher is \S+' /tmp/tls.out | tr '\n' ' ')"; else echo "rejected"; fi; }
echo "TLS 1.0: $(probe -tls1 -cipher 'DEFAULT@SECLEVEL=0')"
echo "TLS 1.1: $(probe -tls1_1 -cipher 'DEFAULT@SECLEVEL=0')"
echo "TLS 1.2: $(probe -tls1_2)"
echo "TLS 1.3: $(probe -tls1_3)"
for c in ECDHE-ECDSA-AES128-SHA ECDHE-ECDSA-AES256-SHA384 ECDHE-RSA-AES128-SHA AES128-SHA AES256-GCM-SHA384; do echo "TLS 1.2 $c: $(probe -tls1_2 -cipher "$c@SECLEVEL=0")"; done
echo | openssl s_client -connect "$h:443" -servername "$h" 2>/dev/null | openssl x509 -noout -subject -issuer -enddate -ext subjectAltName 2>/dev/null | tr '\n' ' '; echo
echo | openssl s_client -connect "$h:443" -servername "$h" 2>/dev/null | grep -E "Verify return code|Peer signature type|Server Temp Key"
