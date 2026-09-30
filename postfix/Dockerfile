# Postfix in a container: the SMTP server in front of PhoneMail when there's no mail server on
# the machine (a laptop, a demo, a fresh server). The same job a server's own Postfix does:
#   in:  mail for our domains arrives on port 25, each address is checked with the mail
#        service first, then the email is handed to it on mailsvc:2525
#   out: the mail service hands outside email here; Postfix delivers it (or relays it through
#        POSTFIX_RELAYHOST, e.g. a mail provider, where port 25 is blocked).
# Settings come from the environment at start (entrypoint.sh).
FROM alpine:3.20
RUN apk add --no-cache postfix cyrus-sasl cyrus-sasl-login ca-certificates tzdata \
 && mkdir -p /var/spool/postfix
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 25
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s CMD postfix status >/dev/null 2>&1 || exit 1
ENTRYPOINT ["/entrypoint.sh"]
