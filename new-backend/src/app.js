const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// Middlewares
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static files (uploads/outputs)
app.use('/api/files', express.static(path.join(__dirname, '../output')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV 
  });
});

// Routes — only what the 4 reco agents need
const authRoutes           = require('./routes/authRoutes');
const brandRoutes          = require('./routes/brandRoutes');
const userRoutes           = require('./routes/userRoutes');
const recoRoutes           = require('./routes/recoRoutes');
const dashboardRoutes      = require('./routes/dashboardRoutes');
const bankCorrectionsRoutes = require('./routes/bankCorrectionsRoutes');
const taskRoutes           = require('./routes/taskRoutes');

app.use('/api/auth',      authRoutes);
app.use('/api',           brandRoutes);
app.use('/api',           userRoutes);
app.use('/api',           recoRoutes);
app.use('/api',           dashboardRoutes);
app.use('/api/bank-reco', bankCorrectionsRoutes);
app.use('/api',           taskRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('[SERVER ERROR]', err);
  const status = err.status || 500;
  res.status(status).json({
    error: err.message || 'Internal Server Error',
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

module.exports = app;
