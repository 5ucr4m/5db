# Test Postgres that also serves TLS, so 5db's verify-ca / verify-full paths
# can be exercised. The certificates come from scripts/tls-certs.sh and are
# test-only; the key has to be owned by postgres or the server refuses to start.
FROM postgres:17-alpine
COPY server.crt /tls/server.crt
COPY server.key /tls/server.key
RUN chown postgres:postgres /tls/server.crt /tls/server.key \
 && chmod 600 /tls/server.key \
 && chmod 644 /tls/server.crt
