FROM nginxinc/nginx-unprivileged:1.27-alpine
# The image renders /etc/nginx/templates/*.template into /etc/nginx/conf.d/ at start.
COPY templates/ /etc/nginx/templates/
EXPOSE 8080
