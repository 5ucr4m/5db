#!/bin/sh
# Generates a throwaway CA and server certificate so the test Postgres can
# serve TLS. Kept out of git; regenerated on demand, like the bastion key.
set -e
cd "$(dirname "$0")/../docker/pg"
[ -f server.key ] && [ -f ca.crt ] && exit 0

cat > ca.cnf <<'CNF'
[req]
distinguished_name = dn
x509_extensions    = ext
prompt             = no
[dn]
CN = 5db test CA
[ext]
basicConstraints = critical,CA:TRUE
keyUsage         = critical,keyCertSign,cRLSign
CNF

cat > server.cnf <<'CNF'
[req]
distinguished_name = dn
req_extensions     = ext
prompt             = no
[dn]
CN = localhost
[ext]
basicConstraints = CA:FALSE
keyUsage         = digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName   = DNS:localhost,DNS:postgres,IP:127.0.0.1
CNF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -sha256 \
  -keyout ca.key -out ca.crt -config ca.cnf 2>/dev/null
openssl req -newkey rsa:2048 -nodes -sha256 \
  -keyout server.key -out server.csr -config server.cnf 2>/dev/null
# Apple's Security framework rejects a TLS server certificate valid for more
# than 398 days, so the leaf is short-lived even though the CA is not.
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 397 -sha256 -extfile server.cnf -extensions ext -out server.crt 2>/dev/null
rm -f server.csr ca.cnf server.cnf ca.srl
chmod 600 server.key ca.key
echo "generated docker/pg/{ca.crt,server.crt,server.key} (test only)"
