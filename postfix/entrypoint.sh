#!/bin/sh
# Writes Postfix's settings from the environment, then runs it in the foreground (logs to stdout).
set -eu

DOMAIN="${MAIL_DOMAIN:?MAIL_DOMAIN is required}"
HOSTNAME_="${POSTFIX_HOSTNAME:-mail.$DOMAIN}"
MAILSVC="${MAILSVC_SMTP:-mailsvc:2525}"
# Who may send outside mail through us: this container's own Docker network (where the mail
# service is), found at start unless DOCKER_SUBNET names it.
SUBNET="${DOCKER_SUBNET:-}"
if [ -z "$SUBNET" ]; then
  CIDR=$(ip -o -f inet addr show eth0 | awk '{print $4}' | head -1)
  eval "$(ipcalc -n -p "$CIDR")"
  SUBNET="$NETWORK/$PREFIX"
fi
NETWORKS="127.0.0.0/8 $SUBNET"
# Our domains: the main one plus earlier ones whose number addresses still arrive.
DOMAINS="$DOMAIN"
for d in $(echo "${MAIL_LEGACY_DOMAINS:-}" | tr ',' ' '); do DOMAINS="$DOMAINS $d"; done

# Mail for our domains goes to the PhoneMail mail service.
: > /etc/postfix/transport
for d in $DOMAINS; do echo "$d smtp:[${MAILSVC%:*}]:${MAILSVC##*:}" >> /etc/postfix/transport; done
postmap lmdb:/etc/postfix/transport
# Addresses on our domains are checked with the mail service before anything else, whoever sends
# (as a server's own Postfix should): mail for unknown numbers is refused at the door, never accepted then bounced.
: > /etc/postfix/verify_domains
for d in $DOMAINS; do echo "$d phonemail_verify" >> /etc/postfix/verify_domains; done
postmap lmdb:/etc/postfix/verify_domains

postconf -e \
  "myhostname = $HOSTNAME_" \
  "mydomain = $DOMAIN" \
  "myorigin = \$mydomain" \
  "mydestination =" \
  "local_recipient_maps =" \
  "relay_domains = $(echo $DOMAINS | tr ' ' ',')" \
  "transport_maps = lmdb:/etc/postfix/transport" \
  "mynetworks = $NETWORKS" \
  "inet_interfaces = all" \
  "inet_protocols = ipv4" \
  "message_size_limit = 26214400" \
  "smtpd_banner = \$myhostname ESMTP" \
  "smtpd_helo_required = yes" \
  "disable_vrfy_command = yes" \
  "smtpd_relay_restrictions = permit_mynetworks, reject_unauth_destination" \
  "smtpd_restriction_classes = phonemail_verify" \
  "phonemail_verify = reject_unverified_recipient" \
  "smtpd_recipient_restrictions = check_recipient_access lmdb:/etc/postfix/verify_domains, permit_mynetworks, reject_unauth_destination" \
  "unverified_recipient_reject_code = 550" \
  "address_verify_poll_count = 5" \
  "smtp_tls_security_level = may" \
  "smtp_tls_CAfile = /etc/ssl/certs/ca-certificates.crt" \
  "maillog_file = /dev/stdout" \
  "compatibility_level = 3.6"

# Where outside mail goes: straight to the recipient's server, or through a relay (smarthost).
if [ -n "${POSTFIX_RELAYHOST:-}" ]; then
  postconf -e "relayhost = $POSTFIX_RELAYHOST"
  if [ -n "${POSTFIX_RELAY_USER:-}" ]; then
    echo "$POSTFIX_RELAYHOST $POSTFIX_RELAY_USER:${POSTFIX_RELAY_PASSWORD:-}" > /etc/postfix/sasl_passwd
    chmod 600 /etc/postfix/sasl_passwd
    postmap lmdb:/etc/postfix/sasl_passwd
    postconf -e "smtp_sasl_auth_enable = yes" "smtp_sasl_password_maps = lmdb:/etc/postfix/sasl_passwd" \
      "smtp_sasl_security_options = noanonymous" "smtp_tls_security_level = encrypt"
  fi
else
  postconf -e "relayhost ="
fi

newaliases 2>/dev/null || true
echo "postfix: $HOSTNAME_ (trusting $SUBNET), mail for $DOMAINS -> $MAILSVC, outside mail $( [ -n "${POSTFIX_RELAYHOST:-}" ] && echo "via $POSTFIX_RELAYHOST" || echo "delivered directly" )"
exec postfix start-fg
