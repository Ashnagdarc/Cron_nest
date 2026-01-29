# Use Node.js 18 Alpine for smaller image size
FROM node:18-alpine
# Install curl for healthcheck
RUN apk add --no-cache curl
# Set working directory
WORKDIR /app
# Copy package files
COPY package*.json ./
# Install dependencies
RUN npm ci --only=production
# Copy source code
COPY index.js ./
# Use secrets from runtime environment, not build args
# Build args are removed to avoid secrets in image history
# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
  adduser -S nestcron -u 1001
# Change ownership of app directory
RUN chown -R nestcron:nodejs /app
USER nestcron
# Expose port
EXPOSE 3000
# Health check via HTTP endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
# Start the application
CMD ["npm", "start"]
