// server.js
import 'dotenv/config';
import path from 'path';
import express from 'express';
import handler from './api/recommands.js';

const app = express();
app.use(express.json());

// 1) Sert tout ce qu'il y a dans /public
app.use(express.static(path.join(process.cwd(), 'public')));

// 2) Ton endpoint API
app.post('/api/recommands', handler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
});