# Azure Functions v4 Node.js 20 base image
FROM mcr.microsoft.com/azure-functions/node:4-node20

ENV AzureWebJobsScriptRoot=/home/site/wwwroot \
    AzureFunctionsJobHost__Logging__Console__IsEnabled=true

WORKDIR /home/site/wwwroot

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci --production

# Copy source and build
COPY tsconfig.json host.json ./
COPY src/ ./src/
RUN npm install typescript --save-dev && npx tsc && npm prune --production
