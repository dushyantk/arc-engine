FROM clickhouse/clickhouse-server:24
# The only change from the stock image: bind to an address Fly's proxy can reach.
COPY listen.xml /etc/clickhouse-server/config.d/listen.xml
