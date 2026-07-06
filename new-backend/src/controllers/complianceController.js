/**
 * complianceController.js — Compliance Tracker (separate module).
 * Brand-scoped + user-scoped tasks in the MASTER DB. Un-seeded brands return
 * an empty list (that's the "blank for Koparo" behaviour).
 */
const { masterSequelize } = require('../config/database');
const { CATEGORIES, AGENTS, WINDOWS } = require('../data/complianceTemplate');

const VALID_STATUS = ['todo', 'in_progress', 'review', 'done'];
const VALID_PRIORITY = ['low', 'medium', 'high', 'urgent'];

/* Admin sees everything; others must be assigned to the brand via brand_users. */
const canAccessBrand = async (user, brandId) => {
  if (user.role === 'admin') return true;
  const [rows] = await masterSequelize.query(
    `SELECT 1 FROM brand_users WHERE user_id = $1 AND brand_id = $2 LIMIT 1`,
    { bind: [user.id, brandId] }
  );
  return rows.length > 0;
};

/* Which user's tracker are we reading/writing? Admin may target another via
   ?userId=; everyone else is scoped to themselves. */
const targetUserId = (req) =>
  (req.user.role === 'admin' && req.query.userId) ? req.query.userId : req.user.id;

const listSelect = `
  SELECT t.*, c.name AS category_name, c.color AS category_color,
    (SELECT count(*) FROM compliance_attachments a
      WHERE a.entity_type = 'compliance_task' AND a.entity_id = t.id) AS attachment_count
  FROM compliance_tasks t
  LEFT JOIN compliance_categories c ON c.id = t.category_id`;

/* ── GET /api/brands/:brandId/compliance?year&month&category&tab&userId ── */
const listTasks = async (req, res, next) => {
  try {
    const { brandId } = req.params;
    if (!(await canAccessBrand(req.user, brandId)))
      return res.status(403).json({ error: 'Access denied for this brand' });

    const userId = targetUserId(req);
    const { year, month, category, tab } = req.query;

    const where = ['t.brand_id = $1', 't.user_id = $2'];
    const bind = [brandId, userId];
    if (year)  { bind.push(Number(year));  where.push(`t.year IS NOT DISTINCT FROM $${bind.length}`); }
    if (month) { bind.push(Number(month)); where.push(`t.month IS NOT DISTINCT FROM $${bind.length}`); }
    if (category && category !== 'all') { bind.push(category); where.push(`t.category_id = $${bind.length}`); }
    if (tab === 'admin') where.push(`t.source = 'admin'`);

    const [rows] = await masterSequelize.query(
      `${listSelect} WHERE ${where.join(' AND ')}
       ORDER BY t.period_order NULLS LAST, t.seq NULLS LAST, t.created_at ASC`,
      { bind }
    );
    res.json(rows);
  } catch (err) { next(err); }
};

/* ── GET /api/brands/:brandId/compliance/months ── which instances exist ── */
const listMonths = async (req, res, next) => {
  try {
    const { brandId } = req.params;
    if (!(await canAccessBrand(req.user, brandId)))
      return res.status(403).json({ error: 'Access denied for this brand' });
    const userId = targetUserId(req);
    const [rows] = await masterSequelize.query(
      `SELECT year, month, count(*)::int AS total,
              count(*) FILTER (WHERE status = 'done')::int AS done
       FROM compliance_tasks
       WHERE brand_id = $1 AND user_id = $2 AND year IS NOT NULL AND month IS NOT NULL
       GROUP BY year, month ORDER BY year, month`,
      { bind: [brandId, userId] }
    );
    res.json(rows);
  } catch (err) { next(err); }
};

/* ── GET /api/brands/:brandId/compliance/categories ── */
const listCategories = async (req, res, next) => {
  try {
    const { brandId } = req.params;
    if (!(await canAccessBrand(req.user, brandId)))
      return res.status(403).json({ error: 'Access denied for this brand' });
    const [rows] = await masterSequelize.query(
      `SELECT id, name, color, is_system FROM compliance_categories
       WHERE brand_id = $1 ORDER BY is_system DESC, name ASC`,
      { bind: [brandId] }
    );
    res.json(rows);
  } catch (err) { next(err); }
};

/* ── POST /api/brands/:brandId/compliance/categories  {name,color} ── */
const createCategory = async (req, res, next) => {
  try {
    const { brandId } = req.params;
    if (!(await canAccessBrand(req.user, brandId)))
      return res.status(403).json({ error: 'Access denied for this brand' });
    const { name, color } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    const [rows] = await masterSequelize.query(
      `INSERT INTO compliance_categories (brand_id, name, color, is_system, created_by)
       VALUES ($1, $2, $3, false, $4)
       ON CONFLICT (brand_id, lower(name)) DO UPDATE SET color = EXCLUDED.color, updated_at = now()
       RETURNING id, name, color, is_system`,
      { bind: [brandId, name.trim(), color || '#0748EE', req.user.id] }
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
};

/* ── POST /api/brands/:brandId/compliance  create a task ── */
const createTask = async (req, res, next) => {
  try {
    const { brandId } = req.params;
    if (!(await canAccessBrand(req.user, brandId)))
      return res.status(403).json({ error: 'Access denied for this brand' });

    const b = req.body;
    if (!b.title?.trim()) return res.status(400).json({ error: 'title is required' });

    // Admin assigning to someone else → source 'admin'; otherwise a self task.
    const ownerId = (req.user.role === 'admin' && b.user_id) ? b.user_id : req.user.id;
    const source = (req.user.role === 'admin' && b.user_id && b.user_id !== req.user.id) ? 'admin' : 'self';
    const status = VALID_STATUS.includes(b.status) ? b.status : 'todo';
    const priority = VALID_PRIORITY.includes(b.priority) ? b.priority : 'medium';

    const [rows] = await masterSequelize.query(
      `INSERT INTO compliance_tasks
        (brand_id, user_id, year, month, title, description, category_id, status,
         priority, progress, due_date, source, assigned_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      { bind: [
        brandId, ownerId,
        b.year || null, b.month || null,
        b.title.trim(), (b.description || '').trim() || null,
        b.category_id || null, status, priority,
        Number.isFinite(+b.progress) ? Math.max(0, Math.min(100, +b.progress)) : 0,
        b.due_date || null, source,
        source === 'admin' ? req.user.id : null,
      ] }
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
};

/* ── PATCH /api/compliance/:id  update status/progress/etc. ── */
const updateTask = async (req, res, next) => {
  try {
    const { id } = req.params;
    const [found] = await masterSequelize.query(
      `SELECT * FROM compliance_tasks WHERE id = $1 LIMIT 1`, { bind: [id] }
    );
    const task = found[0];
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!(await canAccessBrand(req.user, task.brand_id)))
      return res.status(403).json({ error: 'Access denied' });

    const b = req.body;
    const sets = [];
    const bind = [];
    const set = (col, val) => { bind.push(val); sets.push(`${col} = $${bind.length}`); };

    if (b.title !== undefined)       set('title', String(b.title).trim());
    if (b.description !== undefined) set('description', b.description);
    if (b.category_id !== undefined) set('category_id', b.category_id || null);
    if (b.priority !== undefined && VALID_PRIORITY.includes(b.priority)) set('priority', b.priority);
    if (b.due_date !== undefined)    set('due_date', b.due_date || null);
    if (b.progress !== undefined)    set('progress', Math.max(0, Math.min(100, +b.progress || 0)));
    if (b.status !== undefined && VALID_STATUS.includes(b.status)) {
      set('status', b.status);
      set('completed_at', b.status === 'done' ? new Date() : null);
      // Moving to Done implies 100%; leaving Done resets progress to 0 —
      // unless the caller explicitly set a progress value in the same request.
      if (b.progress === undefined) {
        if (b.status === 'done') set('progress', 100);
        else if (task.status === 'done') set('progress', 0);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'No updatable fields provided' });

    sets.push(`updated_at = now()`);
    bind.push(id);
    const [rows] = await masterSequelize.query(
      `UPDATE compliance_tasks SET ${sets.join(', ')} WHERE id = $${bind.length} RETURNING *`,
      { bind }
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
};

/* ── DELETE /api/compliance/:id ── */
const deleteTask = async (req, res, next) => {
  try {
    const { id } = req.params;
    const [found] = await masterSequelize.query(
      `SELECT brand_id, user_id FROM compliance_tasks WHERE id = $1 LIMIT 1`, { bind: [id] }
    );
    const task = found[0];
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!(await canAccessBrand(req.user, task.brand_id)))
      return res.status(403).json({ error: 'Access denied' });
    await masterSequelize.query(
      `DELETE FROM compliance_attachments WHERE entity_type = 'compliance_task' AND entity_id = $1`,
      { bind: [id] }
    );
    await masterSequelize.query(`DELETE FROM compliance_tasks WHERE id = $1`, { bind: [id] });
    res.json({ message: 'Task deleted' });
  } catch (err) { next(err); }
};

/* ── POST /api/brands/:brandId/compliance/seed  (admin) ──
   Materialise the template as 12 monthly instances for (brand, user).
   Idempotent: template rows collide on the partial unique index and are skipped. */
const seedBrandUser = async (req, res, next) => {
  try {
    const { brandId } = req.params;
    const userId = req.body.userId || req.user.id;
    const year = Number(req.body.year) || new Date().getFullYear();
    const result = await seedComplianceForBrandUser({ brandId, userId, year });
    res.json({ message: 'Compliance tracker seeded', ...result });
  } catch (err) { next(err); }
};

/**
 * Shared seeding routine — used by the admin endpoint AND the standalone
 * provisioning script. Ensures categories exist, then inserts 12 months of
 * template tasks. Safe to re-run.
 */
const seedComplianceForBrandUser = async ({ brandId, userId, year }) => {
  // 1. Ensure the brand's categories exist; map name → id.
  const catId = {};
  for (const c of CATEGORIES) {
    const [rows] = await masterSequelize.query(
      `INSERT INTO compliance_categories (brand_id, name, color, is_system)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (brand_id, lower(name)) DO UPDATE SET color = EXCLUDED.color
       RETURNING id, name`,
      { bind: [brandId, c.name, c.color] }
    );
    catId[c.name] = rows[0].id;
  }

  // 2. Materialise 12 monthly instances.
  let inserted = 0;
  for (let month = 1; month <= 12; month++) {
    for (const win of WINDOWS) {
      let seq = 0;
      for (const t of win.tasks) {
        seq += 1;
        const [rows] = await masterSequelize.query(
          `INSERT INTO compliance_tasks
            (brand_id, user_id, year, month, period, period_order, seq, title,
             category_id, data_source, frequency, remarks, agent_id, source, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'template','todo')
           ON CONFLICT (brand_id, user_id, year, month, period_order, seq)
             WHERE source = 'template' DO NOTHING
           RETURNING id`,
          { bind: [
            brandId, userId, year, month, win.period, win.order, seq, t.title,
            catId[t.category] || null, t.source || null, t.frequency || null,
            t.remarks || null, t.agent ? AGENTS[t.agent] : null,
          ] }
        );
        if (rows.length) inserted += 1;
      }
    }
  }
  return { year, months: 12, inserted };
};

/* ── chat-with-admin ─────────────────────────────────────────────────────── */

/* Which thread? Accountant = their own; admin must name the accountant via
   ?userId / body.userId. */
const chatThreadUser = (req) =>
  req.user.role === 'admin' ? (req.query.userId || req.body.userId) : req.user.id;

/* ── GET /api/brands/:brandId/admin-chat[?userId] ── */
const listChat = async (req, res, next) => {
  try {
    const { brandId } = req.params;
    if (!(await canAccessBrand(req.user, brandId)))
      return res.status(403).json({ error: 'Access denied for this brand' });
    const threadUser = chatThreadUser(req);
    if (!threadUser) return res.status(400).json({ error: 'userId is required' });

    const [rows] = await masterSequelize.query(
      `SELECT m.*, u.name AS sender_name
       FROM compliance_chat_messages m
       LEFT JOIN users u ON u.id = m.sender_id
       WHERE m.brand_id = $1 AND m.thread_user_id = $2
       ORDER BY m.created_at ASC`,
      { bind: [brandId, threadUser] }
    );
    // Mark the OTHER side's messages read now that this side is viewing.
    const otherRole = req.user.role === 'admin' ? 'accountant' : 'admin';
    await masterSequelize.query(
      `UPDATE compliance_chat_messages SET read_at = now()
       WHERE brand_id = $1 AND thread_user_id = $2 AND sender_role = $3 AND read_at IS NULL`,
      { bind: [brandId, threadUser, otherRole] }
    );
    res.json(rows);
  } catch (err) { next(err); }
};

/* ── POST /api/brands/:brandId/admin-chat  {message, userId?} ── */
const postChat = async (req, res, next) => {
  try {
    const { brandId } = req.params;
    if (!(await canAccessBrand(req.user, brandId)))
      return res.status(403).json({ error: 'Access denied for this brand' });
    const message = (req.body.message || '').trim();
    if (!message) return res.status(400).json({ error: 'message is required' });
    const threadUser = chatThreadUser(req);
    if (!threadUser) return res.status(400).json({ error: 'userId is required' });
    const senderRole = req.user.role === 'admin' ? 'admin' : 'accountant';

    const [rows] = await masterSequelize.query(
      `INSERT INTO compliance_chat_messages
        (brand_id, thread_user_id, sender_id, sender_role, message)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      { bind: [brandId, threadUser, req.user.id, senderRole, message] }
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
};

/* ── GET /api/admin-chat/threads  (admin inbox across all brands) ── */
const listChatThreads = async (req, res, next) => {
  try {
    const [rows] = await masterSequelize.query(
      `SELECT m.brand_id, m.thread_user_id,
              b.name AS brand_name, u.name AS user_name, u.email AS user_email,
              max(m.created_at) AS last_at,
              count(*) FILTER (WHERE m.sender_role = 'accountant' AND m.read_at IS NULL)::int AS unread,
              (array_agg(m.message ORDER BY m.created_at DESC))[1] AS last_message
       FROM compliance_chat_messages m
       LEFT JOIN brands b ON b.id = m.brand_id
       LEFT JOIN users u ON u.id = m.thread_user_id
       GROUP BY m.brand_id, m.thread_user_id, b.name, u.name, u.email
       ORDER BY last_at DESC`
    );
    res.json(rows);
  } catch (err) { next(err); }
};

module.exports = {
  listTasks, listMonths, listCategories, createCategory,
  createTask, updateTask, deleteTask, seedBrandUser,
  seedComplianceForBrandUser,
  listChat, postChat, listChatThreads,
};
