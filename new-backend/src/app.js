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

// ── Core routes ──────────────────────────────────────────────────────────────
const authRoutes            = require('./routes/authRoutes');
const brandRoutes           = require('./routes/brandRoutes');
const userRoutes            = require('./routes/userRoutes');
const agentRoutes           = require('./routes/agentRoutes');
// ── Reco suite ───────────────────────────────────────────────────────────────
const recoRoutes            = require('./routes/recoRoutes');
const dashboardRoutes       = require('./routes/dashboardRoutes');
const bankCorrectionsRoutes = require('./routes/bankCorrectionsRoutes');
const taskRoutes            = require('./routes/taskRoutes');
// ── Sales agents ─────────────────────────────────────────────────────────────
const salesRoutes           = require('./routes/salesRoutes');
const invoiceRoutes         = require('./routes/invoiceRoutes');
const orderCycleRoutes      = require('./routes/orderCycleRoutes');
const settlementRoutes      = require('./routes/settlementRoutes');
// ── CFO dashboards ────────────────────────────────────────────────────────────
const cfoAnalyticsRoutes    = require('./routes/cfoAnalyticsRoutes');
const mtrRoutes             = require('./routes/mtrRoutes');
const plansRoutes           = require('./routes/plansRoutes');
const integrationRoutes     = require('./routes/integrationRoutes');
const chatRoutes            = require('./routes/chatRoutes');
const workflowRoutes        = require('./routes/workflowRoutes');
const meetingRoutes         = require('./routes/meetingRoutes');
const zohoRoutes            = require('./routes/zohoRoutes');
// ── Compliance Tracker ────────────────────────────────────────────────────────
const complianceRoutes      = require('./routes/complianceRoutes');
const attachmentsRoutes     = require('./routes/attachmentsRoutes');

app.use('/api/auth',      authRoutes);
app.use('/api',           brandRoutes);
app.use('/api',           userRoutes);
app.use('/api',           agentRoutes);
app.use('/api',           recoRoutes);
app.use('/api',           dashboardRoutes);
app.use('/api/bank-reco', bankCorrectionsRoutes);
app.use('/api',           taskRoutes);
app.use('/api',           salesRoutes);
app.use('/api',           invoiceRoutes);
app.use('/api',           orderCycleRoutes);
app.use('/api',           settlementRoutes);
app.use('/api',           cfoAnalyticsRoutes);
app.use('/api',           mtrRoutes);
app.use('/api',           plansRoutes);
app.use('/api',           integrationRoutes);
app.use('/api',           chatRoutes);
app.use('/api',           workflowRoutes);
app.use('/api',           meetingRoutes);
app.use('/api',           zohoRoutes);
app.use('/api',           complianceRoutes);
app.use('/api',           attachmentsRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('[SERVER ERROR]', err);
  const status = err.status || 500;
  res.status(status).json({
    error: err.message || 'Internal Server Error',
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// Serve React frontend build (for single-domain ngrok / production)
const frontendBuild = path.join(__dirname, '../../frontend/build');
if (require('fs').existsSync(frontendBuild)) {
  app.use(express.static(frontendBuild));
  app.get('/{*path}', (req, res) => res.sendFile(path.join(frontendBuild, 'index.html')));
}

module.exports = app;
