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
         console.log('Worker result:', result);
       } catch (error) {
         console.error('Worker error:', error);
       }
     });
     console.log('Push worker cron started');
