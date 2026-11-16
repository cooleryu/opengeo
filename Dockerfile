FROM node:24.5.0-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json next.config.mjs next-env.d.ts postcss.config.js tailwind.config.ts ./
COPY src ./src
COPY skills ./skills
COPY public ./public

RUN mkdir -p /app/data
RUN npm run build

FROM node:24.5.0-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4327
ENV HOSTNAME=127.0.0.1

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/skills ./skills
COPY --from=builder /app/data ./data

EXPOSE 4327

CMD ["node", "server.js"]
