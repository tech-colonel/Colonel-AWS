const { DataTypes } = require('sequelize');

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

  // Add custom columns if provided
  if (columns && Array.isArray(columns)) {
    columns.forEach(col => {
      if (col.name === 'id') return;

      schema[col.name] = {
        type: DataTypes[col.type?.toUpperCase()] || DataTypes.STRING
      };
    });
  }

  return sequelize.define(tableName, schema, {
    tableName: tableName.toLowerCase(),
    timestamps: false
  });
};

module.exports = {
  getBrandAgentModel,
  getDynamicModel
};
