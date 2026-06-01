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

/* ── GET /api/tasks ── */
const getTasks = async (req, res, next) => {
  try {
    const { role, id: userId } = req.user;
    const where = role === 'admin' ? {} : { assigned_to: userId };

    const tasks = await Task.findAll({ where, ...taskWithDetails });
    res.json(tasks);
  } catch (err) { next(err); }
};

/* ── GET /api/tasks/:id ── */
const getTask = async (req, res, next) => {
  try {
    const task = await Task.findByPk(req.params.id, taskWithDetails);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    // Accountants can only view their own tasks
    if (req.user.role !== 'admin' && task.assigned_to !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
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

    if (req.user.role !== 'admin' && task.assigned_to !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'message is required' });

    const msg = await TaskMessage.create({
      task_id: task.id,
      sender_id: req.user.id,
      sender_role: req.user.role === 'admin' ? 'admin' : 'accountant',
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
    const [pending, in_progress, done, overdue] = await Promise.all([
      Task.count({ where: { status: 'pending' } }),
      Task.count({ where: { status: 'in_progress' } }),
      Task.count({ where: { status: 'done' } }),
      Task.count({ where: { status: 'overdue' } }),
    ]);
    res.json({ pending, in_progress, done, overdue, total: pending + in_progress + done + overdue });
  } catch (err) { next(err); }
};

module.exports = { getTasks, getTask, createTask, updateTask, deleteTask, addMessage, getTaskStats };
