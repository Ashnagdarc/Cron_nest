const cron = require('node-cron');
const webPush = require('web-push');
const { createClient } = require('@supabase/supabase-js');
// Configure VAPID for Web Push
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_MAILTO = process.env.VAPID_MAILTO || 'mailto:noreply@nestbyeden.app';
// Configure Web Push
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    try {
        webPush.setVapidDetails(
            VAPID_MAILTO,
            VAPID_PUBLIC_KEY,
            VAPID_PRIVATE_KEY
        );
        console.log('[Push Worker] VAPID configured successfully');
    } catch (error) {
        console.error('[Push Worker] VAPID configuration failed:', error);
    }
} else {
    console.error('[Push Worker] Missing VAPID keys:', {
        publicKey: !!VAPID_PUBLIC_KEY,
        privateKey: !!VAPID_PRIVATE_KEY
    });
}
// Initialize Supabase client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseServiceKey) {
    console.error('[Push Worker] Missing Supabase environment variables');
    process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
        autoRefreshToken: false,
        persistSession: false
    }
});
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
        console.log('[Push Worker] Starting queue processing...');
        // Get pending notifications (limit to prevent timeouts)
        const { data: pendingNotifications, error: fetchError } = await supabase
            .from('push_notification_queue')
            .select('*')
            .eq('status', 'pending')
            .order('created_at', { ascending: true })
            .limit(10); // Process in batches
        if (fetchError) {
            console.error('[Push Worker] Error fetching pending notifications:', fetchError);
            return { processed: 0, message: 'Failed to fetch pending notifications' };
        }
        if (!pendingNotifications || pendingNotifications.length === 0) {
            console.log('[Push Worker] No pending notifications to process');
            return { processed: 0, message: 'No pending notifications' };
        }
        console.log(`[Push Worker] Processing ${pendingNotifications.length} notifications`);
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
// Start cron jobs
console.log('🚀 Starting push notification cron service...');
// Process push notifications every minute
cron.schedule('* * * * *', async () => {
    try {
        const result = await processPushNotifications();
        console.log('Push worker result:', result);
    } catch (error) {
        console.error('Push worker cron error:', error);
    }
});
// Run daily notifications every hour (will check time internally)
cron.schedule('0 * * * *', async () => {
    try {
        await runDailyNotifications();
    } catch (error) {
        console.error('Daily notifications cron error:', error);
    }
});
console.log('✅ All push notification crons started');
// Keep the process running
process.on('SIGINT', () => {
    console.log('🛑 Received SIGINT, shutting down gracefully...');
    process.exit(0);
});
process.on('SIGTERM', () => {
    console.log('🛑 Received SIGTERM, shutting down gracefully...');
    process.exit(0);
});
