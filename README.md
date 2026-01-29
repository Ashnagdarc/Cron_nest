# Push Notification Cron Service

A Node.js cron service that processes push notifications for the Nest by Eden Oasis platform. It handles notification queuing, delivery, rate limiting, and automatic reminders for equipment returns.

## Features

- 🔔 Web Push notification delivery with VAPID support
- 📅 Automatic daily reminders (overdue items, due soon, office closing, good morning)
- ⏱️ Rate limiting to prevent queue overflow
- 🛡️ Secure environment variable handling
- ❤️ Health check endpoint for monitoring
- 🛑 Graceful shutdown handling
- 📊 Configurable batch processing

## Requirements

- Node.js 18+ (20+ recommended for Supabase compatibility)
- Environment variables properly configured

## Setup

### 1. Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Required variables:
- `NEXT_PUBLIC_SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY` - Web Push VAPID public key
- `VAPID_PRIVATE_KEY` - Web Push VAPID private key

Optional variables:
- `VAPID_MAILTO` (default: `mailto:noreply@nestbyeden.app`) - VAPID mailto contact
- `PORT` (default: `3000`) - Health check server port
- `BATCH_LIMIT` (default: `10`) - Notifications to process per batch
- `RATE_LIMIT_MAX_QUEUE` (default: `1000`) - Maximum queue size before rate limiting
- `RATE_LIMIT_WINDOW` (default: `60000`) - Rate limit window in milliseconds
- `NODE_ENV` (default: `production`) - Environment (production/development)

### 2. Installation

```bash
npm install
```

### 3. Running Locally

```bash
npm start
```

The service will:
- Start cron jobs for push notification processing and daily notifications
- Listen for HTTP health checks on port 3000
- Output startup status to console

## Docker Deployment

The application includes a Dockerfile optimized for production:

```bash
docker build -t push-notification-cron .
docker run -d \
  -e NEXT_PUBLIC_SUPABASE_URL="your-url" \
  -e SUPABASE_SERVICE_ROLE_KEY="your-key" \
  -e NEXT_PUBLIC_VAPID_PUBLIC_KEY="your-public-key" \
  -e VAPID_PRIVATE_KEY="your-private-key" \
  -p 3000:3000 \
  push-notification-cron
```

### Important: Environment Variables in Container

- Never pass secrets as build arguments (they're stored in image history)
- Always pass secrets at **runtime** using `-e` flags or `.env` files mounted in the container
- Use your orchestration platform's secret management (e.g., Coolify, Docker Secrets, Kubernetes)

## API Endpoints

### Health Check
```bash
GET /health
```

Response:
```json
{
  "status": "healthy",
  "timestamp": "2026-01-29T10:14:00.000Z",
  "queueSize": 42,
  "config": {
    "batchLimit": 10,
    "rateLimitMaxQueue": 1000
  }
}
```

### Readiness
```bash
GET /ready
```

Response:
```json
{
  "ready": true
}
```

## Cron Jobs

### 1. Push Notification Processor
- **Schedule**: Every minute (`* * * * *`)
- **Function**: Processes pending notifications from the queue
- **Batch Size**: Configurable via `BATCH_LIMIT`
- **Rate Limiting**: Enabled via `RATE_LIMIT_MAX_QUEUE`

### 2. Daily Notifications
- **Schedule**: Every hour (`0 * * * *`)
- **Tasks**:
  - Overdue gear reminders (for items past due date)
  - Due soon reminders (for items due within 2 days)
  - Office closing reminder (8 AM)
  - Good morning greeting (9 AM)

## Monitoring

Monitor via health endpoint:
```bash
curl http://localhost:3000/health
```

Check logs for any errors (prefixed with category tags):
- `[Push Worker]` - Notification delivery
- `[Daily Notifications]` - Scheduled reminders
- `[Cron]` - Cron job execution
- `[Startup]` - Initialization
- `[Health Check]` - Server status

## Graceful Shutdown

The service handles shutdown signals properly:
- Stops accepting new requests
- Completes pending operations
- Stops all cron jobs
- Exits cleanly

Send SIGTERM or SIGINT:
```bash
kill -TERM <pid>
# or Ctrl+C
```

## Security Notes

✅ **Best Practices Implemented:**
- No secrets in Dockerfile (ARG/ENV removed)
- Secrets passed at runtime only
- `.gitignore` configured for `.env` files
- Non-root user execution (nestcron:nodejs)
- Environment validation on startup
- Proper healthcheck with curl (not node)

⚠️ **Security Reminders:**
- Never commit `.env` files to git
- Never hardcode secrets in code
- Use your platform's secret management for production
- Rotate VAPID keys periodically
- Use strong Supabase service role keys

## Troubleshooting

### Container unhealthy after deployment
- Ensure environment variables are passed to the container
- Check that VAPID keys are configured correctly
- Verify the container can reach the health endpoint on port 3000
- Allow 10+ seconds for startup before health checks

### Missing VAPID keys error
- Confirm `NEXT_PUBLIC_VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are set
- Check they're not empty strings
- Verify they're valid VAPID key pairs

### Rate limiting triggered
- Check queue backlog (in health endpoint response)
- Increase `RATE_LIMIT_MAX_QUEUE` if legitimate
- Verify database connection is stable
- Check if notification sends are slow

### High CPU/Memory usage
- Reduce `BATCH_LIMIT` to process fewer notifications per cycle
- Check for stuck database queries
- Monitor Supabase subscription count

## Database Schema

The service expects these Supabase tables:
- `push_notification_queue` - Notifications pending delivery
- `user_push_tokens` - User device subscriptions
- `gear_requests` - Equipment requests for daily reminders
- `profiles` - User information

## License

All rights reserved - Nest by Eden Oasis
