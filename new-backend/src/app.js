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

// Routes
const authRoutes = require('./routes/authRoutes');
const brandRoutes = require('./routes/brandRoutes');
const agentRoutes = require('./routes/agentRoutes');
const salesRoutes = require('./routes/salesRoutes');
const userRoutes = require('./routes/userRoutes');
const cfoAnalyticsRoutes = require('./routes/cfoAnalyticsRoutes');
const invoiceRoutes = require('./routes/invoiceRoutes');
const orderCycleRoutes = require('./routes/orderCycleRoutes');
const recoRoutes = require('./routes/recoRoutes');
const taskRoutes = require('./routes/taskRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const bankCorrectionsRoutes = require('./routes/bankCorrectionsRoutes');

// Sync task tables on startup
const { syncTaskTables } = require('./models/task');
syncTaskTables();

app.use('/api/auth', authRoutes);
app.use('/api', brandRoutes);
app.use('/api', agentRoutes);
app.use('/api', salesRoutes);
app.use('/api', userRoutes);
app.use('/api', cfoAnalyticsRoutes);
app.use('/api', invoiceRoutes);
app.use('/api', orderCycleRoutes);
app.use('/api', recoRoutes);
app.use('/api', taskRoutes);
app.use('/api', dashboardRoutes);
app.use('/api/bank-reco', bankCorrectionsRoutes);

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
