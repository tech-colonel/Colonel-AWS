const { Agent, Brand, BrandAgent, User } = require('../models/master');
const { Task } = require('../models/task');
const { getBrandConnection, masterSequelize } = require('../config/database');
const { getBrandAgentModel, getDynamicModel } = require('../models/brand');

/**
 * Create a new agent type (Admin only)
 */
const createAgent = async (req, res, next) => {
  try {
    const { name, description, columns } = req.body;

    const existingAgent = await Agent.findOne({ where: { name } });
    if (existingAgent) {
      return res.status(400).json({ error: 'Agent already exists' });
    }

    const agent = await Agent.create({
      name,
      description,
      columns
    });

    res.status(201).json({
      message: 'Agent created successfully',
      agent
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get all available agents
 */
const getAllAgents = async (req, res, next) => {
  try {
    const agents = await Agent.findAll({ order: [['createdAt', 'DESC'], ['name', 'ASC']] });
    res.json(agents);
  } catch (error) {
    next(error);
  }
};

/**
 * Assign an agent to a brand
 * This involves creating the brand-agent link in Master DB
 * and initializing the agent's tables in the Brand DB
 */
const assignAgentToBrand = async (req, res, next) => {
  try {
    const { brand_id, agent_id } = req.body;

    const brand = await Brand.findByPk(brand_id);
    const agent = await Agent.findByPk(agent_id);

    if (!brand || !agent) {
      return res.status(404).json({ error: 'Brand or Agent not found' });
    }

    // 1. Create relation in Master DB
    console.log('[DEBUG] Assigning Agent:', { brand_id, agent_id });
    await BrandAgent.findOrCreate({ where: { brand_id, agent_id } });

    // 2. Initialize tables in Brand DB
    const brandDb = getBrandConnection(brand.db_name);
    
    // Core brand_agents table for this brand
    const BrandAgentModel = getBrandAgentModel(brandDb);

    // Dynamic table for this specific agent's processed files
    const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    getDynamicModel(brandDb, tableName, agent.columns);

    await brandDb.sync();

    // 3. Initialize the agent record in Brand DB
    await BrandAgentModel.findOrCreate({
      where: { brand_id, agent_id }
    });

    res.json({ message: 'Agent assigned to brand successfully' });
  } catch (error) {
    next(error);
  }
};

/**
 * Get agents assigned to a specific brand
 */
const getBrandAgents = async (req, res, next) => {
  try {
    const brand = await Brand.findByPk(req.params.brandId, {
      include: [{ model: Agent, through: { attributes: [] } }]
    });

    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    res.json(brand.Agents || []);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/agents/request  (any authenticated user)
 * A user requests a brand-new agent/tool with a description. We don't create an
 * Agent — instead this becomes a 'agent_request' Task routed to an admin, so it
 * shows up in the admin Tasks queue. Reuses the Task model (no schema change).
 */
const requestAgent = async (req, res, next) => {
  try {
    const { name, description, brandId, brandName } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Agent name is required' });

    const assignee = await User.findOne({ where: { role: 'admin' } });
    if (!assignee) return res.status(500).json({ error: 'No admin available to receive the request' });

    const task = await Task.create({
      title: `Agent request · ${name.trim()}`,
      description: (description || '').trim() || 'No description provided.',
      category: 'agent_request',
      status: 'pending',
      priority: 'medium',
      assigned_to: assignee.id,
      assigned_by: req.user.id,
      source_meta: {
        requestedName: name.trim(),
        brandId: brandId || null,
        brandName: brandName || null,
        by: { id: req.user.id, name: req.user.name, email: req.user.email },
      },
    });

    res.status(201).json({ message: 'Agent request submitted', taskId: task.id });
  } catch (error) {
    next(error);
  }
};

/**
 * Proxy webhook request to avoid CORS issues from frontend
 */
const proxyWebhook = async (req, res, next) => {
  try {
    const { webhookUrl, payload } = req.body;
    if (!webhookUrl) {
      return res.status(400).json({ error: 'Webhook URL is required' });
    }

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload || {})
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `Webhook returned status ${response.status}` });
    }

    let responseData;
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      responseData = await response.json();
    } else {
      responseData = { message: 'Webhook triggered successfully (non-JSON response)' };
    }

    res.json(responseData);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to trigger webhook' });
  }
};

/**
 * GET /api/agents/:agentId/brands
 * Returns all brands that have this agent assigned (from master brand_agents)
 */
const getAgentBrands = async (req, res, next) => {
  try {
    const { agentId } = req.params;
    const agent = await Agent.findByPk(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const assignments = await BrandAgent.findAll({ where: { agent_id: agentId } });
    const brandIds = assignments.map((a) => a.brand_id);
    const brands = await Brand.findAll({ where: { id: brandIds } });

    res.json(brands);
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/brands/:brandId/agents/:agentId/data  (Admin only)
 * Clears sku_master and ledger_master from the brand DB's brand_agents record.
 */
const clearBrandAgentData = async (req, res, next) => {
  try {
    const { brandId, agentId } = req.params;

    const brand = await Brand.findByPk(brandId);
    const agent = await Agent.findByPk(agentId);
    if (!brand || !agent) return res.status(404).json({ error: 'Brand or Agent not found' });

    const brandDb = getBrandConnection(brand.db_name);
    const BrandAgentModel = getBrandAgentModel(brandDb);
    await BrandAgentModel.sync({ force: false });

    const record = await BrandAgentModel.findOne({ where: { brand_id: brandId, agent_id: agentId } });
    if (!record) return res.status(404).json({ error: 'Assignment not found in brand database' });

    await record.update({ sku_master: [], ledger_master: [] });

    res.json({ success: true, message: `SKU and ledger data cleared for brand "${brand.name}" / agent "${agent.name}"` });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/agents/:agentId  (Admin only)
 * 1. Drops the agent's dynamic table from EVERY brand DB
 * 2. Removes brand_agents records in every brand DB
 * 3. Removes master brand_agents link records
 * 4. Destroys the agent row itself
 */
const deleteAgent = async (req, res, next) => {
  try {
    const { agentId } = req.params;

    const agent = await Agent.findByPk(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const brands = await Brand.findAll();

    const results = [];

    for (const brand of brands) {
      try {
        const brandDb = getBrandConnection(brand.db_name);

        // Drop the agent's processed-data table
        await brandDb.query(`DROP TABLE IF EXISTS "${tableName}"`);

        // Remove the brand_agents record that links this brand+agent
        const BrandAgentModel = getBrandAgentModel(brandDb);
        await BrandAgentModel.sync({ force: false });
        await BrandAgentModel.destroy({ where: { agent_id: agentId } });

        results.push({ brand: brand.name, status: 'cleaned' });
      } catch (err) {
        console.error(`[deleteAgent] Error on brand "${brand.name}":`, err.message);
        results.push({ brand: brand.name, status: 'error', error: err.message });
      }
    }

    // Remove master brand_agents links
    await BrandAgent.destroy({ where: { agent_id: agentId } });

    // Delete the agent itself
    await agent.destroy();

    res.json({
      success: true,
      message: `Agent "${agent.name}" deleted and tables dropped from all brand databases`,
      details: results
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createAgent,
  getAllAgents,
  assignAgentToBrand,
  getBrandAgents,
  getAgentBrands,
  clearBrandAgentData,
  deleteAgent,
  proxyWebhook,
  requestAgent
};
