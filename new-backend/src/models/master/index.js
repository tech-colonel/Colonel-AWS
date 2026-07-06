const { DataTypes } = require('sequelize');
const { masterSequelize } = require('../../config/database');

const User = masterSequelize.define('User', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  email: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false
  },
  password: {
    type: DataTypes.STRING,
    allowNull: false
  },
  role: {
    type: DataTypes.ENUM('admin', 'accountant', 'brand_executive', 'developer'),
    defaultValue: 'accountant'
  }
}, {
  tableName: 'users',
  freezeTableName: true
});

const Brand = masterSequelize.define('Brand', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  description: {
    type: DataTypes.TEXT
  },
  image_url: {
    type: DataTypes.STRING
  },
  db_name: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false
  },
  // Google Drive folder for this brand's shared files (admin pastes the link;
  // stored as the parsed folder id). Feeds the dashboard "Sources to chat with".
  drive_folder_id: {
    type: DataTypes.STRING,
    allowNull: true
  }
}, {
  tableName: 'brands',
  freezeTableName: true
});

const Agent = masterSequelize.define('Agent', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  description: {
    type: DataTypes.TEXT
  },
  columns: {
    type: DataTypes.JSONB,
    defaultValue: []
  }
}, {
  tableName: 'agents',
  freezeTableName: true
});

// Many-to-Many: User <-> Brand
const BrandUser = masterSequelize.define('brand_users', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  brand_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: false
  }
}, {
  tableName: 'brand_users',
  freezeTableName: true
});

User.belongsToMany(Brand, { through: BrandUser, foreignKey: 'user_id', otherKey: 'brand_id' });
Brand.belongsToMany(User, { through: BrandUser, foreignKey: 'brand_id', otherKey: 'user_id' });

// Many-to-Many: Brand <-> Agent
const BrandAgent = masterSequelize.define('brand_agents', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  brand_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  agent_id: {
    type: DataTypes.UUID,
    allowNull: false
  }
}, {
  tableName: 'brand_agents',
  freezeTableName: true
});

Brand.belongsToMany(Agent, { through: BrandAgent, foreignKey: 'brand_id', otherKey: 'agent_id' });
Agent.belongsToMany(Brand, { through: BrandAgent, foreignKey: 'agent_id', otherKey: 'brand_id' });

// Agent workflows (multi-sheet output templates: filters, master-data lookup, column mapping)
const AgentWorkflow = masterSequelize.define('AgentWorkflow', {
  id:             { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  agent_id:       { type: DataTypes.UUID, allowNull: false },
  name:           { type: DataTypes.STRING, allowNull: false },
  description:    { type: DataTypes.TEXT },
  sample_columns: { type: DataTypes.JSONB, defaultValue: [] },
  columns:        { type: DataTypes.JSONB, defaultValue: [] },
  sheets:         { type: DataTypes.JSONB, defaultValue: [] }
}, {
  tableName: 'agent_workflows',
  freezeTableName: true
});

Agent.hasMany(AgentWorkflow, { foreignKey: 'agent_id', onDelete: 'CASCADE' });
AgentWorkflow.belongsTo(Agent, { foreignKey: 'agent_id' });

// Visual plan-builder canvases (n8n-style). graph = { nodes, edges }.
const Plan = masterSequelize.define('plans', {
  id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name:        { type: DataTypes.STRING, allowNull: false },
  description: { type: DataTypes.TEXT, allowNull: true },
  created_by:  { type: DataTypes.UUID, allowNull: false },
  shared_with: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] }, // array of user_ids
  graph:       { type: DataTypes.JSONB, allowNull: false, defaultValue: { nodes: [], edges: [] } },
}, {
  tableName: 'plans',
  freezeTableName: true,
  timestamps: true,
});

// Third-party connectors (Google, ClickUp, …). Visual connect only for now —
// `config` holds an optional API key / metadata; no live OAuth handshake yet.
const Integration = masterSequelize.define('integrations', {
  id:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name:         { type: DataTypes.STRING, allowNull: false },                 // display name, e.g. "Google Workspace"
  type:         { type: DataTypes.STRING, allowNull: false, unique: true },   // 'google' | 'clickup' | …
  status:       { type: DataTypes.ENUM('connected', 'disconnected'), allowNull: false, defaultValue: 'disconnected' },
  config:       { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },// { apiKey?, account?, … }
  connected_by: { type: DataTypes.UUID, allowNull: true },
}, {
  tableName: 'integrations',
  freezeTableName: true,
  timestamps: true,
});

/* ── Colonel AI chat (Round 3) ──────────────────────────────────────────────
   A conversation is STRICTLY private to its owner (user_id). The conversation
   controller scopes every query to `where user_id = req.user.id` — admins do
   NOT see other users' chats. Dhaval's history is invisible to Anshul and v.v. */
const Conversation = masterSequelize.define('conversations', {
  id:       { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  user_id:  { type: DataTypes.UUID, allowNull: false },                       // owner — privacy boundary
  title:    { type: DataTypes.STRING, allowNull: false, defaultValue: 'New chat' },
  model:    { type: DataTypes.STRING, allowNull: false, defaultValue: 'claude-sonnet-4-6' },
  messages: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },    // [{role, content}]
}, {
  tableName: 'conversations',
  freezeTableName: true,
  timestamps: true,
  indexes: [{ fields: ['user_id'] }],
});

/* MCP server registry — visual connect only (paste URL + name, store & list). */
const McpServer = masterSequelize.define('mcp_servers', {
  id:         { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name:       { type: DataTypes.STRING, allowNull: false },
  url:        { type: DataTypes.STRING, allowNull: false },
  status:     { type: DataTypes.ENUM('registered', 'disconnected'), allowNull: false, defaultValue: 'registered' },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, {
  tableName: 'mcp_servers',
  freezeTableName: true,
  timestamps: true,
});

module.exports = {
  User,
  Brand,
  Agent,
  BrandUser,
  BrandAgent,
  Plan,
  Integration,
  Conversation,
  McpServer,
  AgentWorkflow
};
