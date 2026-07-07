const { Plan, User } = require('../models/master');
const { Task } = require('../models/task');

const canSee = (plan, user) =>
  user.role === 'admin' ||
  plan.created_by === user.id ||
  (Array.isArray(plan.shared_with) && plan.shared_with.includes(user.id));

/* GET /api/plans — admin: all; others: plans shared with them (or created by them) */
const getPlans = async (req, res, next) => {
  try {
    const all = await Plan.findAll({ order: [['updatedAt', 'DESC']] });
    const visible = req.user.role === 'admin' ? all : all.filter(p => canSee(p, req.user));
    // List view: omit the (potentially large) graph
    res.json(visible.map(p => ({
      id: p.id, name: p.name, description: p.description,
      created_by: p.created_by, shared_with: p.shared_with,
      nodeCount: (p.graph?.nodes || []).length,
      updatedAt: p.updatedAt, createdAt: p.createdAt,
    })));
  } catch (e) { next(e); }
};

/* GET /api/plans/:id — full graph */
const getPlan = async (req, res, next) => {
  try {
    const plan = await Plan.findByPk(req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (!canSee(plan, req.user)) return res.status(403).json({ error: 'Access denied' });
    res.json(plan);
  } catch (e) { next(e); }
};

/* POST /api/plans (admin) */
const createPlan = async (req, res, next) => {
  try {
    const { name, description } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    const plan = await Plan.create({
      name: name.trim(), description: description || null,
      created_by: req.user.id, shared_with: [], graph: { nodes: [], edges: [] },
    });
    res.status(201).json(plan);
  } catch (e) { next(e); }
};

/* PUT /api/plans/:id (admin) — save graph / rename / share */
const updatePlan = async (req, res, next) => {
  try {
    const plan = await Plan.findByPk(req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const { name, description, graph, shared_with } = req.body;
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (description !== undefined) patch.description = description;
    if (graph !== undefined) patch.graph = graph;
    if (shared_with !== undefined) patch.shared_with = Array.isArray(shared_with) ? shared_with : [];
    await plan.update(patch);
    res.json(plan);
  } catch (e) { next(e); }
};

/* DELETE /api/plans/:id (admin) */
const deletePlan = async (req, res, next) => {
  try {
    const plan = await Plan.findByPk(req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    await plan.destroy();
    res.json({ deleted: true });
  } catch (e) { next(e); }
};

/* POST /api/plans/from-task/:taskId (admin, developer) — seed a plan from a
   feedback task so the engineer can map out the fix on the n8n canvas. */
const createPlanFromTask = async (req, res, next) => {
  try {
    const task = await Task.findByPk(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const meta = task.source_meta || {};
    const nodes = [
      { id: 'n_fb',    type: 'note',  position: { x: 60,  y: 60 },  data: { label: `Feedback: ${String(task.description || '').slice(0, 240)}` } },
      { id: 'n_agent', type: 'agent', position: { x: 60,  y: 230 }, data: { label: meta.agentLabel || meta.agentType || 'Agent' } },
      { id: 'n_diag',  type: 'step',  position: { x: 380, y: 150 }, data: { label: 'Investigate the flagged rows' } },
      { id: 'n_fix',   type: 'step',  position: { x: 680, y: 150 }, data: { label: 'Fix & re-run reconciliation' } },
    ];
    const edges = [
      { id: 'e1', source: 'n_fb',    target: 'n_diag', animated: true },
      { id: 'e2', source: 'n_agent', target: 'n_diag', animated: true },
      { id: 'e3', source: 'n_diag',  target: 'n_fix',  animated: true },
    ];
    const plan = await Plan.create({
      name: task.title || 'Feedback plan',
      description: `Plan generated from feedback task ${task.id}`,
      created_by: req.user.id,
      shared_with: [],
      graph: { nodes, edges },
    });
    // Link plan back to the task so the UI can show "View Plan" instead of "Make a plan".
    await task.update({ plan_id: plan.id });
    res.status(201).json(plan);
  } catch (e) { next(e); }
};

module.exports = { getPlans, getPlan, createPlan, updatePlan, deletePlan, createPlanFromTask };
