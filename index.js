const cron = require('node-cron');
const fetch = require('node-fetch');
const CRON_SECRET = process.env.CRON_SECRET;
const VERCEL_URL = process.env.VERCEL_URL;
cron.schedule('* * * * *', async () => {
  try {
    const response = await fetch(`${VERCEL_URL}/api/push/worker`, {
      headers: {
        'Authorization': `Bearer ${CRON_SECRET}`
      }
    });
    const result = await response.json();
    console.log('Push worker result:', result);
  } catch (error) {
    console.error('Push worker error:', error);
  }
});
// Daily notifications at 8 AM (overdue, due soon, office closing)
cron.schedule('0 8 * * *', async () => {
  try {
    const response = await fetch(`${VERCEL_URL}/api/notifications/daily-notifications`, {
      headers: {
        'Authorization': `Bearer ${CRON_SECRET}`
      }
    });
    const result = await response.json();
    console.log('Daily notifications result:', result);
  } catch (error) {
    console.error('Daily notifications error:', error);
  }
});
// Good morning notifications at 9 AM daily
cron.schedule('0 9 * * *', async () => {
  try {
    const response = await fetch(`${VERCEL_URL}/api/notifications/good-morning`, {
      headers: {
        'Authorization': `Bearer ${CRON_SECRET}`
      }
    });
    const result = await response.json();
    console.log('Good morning result:', result);
  } catch (error) {
    console.error('Good morning error:', error);
  }
});
console.log('All push notification crons started');
