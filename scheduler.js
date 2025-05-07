// scheduler.js
import cron from 'node-cron';
import { exec } from 'child_process';

// Exécute le script chaque jour à 3h du matin
cron.schedule('0 3 * * *', () => {
  console.log('🕒 Lancement du scraping Instagram…');
  exec('node scrap-instagram-simple.js', (err, stdout, stderr) => {
    if (err) {
      console.error('Erreur cron:', err);
    } else {
      console.log(stdout);
      if (stderr) console.error(stderr);
    }
  });
}, {
  scheduled: true,
  timezone: 'Europe/Paris'
});

console.log('✅ Scheduler démarré en tâche de fond');