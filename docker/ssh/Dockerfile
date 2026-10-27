# Bastion for testing 5db's SSH tunnels. Test credentials only.
FROM alpine:3.20
RUN apk add --no-cache openssh \
 && ssh-keygen -A \
 && adduser -D -s /bin/sh tunnel \
 && echo "tunnel:tunnel" | chpasswd \
 && mkdir -p /home/tunnel/.ssh \
 && sed -i 's/^#\?AllowTcpForwarding.*/AllowTcpForwarding yes/; s/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
 && echo "AllowTcpForwarding yes" >> /etc/ssh/sshd_config
COPY test_ed25519.pub /home/tunnel/.ssh/authorized_keys
RUN chown -R tunnel:tunnel /home/tunnel/.ssh && chmod 700 /home/tunnel/.ssh && chmod 600 /home/tunnel/.ssh/authorized_keys
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
