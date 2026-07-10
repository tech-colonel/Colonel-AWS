const { DataTypes, Sequelize } = require('sequelize');
const { UNIFIED } = require('../../config/database');

/**
 * Factory function to create the BrandAgent model on a specific brand connection
 * @param {Sequelize} sequelize - The brand-specific sequelize instance
 * @returns {Model} - The BrandAgent model
 */
const getBrandAgentModel = (sequelize) => {
  if (sequelize.models.brand_agents) {
    return sequelize.models.brand_agents;
  }

  return sequelize.define('brand_agents', {
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
    },
    sku_master: {
      type: DataTypes.JSONB,
      defaultValue: []
    },
    ledger_master: {
      type: DataTypes.JSONB,
      defaultValue: []
    }
  }, {
    tableName: 'brand_agents',
    timestamps: true
  });
};

/**
 * Factory function for dynamic agent-specific tables (e.g. amazon_sales_portal)
 */
const getDynamicModel = (sequelize, tableName, columns) => {
  if (sequelize.models[tableName]) {
    return sequelize.models[tableName];
  }

  const schema = {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    month: DataTypes.INTEGER,
    year: DataTypes.INTEGER,
    file_type: DataTypes.STRING,
    inventory_type: DataTypes.STRING,
    filename: DataTypes.STRING,
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  };

  // UNIFIED DB: every tenant row carries brand_id. Defined in the model (so
  // sync/alter never drops it) with a DB-side default that auto-stamps from the
  // request's brand context (set on the connection) — controllers don't pass it.
  if (UNIFIED) {
    schema.brand_id = {
      type: DataTypes.UUID,
      allowNull: false,
      defaultValue: Sequelize.literal("NULLIF(current_setting('app.brand_id', true), '')::uuid"),
    };
  }

  // Add custom columns if provided
  if (columns && Array.isArray(columns)) {
    columns.forEach(col => {
      if (col.name === 'id' || col.name === 'brand_id') return;

      schema[col.name] = {
        type: DataTypes[col.type?.toUpperCase()] || DataTypes.STRING
      };
    });
  }

  const model = sequelize.define(tableName, schema, {
    tableName: tableName.toLowerCase(),
    timestamps: false,
    indexes: [{ fields: ['filename'] }],
  });

  if (UNIFIED) {
    // Tables are pre-built + RLS-protected and owned by 'postgres' in the unified
    // DB. The app role (colonel_app) can't run DDL, and alter would drop brand_id.
    // Make sync a no-op — schema is managed by the db-restructure migrations.
    model.sync = async () => model;
  }

  return model;
};

module.exports = {
  getBrandAgentModel,
  getDynamicModel
};
