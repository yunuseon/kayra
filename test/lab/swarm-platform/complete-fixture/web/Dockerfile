FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea
COPY fixture.mjs /fixture.mjs
COPY migration.mjs /migration.mjs
COPY health.sh /health.sh
USER node
CMD ["node", "/fixture.mjs"]
