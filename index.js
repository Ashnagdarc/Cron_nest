const cron = require('node-cron');
const webPush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

// ============================================================================
// ENVIRONMENT VALIDATION
// ============================================================================
function validateEnvironment() {
    const required = [
        'NEXT_PUBLIC_SUPABASE_URL',
        'SUPABASE_SERVICE_ROLE_KEY',
        'VAPID_PRIVATE_KEY',
        'NEXT_PUBLIC_VAPID_PUBLIC_KEY'
    ];
    
    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
        console.error('[Startup] ❌ Missing required environment variables:', missing.join(', '));
        process.exit(1);
    }
    
    console.log('[Startup] ✅ All required environment variables are set');
}

// ============================================================================
// CONFIGURATION
// ============================================================================
const CONFIG = {
    BATCH_LIMIT: parseInt(process.env.BATCH_LIMIT || '10', 10),
    RATE_LIMIT_WINDOW: parseInt(process.env.RATE_LIMIT_WINDOW || '60000', 10), // 1 minute in ms
    RATE_LIMIT_MAX_QUEUE: parseInt(process.env.RATE_LIMIT_MAX_QUEUE || '1000', 10),
    PORT: parseInt(process.env.PORT || '3000', 10),
    VAPID_MAILTO: process.env.VAPID_MAILTO || 'mailto:noreply@nestbyeden.app'
};

// Rate limiting state
const rateLimitState = {
    queueSize: 0,
    lastProcessTime: 0
};

// Store cron jobs for graceful shutdown
const cronJobs = [];
// Configure Web Push
if (CONFIG.VAPID_PUBLIC_KEY && CONFIG.VAPID_PRIVATE_KEY) {
    try {
        webPush.setVapidDetails(
            CONFIG.VAPID_MAILTO,
            CONFIG.VAPID_PUBLIC_KEY,
            CONFIG.VAPID_PRIVATE_KEY
        );
        console.log('[Push Worker] ✅ VAPID configured successfully');
    } catch (error) {
        console.error('[Push Worker] ❌ VAPID configuration failed:', error.message);
        process.exit(1);
    }
} else {
    console.error('[Push Worker] ❌ Missing VAPID keys');
    process.exit(1);
}
// Initialize Supabase client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseServiceKey) {
    console.error('[Startup] ❌ Missing Supabase environment variables');
    process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
        autoRefreshToken: false,
        persistSession: false
    }
});

// Export CONFIG values for access in functions
CONFIG.VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
CONFIG.VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
async function markFailed(notificationId, errorMessage) {
    await supabase
        .from('push_notification_queue')
        .update({
            status: 'failed',
            error_message: errorMessage
        })
        .eq('id', notificationId);
}
async function processPushNotifications() {
    try {
        // Rate limiting check
        if (rateLimitState.queueSize >= CONFIG.RATE_LIMIT_MAX_QUEUE) {
            console.warn('[Push Worker] ⚠️ Rate limit: Queue size exceeded', {
                current: rateLimitState.queueSize,
                max: CONFIG.RATE_LIMIT_MAX_QUEUE
            });
            return { processed: 0, message: 'Rate limit exceeded - queue full' };
        }

        console.log('[Push Worker] Starting queue processing...');
        // Get pending notifications (limit to prevent timeouts)
        const { data: pendingNotifications, error: fetchError } = await supabase
            .from('push_notification_queue')
            .select('*')
            .eq('status', 'pending')
            .order('created_at', { ascending: true })
            .limit(CONFIG.BATCH_LIMIT); // Use configurable batch limit
        if (fetchError) {
            console.error('[Push Worker] Error fetching pending notifications:', fetchError);
            return { processed: 0, message: 'Failed to fetch pending notifications' };
        }
        if (!pendingNotifications || pendingNotifications.length === 0) {
            console.log('[Push Worker] No pending notifications to process');
            return { processed: 0, message: 'No pending notifications' };
        }
        // Update rate limit state
        rateLimitState.queueSize = pendingNotifications.length;
        console.log(`[Push Worker] Processing ${pendingNotifications.length} notifications (Queue: ${rateLimitState.queueSize}/${CONFIG.RATE_LIMIT_MAX_QUEUE})`);
        let processed = 0;
        let sent = 0;
        let failed = 0;
        for (const notification of pendingNotifications) {
            try {
                console.log(`[Push Worker] Processing notification ${notification.id} for user ${notification.user_id}`);
                // Mark as processing
                await supabase
                    .from('push_notification_queue')
                    .update({
                        status: 'processing',
                        retry_count: notification.retry_count + 1
                    })
                    .eq('id', notification.id);
                // Get user's push subscriptions
                const { data: tokenRows, error: tokenError } = await supabase
                    .from('user_push_tokens')
                    .select('token')
                    .eq('user_id', notification.user_id);
                if (tokenError) {
                    console.error('[Push Worker] Error fetching tokens:', tokenError);
                    await markFailed(notification.id, `Token fetch error: ${tokenError.message}`);
                    failed++;
                    continue;
                }
                if (!tokenRows || tokenRows.length === 0) {
                    console.log(`[Push Worker] No tokens found for user ${notification.user_id}`);
                    await markFailed(notification.id, 'No push tokens found for user');
                    failed++;
                    continue;
                }
                // Send to all user's subscriptions
                let tokenSent = 0;
                let tokenFailed = 0;
                for (const row of tokenRows) {
                    try {
                        const subscription = JSON.parse(row.token);
                        if (subscription && subscription.endpoint) {
                            console.log('[Push Worker] Sending to:', subscription.endpoint?.split('/').pop());
                            const payload = {
                                title: notification.title,
                                body: notification.body,
                                data: notification.data || {}
                            };
                            // Send using web-push library
                            await webPush.sendNotification(
                                subscription,
                                JSON.stringify(payload)
                            );
                            tokenSent++;
                            console.log('[Push Worker] Sent successfully to endpoint');
                        }
                    } catch (error) {
                        console.error('[Push Worker] Send failed:', {
                            statusCode: error.statusCode,
                            message: error.message,
                            endpoint: JSON.parse(row.token).endpoint?.split('/').pop()
                        });
                        // Clean up invalid tokens (410 Gone, 404 Not Found)
                        if (error.statusCode === 410 || error.statusCode === 404) {
                            await supabase
                                .from('user_push_tokens')
                                .delete()
                                .eq('token', row.token);
                            console.log('[Push Worker] Cleaned invalid token');
                        }
                        tokenFailed++;
                    }
                }
                // Mark notification as sent if at least one token succeeded
                if (tokenSent > 0) {
                    await supabase
                        .from('push_notification_queue')
                        .update({
                            status: 'sent',
                            sent_at: new Date().toISOString()
                        })
                        .eq('id', notification.id);
                    sent++;
                    console.log(`[Push Worker] Notification ${notification.id} marked as sent (${tokenSent} tokens)`);
                } else {
                    // All tokens failed
                    const errorMsg = `All ${tokenRows.length} tokens failed`;
                    if (notification.retry_count < notification.max_retries) {
                        // Reset to pending for retry
                        await supabase
                            .from('push_notification_queue')
                            .update({
                                status: 'pending',
                                error_message: errorMsg
                            })
                            .eq('id', notification.id);
                        console.log(`[Push Worker] Notification ${notification.id} reset for retry (${notification.retry_count + 1}/${notification.max_retries})`);
                    } else {
                        await markFailed(notification.id, errorMsg);
                        failed++;
                    }
                }
                processed++;
            } catch (error) {
                console.error(`[Push Worker] Error processing notification ${notification.id}:`, error);
                await markFailed(notification.id, error.message);
                failed++;
                processed++;
            }
        }
        const result = {
            processed,
            sent,
            failed,
            message: `Processed ${processed} notifications (${sent} sent, ${failed} failed)`
        };
        // Update rate limit state after processing
        rateLimitState.queueSize = Math.max(0, rateLimitState.queueSize - processed);
        console.log(`[Push Worker] Completed:`, result);
        return result;
    } catch (error) {
        console.error('[Push Worker] Function error:', error);
        return {
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        };
    }
}
async function runDailyNotifications() {
    try {
        console.log('[Daily Notifications] Starting daily notification processing...');
        const now = new Date();
        const today = now.toISOString().split('T')[0];
        // 1. Overdue gear reminders
        const { data: overdueGear, error: overdueError } = await supabase
            .from('gear_requests')
            .select(`
                id,
                user_id,
                due_date,
                gears:gear_request_gears(gear_id, gears(name))
            `)
            .eq('status', 'Approved')
            .lt('due_date', today);
        if (overdueError) {
            console.error('[Daily Notifications] Error fetching overdue gear:', overdueError);
        } else if (overdueGear && overdueGear.length > 0) {
            // Group by user
            const userOverdue = {};
            overdueGear.forEach(request => {
                if (!userOverdue[request.user_id]) {
                    userOverdue[request.user_id] = [];
                }
                const gearNames = request.gears?.map(g => g.gears?.name).filter(Boolean) || [];
                userOverdue[request.user_id].push(...gearNames);
            });
            // Queue notifications
            for (const [userId, gearNames] of Object.entries(userOverdue)) {
                const gearList = [...new Set(gearNames)].join(', ');
                await supabase.from('push_notification_queue').insert({
                    user_id: userId,
                    title: 'Overdue Equipment Return',
                    body: `Please return the following overdue equipment: ${gearList}`,
                    data: { type: 'overdue_reminder' }
                });
            }
            console.log(`[Daily Notifications] Queued overdue reminders for ${Object.keys(userOverdue).length} users`);
        }
        // 2. Due soon reminders (due in 2 days)
        const twoDaysFromNow = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const { data: dueSoonGear, error: dueSoonError } = await supabase
            .from('gear_requests')
            .select(`
                id,
                user_id,
                due_date,
                gears:gear_request_gears(gear_id, gears(name))
            `)
            .eq('status', 'Approved')
            .gte('due_date', today)
            .lte('due_date', twoDaysFromNow);
        if (dueSoonError) {
            console.error('[Daily Notifications] Error fetching due soon gear:', dueSoonError);
        } else if (dueSoonGear && dueSoonGear.length > 0) {
            const userDueSoon = {};
            dueSoonGear.forEach(request => {
                if (!userDueSoon[request.user_id]) {
                    userDueSoon[request.user_id] = [];
                }
                const gearNames = request.gears?.map(g => g.gears?.name).filter(Boolean) || [];
                userDueSoon[request.user_id].push(...gearNames);
            });
            for (const [userId, gearNames] of Object.entries(userDueSoon)) {
                const gearList = [...new Set(gearNames)].join(', ');
                await supabase.from('push_notification_queue').insert({
                    user_id: userId,
                    title: 'Equipment Due Soon',
                    body: `Please return the following equipment soon: ${gearList}`,
                    data: { type: 'due_soon_reminder' }
                });
            }
            console.log(`[Daily Notifications] Queued due soon reminders for ${Object.keys(userDueSoon).length} users`);
        }
        // 3. Office closing reminder (8 AM)
        const currentHour = now.getHours();
        if (currentHour === 8) {
            const { data: allUsers } = await supabase
                .from('profiles')
                .select('id')
                .eq('status', 'Active');
            if (allUsers && allUsers.length > 0) {
                for (const user of allUsers) {
                    await supabase.from('push_notification_queue').insert({
                        user_id: user.id,
                        title: 'Office Closing Reminder',
                        body: 'Remember to return any borrowed equipment before the office closes.',
                        data: { type: 'office_closing' }
                    });
                }
                console.log(`[Daily Notifications] Queued office closing reminders for ${allUsers.length} users`);
            }
        }
        // 4. Good morning greeting (9 AM)
        if (currentHour === 9) {
            const { data: allUsers } = await supabase
                .from('profiles')
                .select('id')
                .eq('status', 'Active');
            if (allUsers && allUsers.length > 0) {
                for (const user of allUsers) {
                    await supabase.from('push_notification_queue').insert({
                        user_id: user.id,
                        title: 'Good Morning! 🌅',
                        body: 'Have a productive day at Eden Oasis!',
                        data: { type: 'good_morning' }
                    });
                }
                console.log(`[Daily Notifications] Queued good morning greetings for ${allUsers.length} users`);
            }
        }
        console.log('[Daily Notifications] Completed daily notification processing');
    } catch (error) {
        console.error('[Daily Notifications] Error:', error);
    }
}
// ============================================================================
// HEALTH CHECK ENDPOINT
// ============================================================================
const express = require('express');
const app = express();

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        queueSize: rateLimitState.queueSize,
        config: {
            batchLimit: CONFIG.BATCH_LIMIT,
            rateLimitMaxQueue: CONFIG.RATE_LIMIT_MAX_QUEUE
        }
    });
});

app.get('/ready', (req, res) => {
    res.status(200).json({ ready: true });
});

const server = app.listen(CONFIG.PORT, () => {
    console.log(`[Health Check] Server listening on port ${CONFIG.PORT}`);
});

// ============================================================================
// CRON JOBS
// ============================================================================
console.log('🚀 Starting push notification cron service...');

// Validate environment before starting crons
validateEnvironment();

// Process push notifications every minute
cronJobs.push(cron.schedule('* * * * *', async () => {
    try {
        const result = await processPushNotifications();
        console.log('[Cron] Push worker result:', result);
    } catch (error) {
        console.error('[Cron] Push worker error:', error.message);
    }
}));

// Run daily notifications every hour (will check time internally)
cronJobs.push(cron.schedule('0 * * * *', async () => {
    try {
        await runDailyNotifications();
    } catch (error) {
        console.error('[Cron] Daily notifications error:', error.message);
    }
}));

console.log('✅ All push notification crons started');

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================
function gracefulShutdown() {
    console.log('🛑 Received shutdown signal, closing gracefully...');
    
    // Stop accepting new requests
    server.close(() => {
        console.log('✅ HTTP server closed');
    });
    
    // Stop all cron jobs
    cronJobs.forEach((job, index) => {
        job.stop();
        console.log(`✅ Cron job ${index + 1} stopped`);
    });
    
    // Wait for pending operations and exit
    setTimeout(() => {
        console.log('✅ Graceful shutdown complete');
        process.exit(0);
    }, 5000);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
