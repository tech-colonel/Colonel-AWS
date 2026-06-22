/* ── Colonel AI — MCP server registry (visual connect only) ─────────────────
   Paste a server name + URL → stored and listed with a "registered" badge.
   Real MCP tool-calling is deferred; this is a registry, not a live client.   */

const { McpServer } = require('../models/master');

/* GET /api/mcp — all registered servers (shared registry, newest first). */
const listMcp = async (req, res, next) => {
  try {
    const rows = await McpServer.findAll({ order: [['createdAt', 'DESC']] });
    res.json(rows);
  } catch (err) { next(err); }
};

/* POST /api/mcp — body { name, url }. */
const addMcp = async (req, res, next) => {
  try {
    const name = (req.body?.name || '').trim();
    const url = (req.body?.url || '').trim();
    if (!name || !url) return res.status(400).json({ error: 'name and url are required' });
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'url must start with http(s)://' });

    const row = await McpServer.create({
      name, url, status: 'registered', created_by: req.user.id,
    });
    res.status(201).json(row);
  } catch (err) { next(err); }
};

/* DELETE /api/mcp/:id */
const deleteMcp = async (req, res, next) => {
  try {
    const n = await McpServer.destroy({ where: { id: req.params.id } });
    if (!n) return res.status(404).json({ error: 'MCP server not found' });
    res.json({ message: 'MCP server removed' });
  } catch (err) { next(err); }
};

module.exports = { listMcp, addMcp, deleteMcp };
