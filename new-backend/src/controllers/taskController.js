const { Op } = require('sequelize');
const { Task, TaskMessage } = require('../models/task');
const { User } = require('../models/master');

/* ── helpers ── */
const taskWithDetails = {
  include: [
    { model: User, as: 'assignee', attributes: ['id', 'name', 'email', 'role'] },
    { model: User, as: 'creator',  attributes: ['id', 'name', 'email', 'role'] },
    {
      model: TaskMessage, as: 'messages',
      include: [{ model: User, as: 'sender', attributes: ['id', 'name', 'role'] }],
      order: [['createdAt', 'ASC']],
    },
  ],
  order: [['createdAt', 'DESC']],
};

/* ── GET /api/tasks ──
   admin → all · developer → all feedback tasks · accountant → own assigned.
   Optional ?category=feedback filter (used by the admin Feedback tab). */
const getTasks = async (req, res, next) => {
  try {
    const { role, id: userId } = req.user;
    let where;
    if (role === 'admin') where = {};
    else if (role === 'developer') where = { [Op.or]: [{ category: 'feedback' }, { assigned_to: userId }] };
    else where = { assigned_to: userId };
    if (req.query.category) where = { ...where, category: req.query.category };

    const tasks = await Task.findAll({ where, ...taskWithDetails });
    res.json(tasks);
  } catch (err) { next(err); }
};

/* ── POST /api/feedback ──
   A user flags wrong rows on a reco result → becomes a high-priority 'feedback'
   task assigned to the developer (dhaval), visible to developer + admin. */
const createFeedback = async (req, res, next) => {
  try {
    const { agentType, agentLabel, brandId, brandName, jobId, comment, rows } = req.body;
    if (!comment?.trim()) return res.status(400).json({ error: 'comment is required' });

    // Route to the developer; fall back to any admin if no developer exists yet.
    let assignee = await User.findOne({ where: { email: 'dhaval.colonel@gmail.com' } });
    if (!assignee) assignee = await User.findOne({ where: { role: 'developer' } });
    if (!assignee) assignee = await User.findOne({ where: { role: 'admin' } });
    if (!assignee) return res.status(500).json({ error: 'No developer/admin to assign feedback to' });

    const label = agentLabel || agentType || 'Reco';
    const task = await Task.create({
      title: `Feedback · ${label}${brandName ? ' · ' + brandName : ''}`,
      description: comment.trim(),
      category: 'feedback',
      status: 'pending',
      priority: 'high',
      assigned_to: assignee.id,
      assigned_by: req.user.id,
      source_meta: {
        agentType: agentType || null,
        agentLabel: label,
        brandId: brandId || null,
        brandName: brandName || null,
        jobId: jobId || null,
        rows: Array.isArray(rows) ? rows.slice(0, 50) : [],
        by: { id: req.user.id, name: req.user.name, email: req.user.email },
      },
    });

    const full = await Task.findByPk(task.id, taskWithDetails);
    res.status(201).json(full);
  } catch (err) { next(err); }
};

/* ── GET /api/tasks/:id ── */
const getTask = async (req, res, next) => {
  try {
    const task = await Task.findByPk(req.params.id, taskWithDetails);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    // admin → any · developer → feedback tasks · others → own assigned
    const canView =
      req.user.role === 'admin' ||
      (req.user.role === 'developer' && task.category === 'feedback') ||
      task.assigned_to === req.user.id;
    if (!canView) return res.status(403).json({ error: 'Access denied' });
    res.json(task);
  } catch (err) { next(err); }
};

/* ── POST /api/tasks (admin only) ── */
const createTask = async (req, res, next) => {
  try {
    const { title, description, assigned_to, priority, due_date } = req.body;
    if (!title || !assigned_to) {
      return res.status(400).json({ error: 'title and assigned_to are required' });
    }

    const assignee = await User.findByPk(assigned_to);
    if (!assignee) return res.status(404).json({ error: 'Assignee not found' });

    const task = await Task.create({
      title, description, assigned_to,
      assigned_by: req.user.id,
      priority: priority || 'medium',
      due_date: due_date || null,
    });

    const full = await Task.findByPk(task.id, taskWithDetails);
    res.status(201).json(full);
  } catch (err) { next(err); }
};

/* ── PUT /api/tasks/:id (admin full, accountant status only) ── */
const updateTask = async (req, res, next) => {
  try {
    const task = await Task.findByPk(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    if (req.user.role === 'admin') {
      const { title, description, priority, due_date, status, assigned_to } = req.body;
      await task.update({ title, description, priority, due_date, status, assigned_to });
    } else {
      // Accountant can only update status
      if (task.assigned_to !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const { status } = req.body;
      if (status) await task.update({ status });
    }

    const full = await Task.findByPk(task.id, taskWithDetails);
    res.json(full);
  } catch (err) { next(err); }
};

/* ── DELETE /api/tasks/:id (admin only) ── */
const deleteTask = async (req, res, next) => {
  try {
    const task = await Task.findByPk(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    await task.destroy();
    res.json({ message: 'Task deleted' });
  } catch (err) { next(err); }
};

/* ── POST /api/tasks/:id/messages ── */
const addMessage = async (req, res, next) => {
  try {
    const task = await Task.findByPk(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const canPost =
      req.user.role === 'admin' ||
      (req.user.role === 'developer' && task.category === 'feedback') ||
      task.assigned_to === req.user.id;
    if (!canPost) return res.status(403).json({ error: 'Access denied' });

    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'message is required' });

    const senderRole = ['admin', 'developer'].includes(req.user.role) ? req.user.role : 'accountant';
    const msg = await TaskMessage.create({
      task_id: task.id,
      sender_id: req.user.id,
      sender_role: senderRole,
      message: message.trim(),
    });

    const full = await TaskMessage.findByPk(msg.id, {
      include: [{ model: User, as: 'sender', attributes: ['id', 'name', 'role'] }],
    });
    res.status(201).json(full);
  } catch (err) { next(err); }
};

/* ── GET stats for admin ── */
const getTaskStats = async (req, res, next) => {
  try {
    const [pending, in_progress, done, overdue, fbTotal, fbResolved] = await Promise.all([
      Task.count({ where: { status: 'pending' } }),
      Task.count({ where: { status: 'in_progress' } }),
      Task.count({ where: { status: 'done' } }),
      Task.count({ where: { status: 'overdue' } }),
      Task.count({ where: { category: 'feedback' } }),
      Task.count({ where: { category: 'feedback', status: 'done' } }),
    ]);
    res.json({
      pending, in_progress, done, overdue,
      total: pending + in_progress + done + overdue,
      feedbackTotal: fbTotal,
      feedbackResolved: fbResolved,
      feedbackOpen: fbTotal - fbResolved,
    });
  } catch (err) { next(err); }
};

module.exports = { getTasks, getTask, createTask, updateTask, deleteTask, addMessage, getTaskStats, createFeedback };
