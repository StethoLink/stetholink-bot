FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY --chown=node:node . .
RUN chown node:node /app
ENV NEXT_TELEMETRY_DISABLED=1
USER node
EXPOSE 3000
CMD ["npm", "run", "dev", "--", "--hostname", "0.0.0.0"]
