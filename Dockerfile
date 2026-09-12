FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY app/ /srv/

EXPOSE 80 443 443/udp
